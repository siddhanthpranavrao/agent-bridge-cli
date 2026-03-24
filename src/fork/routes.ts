import type { IncomingMessage, ServerResponse } from "node:http";
import { AskRequestSchema, type AskResponse } from "./types.ts";
import type { ForkManager } from "./manager.ts";
import type { SessionManager } from "../sessions/manager.ts";
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

export async function handleAskRoute(
  req: IncomingMessage,
  res: ServerResponse,
  sessionManager: SessionManager,
  forkManager: ForkManager
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

    // Resolve target session
    const targetSession = sessionManager.resolve(
      parsed.targetSession,
      parsed.group
    );
    if (!targetSession) {
      return sendJson(res, 404, {
        error: `Session "${parsed.targetSession}" not found in group "${parsed.group}"`,
      });
    }

    // Check if session is alive
    if (!sessionManager.validateAlive(targetSession.sessionId)) {
      return sendJson(res, 404, {
        error: `Session "${targetSession.name}" is no longer alive`,
      });
    }

    // Fork and ask
    const result = await forkManager.forkAndAsk(
      targetSession.claudeSessionId,
      parsed.question
    );

    // Build response
    const response: AskResponse = {
      answer: `[via ${targetSession.name}] ${result.answer}`,
      source: targetSession.name,
      fromFork: true,
    };

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

    sendJson(res, 500, { error: "Internal server error" });
  }
}
