import type { IncomingMessage, ServerResponse } from "node:http";
import { INSUFFICIENT_CONTEXT, DEFAULT_MAX_FAN_OUT } from "../constants.ts";
import { AskRequestSchema, type AskResponse, type AskMultiResponse, type QueryGroup } from "./types.ts";
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

interface ResolvedTargets {
  sessions: Session[];
  warnings: string[];
}

function resolveTargets(
  names: string[],
  group: string,
  sessionManager: SessionManager,
  excludeSessionId?: string
): ResolvedTargets {
  const warnings: string[] = [];
  const seen = new Map<string, Session>();

  for (const name of names) {
    const session = sessionManager.resolve(name, group);
    if (!session) {
      warnings.push(`Target "${name}" could not be resolved in group "${group}"`);
      continue;
    }

    if (excludeSessionId && session.sessionId === excludeSessionId) {
      continue;
    }

    if (seen.has(session.sessionId)) {
      continue;
    }

    if (!sessionManager.validateAlive(session.sessionId)) {
      warnings.push(`Target "${name}" (session "${session.name}") is no longer alive`);
      continue;
    }

    seen.set(session.sessionId, session);
  }

  return { sessions: Array.from(seen.values()), warnings };
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
  // Generate summary if it doesn't exist or is stale (keyed by claudeSessionId for reuse across reconnects)
  if (!(await summaryEngine.hasFreshSummary(targetSession.claudeSessionId))) {
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
 * Two-phase parallel execution for multiple sessions.
 * Phase 1: Query all summaries in parallel (zero LLM cost for keyword matching).
 * Phase 2: Fork only the gaps in parallel with concurrency limit.
 * Phase 3: Enrich summaries in background for successful forks.
 */
async function executeMultiAsk(
  sessions: Session[],
  question: string,
  summaryEngine: SummaryEngine,
  forkManager: ForkManager,
): Promise<AskMultiResponse> {
  const answers: AskResponse[] = [];
  const warnings: string[] = [];

  // Phase 1: Query all summaries in parallel
  const summaryResults = await Promise.allSettled(
    sessions.map(async (session) => {
      if (!(await summaryEngine.hasFreshSummary(session.claudeSessionId))) {
        await summaryEngine.generate(
          session.claudeSessionId,
          session.claudeSessionId,
          session.workingDirectory
        );
      }
      return summaryEngine.query(session.claudeSessionId, question);
    })
  );

  const needsFork: Session[] = [];
  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i]!;
    const result = summaryResults[i]!;

    if (result.status === "rejected") {
      needsFork.push(session);
      continue;
    }

    if (result.value !== INSUFFICIENT_CONTEXT) {
      answers.push({
        answer: `[via ${session.name}] ${result.value}`,
        source: session.name,
        fromFork: false,
      });
    } else {
      needsFork.push(session);
    }
  }

  // Phase 2: Fork only the gaps, in parallel with concurrency limit
  if (needsFork.length > 0) {
    const forkResults = await forkManager.forkAndAskBatch(
      needsFork.map(s => ({
        claudeSessionId: s.claudeSessionId,
        question,
        cwd: s.workingDirectory,
      }))
    );

    for (const session of needsFork) {
      const result = forkResults.get(session.claudeSessionId);
      if (!result) {
        warnings.push(`Session "${session.name}" fork failed`);
        continue;
      }

      if (result.answer.includes(INSUFFICIENT_CONTEXT)) {
        answers.push({
          answer: `[via ${session.name}] Unable to answer this question. The session does not have enough context about this topic.`,
          source: session.name,
          fromFork: true,
        });
      } else {
        answers.push({
          answer: `[via ${session.name}] ${result.answer}`,
          source: session.name,
          fromFork: true,
        });
        // Phase 3: Enrich summary in background
        summaryEngine.enrich(session.claudeSessionId, question, result.answer).catch(() => {});
      }
    }
  }

  return { answers, warnings };
}

/**
 * Per-session targeted questions. Flattens query groups into per-session
 * question lists, checks summaries per-question, batches unanswered questions
 * into a single fork per session.
 */
async function executeQueries(
  queries: QueryGroup[],
  group: string,
  sessionManager: SessionManager,
  summaryEngine: SummaryEngine,
  forkManager: ForkManager,
  sourceSession?: string,
  maxFanOut: number = DEFAULT_MAX_FAN_OUT,
): Promise<{ response: AskMultiResponse; status: number }> {
  const allWarnings: string[] = [];

  // Step 1: Resolve targets per query group, build per-session question map
  const sessionQuestions = new Map<string, { session: Session; questions: string[] }>();

  for (const queryGroup of queries) {
    const { sessions, warnings } = resolveTargets(queryGroup.targets, group, sessionManager, sourceSession);
    allWarnings.push(...warnings);

    for (const session of sessions) {
      const existing = sessionQuestions.get(session.sessionId);
      if (existing) {
        if (!existing.questions.includes(queryGroup.question)) {
          existing.questions.push(queryGroup.question);
        }
      } else {
        sessionQuestions.set(session.sessionId, {
          session,
          questions: [queryGroup.question],
        });
      }
    }
  }

  // Step 2: Check limits
  if (sessionQuestions.size > maxFanOut) {
    return {
      response: {
        answers: [],
        warnings: [`Resolved ${sessionQuestions.size} unique sessions but max fan-out is ${maxFanOut}. Reduce targets or increase limit.`],
      },
      status: 400,
    };
  }

  if (sessionQuestions.size === 0) {
    return {
      response: { answers: [], warnings: allWarnings },
      status: 404,
    };
  }

  const answers: AskResponse[] = [];
  const needsFork = new Map<string, { session: Session; unansweredQuestions: string[] }>();

  // Step 3 (Phase 1): Check summaries per-question per-session in parallel
  await Promise.allSettled(
    Array.from(sessionQuestions.entries()).map(async ([_sessionId, { session, questions }]) => {
      try {
        if (!(await summaryEngine.hasFreshSummary(session.claudeSessionId))) {
          await summaryEngine.generate(session.claudeSessionId, session.claudeSessionId, session.workingDirectory);
        }

        const unanswered: string[] = [];
        for (const question of questions) {
          try {
            const answer = await summaryEngine.query(session.claudeSessionId, question);
            if (answer !== INSUFFICIENT_CONTEXT) {
              answers.push({
                answer: `[via ${session.name}] ${answer}`,
                source: session.name,
                fromFork: false,
              });
            } else {
              unanswered.push(question);
            }
          } catch {
            unanswered.push(question);
          }
        }

        if (unanswered.length > 0) {
          needsFork.set(session.sessionId, { session, unansweredQuestions: unanswered });
        }
      } catch {
        needsFork.set(session.sessionId, { session, unansweredQuestions: questions });
      }
    })
  );

  // Step 4 (Phase 2): Fork sessions with unanswered questions, batching per session
  if (needsFork.size > 0) {
    const forkRequests = Array.from(needsFork.values()).map(({ session, unansweredQuestions }) => {
      const batchedQuestion = unansweredQuestions.length === 1
        ? unansweredQuestions[0]!
        : `Answer these questions separately, labeling each answer:\n${unansweredQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`;

      return {
        claudeSessionId: session.claudeSessionId,
        question: batchedQuestion,
        cwd: session.workingDirectory,
      };
    });

    const forkResults = await forkManager.forkAndAskBatch(forkRequests);

    for (const [_sessionId, { session, unansweredQuestions }] of needsFork) {
      const result = forkResults.get(session.claudeSessionId);
      if (!result) {
        allWarnings.push(`Session "${session.name}" fork failed`);
        continue;
      }

      if (result.answer.includes(INSUFFICIENT_CONTEXT)) {
        answers.push({
          answer: `[via ${session.name}] Unable to answer this question. The session does not have enough context about this topic.`,
          source: session.name,
          fromFork: true,
        });
      } else {
        answers.push({
          answer: `[via ${session.name}] ${result.answer}`,
          source: session.name,
          fromFork: true,
        });
        // Enrich per-question (issue #17 will improve parsing)
        for (const q of unansweredQuestions) {
          summaryEngine.enrich(session.claudeSessionId, q, result.answer).catch(() => {});
        }
      }
    }
  }

  if (answers.length === 0) {
    return { response: { answers, warnings: allWarnings }, status: 404 };
  }

  const hasFailures = allWarnings.length > 0;
  return { response: { answers, warnings: allWarnings }, status: hasFailures ? 207 : 200 };
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
    if (!(await summaryEngine.hasFreshSummary(session.claudeSessionId))) {
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

async function askMultiple(
  targets: string[],
  group: string,
  question: string,
  sessionManager: SessionManager,
  summaryEngine: SummaryEngine,
  forkManager: ForkManager,
  sourceSession?: string,
  maxFanOut: number = DEFAULT_MAX_FAN_OUT
): Promise<{ response: AskMultiResponse; status: number }> {
  const { sessions, warnings } = resolveTargets(targets, group, sessionManager, sourceSession);

  if (sessions.length > maxFanOut) {
    return {
      response: {
        answers: [],
        warnings: [
          `Resolved ${sessions.length} sessions but max fan-out is ${maxFanOut}. Reduce targets or increase limit.`,
        ],
      },
      status: 400,
    };
  }

  if (sessions.length === 0) {
    return {
      response: { answers: [], warnings },
      status: 404,
    };
  }

  const result = await executeMultiAsk(sessions, question, summaryEngine, forkManager);
  result.warnings = [...warnings, ...result.warnings];

  if (result.answers.length === 0) {
    return { response: result, status: 404 };
  }

  const hasFailures = result.warnings.length > 0;
  return { response: result, status: hasFailures ? 207 : 200 };
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

    // Path E: Queries mode — per-session targeted questions
    if (parsed.queries) {
      const { response, status } = await executeQueries(
        parsed.queries,
        parsed.group,
        sessionManager,
        summaryEngine,
        forkManager,
        parsed.sourceSession
      );

      if (status === 400) {
        return sendJson(res, 400, {
          error: response.warnings[0] ?? "Query limit exceeded",
          warnings: response.warnings,
        });
      }

      if (status === 404) {
        return sendJson(res, 404, {
          error: "No valid sessions could be queried",
          warnings: response.warnings,
        });
      }

      return sendJson(res, status, response);
    }

    // Path D: Broadcast — query all sessions in the group
    if (parsed.broadcast === true) {
      const allSessions = sessionManager.listByGroup(parsed.group);
      const aliveSessions = allSessions.filter(s => {
        if (parsed.sourceSession && s.sessionId === parsed.sourceSession) return false;
        return sessionManager.validateAlive(s.sessionId);
      });

      if (aliveSessions.length === 0) {
        return sendJson(res, 404, {
          error: `No active sessions in group "${parsed.group}" (excluding self)`,
        });
      }

      if (aliveSessions.length > DEFAULT_MAX_FAN_OUT) {
        return sendJson(res, 400, {
          error: `Group "${parsed.group}" has ${aliveSessions.length} sessions but max fan-out is ${DEFAULT_MAX_FAN_OUT}. Use targets for specific sessions.`,
        });
      }

      const broadcastResult = await executeMultiAsk(
        aliveSessions,
        parsed.question!,
        summaryEngine,
        forkManager
      );

      if (broadcastResult.answers.length === 0) {
        return sendJson(res, 404, {
          error: "No session in the group could answer",
          ...broadcastResult,
        });
      }

      const broadcastStatus = broadcastResult.warnings.length > 0 ? 207 : 200;
      return sendJson(res, broadcastStatus, broadcastResult);
    }

    // Path C: Multi-target fan-out
    if (parsed.targets) {
      const { response, status } = await askMultiple(
        parsed.targets,
        parsed.group,
        parsed.question!,
        sessionManager,
        summaryEngine,
        forkManager,
        parsed.sourceSession
      );

      if (status === 400) {
        return sendJson(res, 400, {
          error: response.warnings[0] ?? "Fan-out limit exceeded",
          warnings: response.warnings,
        });
      }

      if (status === 404) {
        return sendJson(res, 404, {
          error: "No valid sessions could be queried",
          warnings: response.warnings,
        });
      }

      return sendJson(res, status, response);
    }

    // Path B: Auto-routing (no targeting specified)
    if (!parsed.targetSession) {
      const { response, status } = await autoRoute(
        parsed.group,
        parsed.question!,
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
      parsed.question!,
      summaryEngine,
      forkManager
    );
    return sendJson(res, 200, response);
  } catch (err) {
    if (err instanceof ZodError) {
      return sendJson(res, 400, {
        error: "Validation failed",
        details: err.issues.map((e) => ({
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
