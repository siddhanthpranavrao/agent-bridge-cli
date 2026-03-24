import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Storage } from "../../src/storage/storage.ts";
import { BrokerServer } from "../../src/broker/server.ts";

let testDir: string;
let storage: Storage;
let broker: BrokerServer;
let baseUrl: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "agent-bridge-routes-test-"));
  storage = new Storage({ baseDir: testDir });
  broker = new BrokerServer(storage);
  await broker.start();
  baseUrl = `http://127.0.0.1:${broker.getPort()}`;
});

afterEach(async () => {
  try {
    await broker.stop();
  } catch {
    // Already stopped
  }
  await rm(testDir, { recursive: true, force: true });
});

function post(path: string, body: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(path: string) {
  return fetch(`${baseUrl}${path}`);
}

describe("POST /sessions/register", () => {
  test("registers a session and returns 201", async () => {
    const res = await post("/sessions/register", {
      sessionId: "s1",
      claudeSessionId: "claude-uuid-s1",
      pid: process.pid,
      workingDirectory: "/projects/frontend",
      group: "acme",
    });

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.session.sessionId).toBe("s1");
    expect(body.session.group).toBe("acme");
    expect(body.session.name).toBe("frontend");
  });

  test("uses default group when not specified", async () => {
    const res = await post("/sessions/register", {
      sessionId: "s1",
      claudeSessionId: "claude-uuid-s1",
      pid: process.pid,
      workingDirectory: "/projects/frontend",
    });

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.session.group).toBe("default");
  });

  test("returns 400 for missing required fields", async () => {
    const res = await post("/sessions/register", {
      sessionId: "s1",
      // missing pid and workingDirectory
    });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBe("Validation failed");
    expect(body.details).toBeDefined();
  });

  test("returns 400 for invalid JSON", async () => {
    const res = await fetch(`${baseUrl}/sessions/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBe("Invalid JSON body");
  });

  test("returns 400 for invalid PID", async () => {
    const res = await post("/sessions/register", {
      sessionId: "s1",
      pid: -1,
      workingDirectory: "/projects/frontend",
    });

    expect(res.status).toBe(400);
  });

  test("returns 409 for duplicate sessionId", async () => {
    await post("/sessions/register", {
      sessionId: "s1",
      claudeSessionId: "claude-uuid-s1",
      pid: process.pid,
      workingDirectory: "/projects/frontend",
    });

    const res = await post("/sessions/register", {
      sessionId: "s1",
      claudeSessionId: "claude-uuid-s1",
      pid: process.pid,
      workingDirectory: "/projects/backend",
    });

    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error).toContain("already registered");
  });

  test("returns 405 for GET method", async () => {
    const res = await get("/sessions/register");
    expect(res.status).toBe(405);
  });
});

describe("POST /sessions/deregister", () => {
  test("deregisters existing session", async () => {
    await post("/sessions/register", {
      sessionId: "s1",
      claudeSessionId: "claude-uuid-s1",
      pid: process.pid,
      workingDirectory: "/projects/frontend",
    });

    const res = await post("/sessions/deregister", { sessionId: "s1" });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
  });

  test("returns success false for non-existent session", async () => {
    const res = await post("/sessions/deregister", { sessionId: "nonexistent" });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(false);
  });

  test("returns 400 for empty body", async () => {
    const res = await fetch(`${baseUrl}/sessions/deregister`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    // sessionId is required and missing — Zod fails
    expect(res.status).toBe(400);
  });

  test("returns 405 for GET method", async () => {
    const res = await get("/sessions/deregister");
    expect(res.status).toBe(405);
  });
});

describe("GET /sessions?group=<name>", () => {
  test("lists sessions in a group", async () => {
    await post("/sessions/register", {
      sessionId: "s1",
      claudeSessionId: "claude-uuid-s1",
      pid: process.pid,
      workingDirectory: "/projects/frontend",
      group: "acme",
    });
    await post("/sessions/register", {
      sessionId: "s2",
      claudeSessionId: "claude-uuid-s2",
      pid: process.pid,
      workingDirectory: "/projects/backend",
      group: "acme",
    });

    const res = await get("/sessions?group=acme");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.sessions.length).toBe(2);
  });

  test("returns empty array for non-existent group", async () => {
    const res = await get("/sessions?group=nonexistent");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.sessions).toEqual([]);
  });

  test("returns 400 when group parameter is missing", async () => {
    const res = await get("/sessions");
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain("group");
  });

  test("returns 405 for POST method", async () => {
    const res = await post("/sessions", {});
    expect(res.status).toBe(405);
  });

  test("groups are isolated", async () => {
    await post("/sessions/register", {
      sessionId: "s1",
      claudeSessionId: "claude-uuid-s1",
      pid: process.pid,
      workingDirectory: "/projects/frontend",
      group: "acme",
    });
    await post("/sessions/register", {
      sessionId: "s2",
      claudeSessionId: "claude-uuid-s2",
      pid: process.pid,
      workingDirectory: "/projects/side",
      group: "personal",
    });

    const acmeRes = await get("/sessions?group=acme");
    const acmeBody = await acmeRes.json() as any;
    expect(acmeBody.sessions.length).toBe(1);
    expect(acmeBody.sessions[0].sessionId).toBe("s1");

    const personalRes = await get("/sessions?group=personal");
    const personalBody = await personalRes.json() as any;
    expect(personalBody.sessions.length).toBe(1);
    expect(personalBody.sessions[0].sessionId).toBe("s2");
  });
});

describe("GET /sessions/groups", () => {
  test("lists all groups", async () => {
    await post("/sessions/register", {
      sessionId: "s1",
      claudeSessionId: "claude-uuid-s1",
      pid: process.pid,
      workingDirectory: "/projects/frontend",
      group: "acme",
    });
    await post("/sessions/register", {
      sessionId: "s2",
      claudeSessionId: "claude-uuid-s2",
      pid: process.pid,
      workingDirectory: "/projects/side",
      group: "personal",
    });

    const res = await get("/sessions/groups");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.groups).toContain("acme");
    expect(body.groups).toContain("personal");
  });

  test("returns empty list when no sessions", async () => {
    const res = await get("/sessions/groups");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.groups).toEqual([]);
  });
});

describe("GET /sessions/resolve", () => {
  beforeEach(async () => {
    await post("/sessions/register", {
      sessionId: "s1",
      claudeSessionId: "claude-uuid-s1",
      pid: process.pid,
      workingDirectory: "/projects/frontend",
      group: "acme",
      name: "frontend",
    });
    await post("/sessions/register", {
      sessionId: "s2",
      claudeSessionId: "claude-uuid-s2",
      pid: process.pid,
      workingDirectory: "/projects/backend",
      group: "acme",
      name: "backend",
    });
  });

  test("resolves exact name match", async () => {
    const res = await get("/sessions/resolve?q=backend&group=acme");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.session.sessionId).toBe("s2");
  });

  test("resolves fuzzy name match", async () => {
    const res = await get("/sessions/resolve?q=bakend&group=acme");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.session.sessionId).toBe("s2");
  });

  test("returns null for no match", async () => {
    const res = await get("/sessions/resolve?q=zzzzzzz&group=acme");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.session).toBeNull();
  });

  test("returns 400 when query params are missing", async () => {
    const res = await get("/sessions/resolve");
    expect(res.status).toBe(400);
  });

  test("returns 400 when group is missing", async () => {
    const res = await get("/sessions/resolve?q=backend");
    expect(res.status).toBe(400);
  });
});

describe("Broker /health with sessions", () => {
  test("health endpoint includes session count", async () => {
    await post("/sessions/register", {
      sessionId: "s1",
      claudeSessionId: "claude-uuid-s1",
      pid: process.pid,
      workingDirectory: "/projects/frontend",
    });

    const res = await get("/health");
    const body = await res.json() as any;
    expect(body.sessions).toBe(1);
  });
});

describe("Unknown session routes", () => {
  test("returns 404 for unknown /sessions/* path", async () => {
    const res = await get("/sessions/unknown");
    expect(res.status).toBe(404);
  });
});
