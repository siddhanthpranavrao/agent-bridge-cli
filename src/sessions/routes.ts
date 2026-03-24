import type { IncomingMessage, ServerResponse } from "node:http";
import { RegisterRequestSchema, DeregisterRequestSchema } from "./types.ts";
import type { SessionManager } from "./manager.ts";
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

export async function handleSessionRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  manager: SessionManager
): Promise<void> {
  const path = url.pathname;

  try {
    // POST /sessions/register
    if (path === "/sessions/register") {
      if (req.method !== "POST") {
        return sendJson(res, 405, { error: "Method not allowed" });
      }

      const body = parseJsonBody(await readBody(req));
      if (body === null) {
        return sendJson(res, 400, { error: "Invalid JSON body" });
      }

      const parsed = RegisterRequestSchema.parse(body);
      const session = await manager.register(parsed);
      return sendJson(res, 201, { session });
    }

    // POST /sessions/deregister
    if (path === "/sessions/deregister") {
      if (req.method !== "POST") {
        return sendJson(res, 405, { error: "Method not allowed" });
      }

      const body = parseJsonBody(await readBody(req));
      if (body === null) {
        return sendJson(res, 400, { error: "Invalid JSON body" });
      }

      const parsed = DeregisterRequestSchema.parse(body);
      const success = await manager.deregister(parsed.sessionId);
      return sendJson(res, 200, { success });
    }

    // GET /sessions/groups
    if (path === "/sessions/groups") {
      if (req.method !== "GET") {
        return sendJson(res, 405, { error: "Method not allowed" });
      }

      const groups = manager.listAllGroups();
      return sendJson(res, 200, { groups });
    }

    // GET /sessions/resolve?q=<query>&group=<group>
    if (path === "/sessions/resolve") {
      if (req.method !== "GET") {
        return sendJson(res, 405, { error: "Method not allowed" });
      }

      const query = url.searchParams.get("q");
      const group = url.searchParams.get("group");

      if (!query || !group) {
        return sendJson(res, 400, { error: "Missing required query parameters: q, group" });
      }

      const session = manager.resolve(query, group);
      return sendJson(res, 200, { session });
    }

    // GET /sessions?group=<group>
    if (path === "/sessions") {
      if (req.method !== "GET") {
        return sendJson(res, 405, { error: "Method not allowed" });
      }

      const group = url.searchParams.get("group");
      if (!group) {
        return sendJson(res, 400, { error: "Missing required query parameter: group" });
      }

      const sessions = manager.listByGroup(group);
      return sendJson(res, 200, { sessions });
    }

    // Unknown /sessions/* path
    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    if (err instanceof ZodError) {
      return sendJson(res, 400, {
        error: "Validation failed",
        details: err.errors.map((e) => ({ path: e.path.join("."), message: e.message })),
      });
    }

    if (err instanceof Error && err.message.includes("already registered")) {
      return sendJson(res, 409, { error: err.message });
    }

    sendJson(res, 500, { error: "Internal server error" });
  }
}
