import type { IncomingMessage, ServerResponse } from "node:http";
import { INSUFFICIENT_CONTEXT } from "../constants.ts";
import { AskRequestSchema, type AskResponse } from "./types.ts";
import type { ForkManager } from "./manager.ts";
import type { SessionManager } from "../sessions/manager.ts";
import type { SummaryEngine } from "../summary/engine.ts";
import type { Session } from "../sessions/types.ts";
import { ZodError } from "zod";

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function parseJsonBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/**
 * Ask a specific session and return the response.
 * Handles summary query → fork fallback → enrichment.
 */
async function askSession(
  targetSession: Session,
  question: string,
  summaryEngine: SummaryEngine,
  forkManager: ForkManager,
  hint?: string
): Promise<AskResponse> {
  // Generate summary if it doesn't exist (keyed by claudeSessionId for reuse across reconnects)
  if (!(await summaryEngine.hasSummary(targetSession.claudeSessionId))) {
    await summaryEngine.generate(
      targetSession.claudeSessionId,
      targetSession.claudeSessionId,
      targetSession.workingDirectory
    );
  }

  // Try to answer from summary
  const summaryAnswer = await summaryEngine.query(
    targetSession.claudeSessionId,
    question
  );

  if (summaryAnswer !== INSUFFICIENT_CONTEXT) {
    const suffix = hint ? ` ${hint}` : "";
    return {
      answer: `[via ${targetSession.name}] ${summaryAnswer}${suffix}`,
      source: targetSession.name,
      fromFork: false,
    };
  }

  // Fork and ask (summary couldn't answer)
  const result = await forkManager.forkAndAsk(
    targetSession.claudeSessionId,
    question,
    targetSession.workingDirectory
  );

  // Check if fork also couldn't answer
  if (result.answer.includes(INSUFFICIENT_CONTEXT)) {
    return {
      answer: `[via ${targetSession.name}] Unable to answer this question. The session does not have enough context about this topic.`,
      source: targetSession.name,
      fromFork: true,
    };
  }

  // Enrich summary in background
  summaryEngine
    .enrich(targetSession.claudeSessionId, question, result.answer)
    .catch(() => {});

  const suffix = hint ? ` ${hint}` : "";
  return {
    answer: `[via ${targetSession.name}] ${result.answer}${suffix}`,
    source: targetSession.name,
    fromFork: true,
  };
}

/**
 * Auto-route: find the best session to answer the question.
 */
async function autoRoute(
  group: string,
  question: string,
  sessionManager: SessionManager,
  summaryEngine: SummaryEngine,
  forkManager: ForkManager
): Promise<{ response: AskResponse; status: number }> {
  const sessions = sessionManager.listByGroup(group);
  const aliveSessions = sessions.filter((s) =>
    sessionManager.validateAlive(s.sessionId)
  );

  if (aliveSessions.length === 0) {
    return {
      response: { answer: "", source: "", fromFork: false },
      status: 404,
    };
  }

  // Rank sessions by summary relevance (keyword-based, zero LLM cost)
  const ranked = await summaryEngine.rankSessions(
    aliveSessions.map((s) => s.sessionId),
    question
  );

  const hint = "(Tip: use '/bridge ask <name>' for direct targeting)";

  if (ranked.length > 0) {
    const bestSession = aliveSessions.find(
      (s) => s.sessionId === ranked[0]!.sessionId
    )!;
    const response = await askSession(
      bestSession,
      question,
      summaryEngine,
      forkManager,
      hint
    );
    return { response, status: 200 };
  }

  // Broadcasting fallback: try each session's summary
  for (const session of aliveSessions) {
    if (!(await summaryEngine.hasSummary(session.claudeSessionId))) {
      await summaryEngine.generate(session.claudeSessionId, session.claudeSessionId, session.workingDirectory);
    }

    const answer = await summaryEngine.query(session.claudeSessionId, question);
    if (answer !== INSUFFICIENT_CONTEXT) {
      return {
        response: {
          answer: `[via ${session.name}] ${answer} ${hint}`,
          source: session.name,
          fromFork: false,
        },
        status: 200,
      };
    }
  }

  // No session could answer
  return {
    response: {
      answer: `No session in group "${group}" has relevant context for this question.`,
      source: "",
      fromFork: false,
    },
    status: 404,
  };
}

export async function handleAskRoute(
  req: IncomingMessage,
  res: ServerResponse,
  sessionManager: SessionManager,
  forkManager: ForkManager,
  summaryEngine: SummaryEngine
): Promise<void> {
  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  try {
    const body = parseJsonBody(await readBody(req));
    if (body === null) {
      return sendJson(res, 400, { error: "Invalid JSON body" });
    }

    const parsed = AskRequestSchema.parse(body);

    // Path B: Auto-routing (no targetSession specified)
    if (!parsed.targetSession) {
      const { response, status } = await autoRoute(
        parsed.group,
        parsed.question,
        sessionManager,
        summaryEngine,
        forkManager
      );

      if (status === 404) {
        return sendJson(res, 404, {
          error: response.answer || `No active sessions in group "${parsed.group}"`,
        });
      }

      return sendJson(res, 200, response);
    }

    // Path A: Targeted ask (existing behavior)
    const targetSession = sessionManager.resolve(
      parsed.targetSession,
      parsed.group
    );
    if (!targetSession) {
      return sendJson(res, 404, {
        error: `Session "${parsed.targetSession}" not found in group "${parsed.group}"`,
      });
    }

    if (!sessionManager.validateAlive(targetSession.sessionId)) {
      return sendJson(res, 404, {
        error: `Session "${targetSession.name}" is no longer alive`,
      });
    }

    const response = await askSession(
      targetSession,
      parsed.question,
      summaryEngine,
      forkManager
    );
    return sendJson(res, 200, response);
  } catch (err) {
    if (err instanceof ZodError) {
      return sendJson(res, 400, {
        error: "Validation failed",
        details: err.errors.map((e) => ({
          path: e.path.join("."),
          message: e.message,
        })),
      });
    }

    if (err instanceof Error) {
      if (err.name === "AbortError" || err.message.includes("aborted")) {
        return sendJson(res, 408, { error: "Fork timed out" });
      }
    }

    console.error("[bridge] Ask route error:", err instanceof Error ? err.message : err);
    if (err instanceof Error && err.stack) {
      console.error("[bridge] Stack:", err.stack);
    }
    sendJson(res, 500, { error: "Internal server error" });
  }
}
