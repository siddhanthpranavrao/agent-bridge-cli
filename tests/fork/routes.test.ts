import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { INSUFFICIENT_CONTEXT } from "../../src/constants.ts";
import { Storage } from "../../src/storage/storage.ts";
import { BrokerServer } from "../../src/broker/server.ts";
import type { ForkResult, ForkConfig } from "../../src/fork/types.ts";
import type { SummaryEntry } from "../../src/summary/types.ts";

let testDir: string;
let storage: Storage;
let broker: BrokerServer;
let baseUrl: string;

const mockForker = async (
  _sessionId: string,
  _question: string,
  _config: ForkConfig
): Promise<ForkResult> => ({
  answer: "The /users POST endpoint expects { email: string, password: string }",
  forkSessionId: "fork-test-123",
  durationMs: 150,
});

// Summary mocks: generate returns empty (so summary query returns INSUFFICIENT_CONTEXT),
// which forces fallback to fork — preserving existing fork test behavior
const mockSummaryGenerate = async (): Promise<SummaryEntry[]> => [];
const mockSummaryQuery = async (): Promise<string> => INSUFFICIENT_CONTEXT;
const mockSummaryEnrich = async (_q: string, _a: string): Promise<SummaryEntry> => ({
  topic: "mock",
  content: "mock",
  addedAt: Date.now(),
});

const mockDeps = {
  forker: mockForker,
  summaryGenerate: mockSummaryGenerate,
  summaryQuery: mockSummaryQuery,
  summaryEnrich: mockSummaryEnrich,
};

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "agent-bridge-fork-routes-test-"));
  storage = new Storage({ baseDir: testDir });
  broker = new BrokerServer(storage, undefined, mockDeps);
  await broker.start();
  baseUrl = `http://127.0.0.1:${broker.getPort()}`;

  // Register two sessions for testing
  await post("/sessions/register", {
    sessionId: "s1",
    claudeSessionId: "claude-uuid-frontend",
    pid: process.pid,
    workingDirectory: "/projects/frontend",
    group: "acme",
    name: "frontend",
  });
  await post("/sessions/register", {
    sessionId: "s2",
    claudeSessionId: "claude-uuid-backend",
    pid: process.pid,
    workingDirectory: "/projects/backend",
    group: "acme",
    name: "backend",
  });
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

describe("POST /ask - happy path", () => {
  test("returns answer from target session", async () => {
    const res = await post("/ask", {
      targetSession: "backend",
      question: "What does the /users endpoint expect?",
      group: "acme",
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.answer).toContain("[via backend]");
    expect(body.answer).toContain("/users POST endpoint");
    expect(body.source).toBe("backend");
    expect(body.fromFork).toBe(true);
  });

  test("resolves target by session ID", async () => {
    const res = await post("/ask", {
      targetSession: "s2",
      question: "test question",
      group: "acme",
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.source).toBe("backend");
  });

  test("resolves target by fuzzy name", async () => {
    const res = await post("/ask", {
      targetSession: "bakend",
      question: "test question",
      group: "acme",
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.source).toBe("backend");
  });

  test("includes [via <session>] prefix in answer", async () => {
    const res = await post("/ask", {
      targetSession: "frontend",
      question: "test question",
      group: "acme",
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.answer).toMatch(/^\[via frontend\]/);
  });
});

describe("POST /ask - error cases", () => {
  test("returns 404 for non-existent target session", async () => {
    const res = await post("/ask", {
      targetSession: "nonexistent",
      question: "test question",
      group: "acme",
    });

    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error).toContain("not found");
  });

  test("returns 404 for wrong group", async () => {
    const res = await post("/ask", {
      targetSession: "backend",
      question: "test question",
      group: "wrong-group",
    });

    expect(res.status).toBe(404);
  });

  test("returns 400 for missing required fields", async () => {
    const res = await post("/ask", {
      targetSession: "backend",
      // missing question and group
    });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBe("Validation failed");
  });

  test("returns 400 for empty question", async () => {
    const res = await post("/ask", {
      targetSession: "backend",
      question: "",
      group: "acme",
    });

    expect(res.status).toBe(400);
  });

  test("returns 400 for invalid JSON", async () => {
    const res = await fetch(`${baseUrl}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBe("Invalid JSON body");
  });

  test("returns 405 for GET method", async () => {
    const res = await get("/ask");
    expect(res.status).toBe(405);
  });
});

describe("POST /ask - fork errors", () => {
  test("returns 408 on timeout", async () => {
    const timeoutForker = async (): Promise<ForkResult> => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    };

    const timeoutBroker = new BrokerServer(storage, undefined, { ...mockDeps, forker: timeoutForker });
    await timeoutBroker.start();
    const timeoutUrl = `http://127.0.0.1:${timeoutBroker.getPort()}`;

    // Register a session on this broker
    await fetch(`${timeoutUrl}/sessions/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "s1",
        claudeSessionId: "claude-uuid-s1",
        pid: process.pid,
        workingDirectory: "/projects/backend",
        group: "acme",
        name: "backend",
      }),
    });

    const res = await fetch(`${timeoutUrl}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetSession: "backend",
        question: "test",
        group: "acme",
      }),
    });

    expect(res.status).toBe(408);
    const body = await res.json() as any;
    expect(body.error).toContain("timed out");

    await timeoutBroker.stop();
  });

  test("returns 500 on fork failure", async () => {
    const failForker = async (): Promise<ForkResult> => {
      throw new Error("Fork process crashed");
    };

    const failBroker = new BrokerServer(storage, undefined, { ...mockDeps, forker: failForker });
    await failBroker.start();
    const failUrl = `http://127.0.0.1:${failBroker.getPort()}`;

    await fetch(`${failUrl}/sessions/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "s1",
        claudeSessionId: "claude-uuid-s1",
        pid: process.pid,
        workingDirectory: "/projects/backend",
        group: "acme",
        name: "backend",
      }),
    });

    const res = await fetch(`${failUrl}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetSession: "backend",
        question: "test",
        group: "acme",
      }),
    });

    expect(res.status).toBe(500);

    await failBroker.stop();
  });
});

describe("POST /ask - dead session", () => {
  test("returns 404 when target session PID is dead", async () => {
    // Register a session with a dead PID
    await post("/sessions/register", {
      sessionId: "dead-session",
      claudeSessionId: "claude-uuid-dead",
      pid: 99999999,
      workingDirectory: "/projects/dead",
      group: "acme",
      name: "dead-service",
    });

    const res = await post("/ask", {
      targetSession: "dead-service",
      question: "test question",
      group: "acme",
    });

    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error).toContain("no longer alive");
  });
});
