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

describe("POST /ask - auto-routing (no targetSession)", () => {
  test("routes to correct session based on summary", async () => {
    // The default mockSummaryGenerate returns empty entries,
    // so we need a broker with summaries that have content.
    const backendEntries: SummaryEntry[] = [
      { topic: "/users endpoint", content: "POST /users expects { email, password }", addedAt: Date.now() },
      { topic: "authentication", content: "JWT auth at POST /auth/login", addedAt: Date.now() },
    ];
    const frontendEntries: SummaryEntry[] = [
      { topic: "React components", content: "UserProfile component in src/components", addedAt: Date.now() },
    ];

    let generateCallSession = "";
    const routingDeps = {
      ...mockDeps,
      summaryGenerate: async (claudeSessionId: string): Promise<SummaryEntry[]> => {
        generateCallSession = claudeSessionId;
        if (claudeSessionId === "claude-uuid-backend") return backendEntries;
        if (claudeSessionId === "claude-uuid-frontend") return frontendEntries;
        return [];
      },
      summaryQuery: async (entries: SummaryEntry[], _question: string): Promise<string> => {
        if (entries.length > 0) return entries[0]!.content;
        return INSUFFICIENT_CONTEXT;
      },
    };

    const routingBroker = new BrokerServer(storage, undefined, routingDeps);
    await routingBroker.start();
    const routingUrl = `http://127.0.0.1:${routingBroker.getPort()}`;

    // Register two sessions
    await fetch(`${routingUrl}/sessions/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "s1", claudeSessionId: "claude-uuid-backend",
        pid: process.pid, workingDirectory: "/projects/backend", group: "acme", name: "backend",
      }),
    });
    await fetch(`${routingUrl}/sessions/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "s2", claudeSessionId: "claude-uuid-frontend",
        pid: process.pid, workingDirectory: "/projects/frontend", group: "acme", name: "frontend",
      }),
    });

    // First, generate summaries by asking targeted questions
    await fetch(`${routingUrl}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetSession: "backend", question: "init", group: "acme" }),
    });
    await fetch(`${routingUrl}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetSession: "frontend", question: "init", group: "acme" }),
    });

    // Now auto-route: question about "users" should go to backend
    const res = await fetch(`${routingUrl}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: "What does the users endpoint expect?",
        group: "acme",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.source).toBe("backend");
    expect(body.answer).toContain("[via backend]");
    expect(body.answer).toContain("Tip:");

    await routingBroker.stop();
  });

  test("returns 404 when no sessions in group", async () => {
    const res = await post("/ask", {
      question: "test question",
      group: "empty-group",
    });

    expect(res.status).toBe(404);
  });

  test("returns 404 when no session can answer", async () => {
    // Default mocks return INSUFFICIENT_CONTEXT for everything
    const res = await post("/ask", {
      question: "What is the meaning of life?",
      group: "acme",
    });

    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error).toContain("No session in group");
  });

  test("targeted ask still works with targetSession provided", async () => {
    const res = await post("/ask", {
      targetSession: "backend",
      question: "test question",
      group: "acme",
    });

    // Will get a fork answer since mock summary returns INSUFFICIENT_CONTEXT
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.source).toBe("backend");
  });
});

describe("POST /ask - multi-target (targets field)", () => {
  test("asks multiple sessions and returns AskMultiResponse", async () => {
    const res = await post("/ask", {
      targets: ["frontend", "backend"],
      question: "test question",
      group: "acme",
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.answers).toBeInstanceOf(Array);
    expect(body.answers.length).toBe(2);
    expect(body.warnings).toBeInstanceOf(Array);
    expect(body.warnings.length).toBe(0);

    const sources = body.answers.map((a: any) => a.source).sort();
    expect(sources).toEqual(["backend", "frontend"]);

    for (const answer of body.answers) {
      expect(answer.answer).toBeTruthy();
      expect(answer.source).toBeTruthy();
      expect(typeof answer.fromFork).toBe("boolean");
    }
  });

  test("returns warnings for unresolved targets", async () => {
    const res = await post("/ask", {
      targets: ["frontend", "nonexistent"],
      question: "test question",
      group: "acme",
    });

    expect(res.status).toBe(207);
    const body = await res.json() as any;
    expect(body.answers.length).toBe(1);
    expect(body.answers[0].source).toBe("frontend");
    expect(body.warnings.length).toBe(1);
    expect(body.warnings[0]).toContain("nonexistent");
  });

  test("returns 404 when no targets resolve", async () => {
    const res = await post("/ask", {
      targets: ["nonexistent1", "nonexistent2"],
      question: "test question",
      group: "acme",
    });

    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.warnings.length).toBe(2);
  });

  test("deduplicates targets resolved to same session", async () => {
    const res = await post("/ask", {
      targets: ["backend", "bakend"],
      question: "test question",
      group: "acme",
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.answers.length).toBe(1);
    expect(body.answers[0].source).toBe("backend");
    expect(body.warnings.length).toBe(0);
  });

  test("returns 400 when resolved targets exceed maxFanOut", async () => {
    // Register 6 sessions (we already have 2, add 4 more)
    for (let i = 3; i <= 8; i++) {
      await post("/sessions/register", {
        sessionId: `s${i}`,
        claudeSessionId: `claude-uuid-${i}`,
        pid: process.pid,
        workingDirectory: `/projects/svc-${i}`,
        group: "acme",
        name: `service-${i}`,
      });
    }

    const res = await post("/ask", {
      targets: ["frontend", "backend", "service-3", "service-4", "service-5", "service-6"],
      question: "test question",
      group: "acme",
    });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain("max fan-out");
  });

  test("maxFanOut applies to deduplicated count, not input count", async () => {
    // 6 names but they resolve to only 2 unique sessions (below limit of 5)
    const res = await post("/ask", {
      targets: ["backend", "bakend", "backnd", "frontend", "frontnd", "fronted"],
      question: "test question",
      group: "acme",
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.answers.length).toBe(2); // only 2 unique sessions
  });

  test("isolates errors — one session crash doesn't block others", async () => {
    const errorForker = async (
      sessionId: string,
      _question: string,
      _config: ForkConfig
    ): Promise<ForkResult> => {
      if (sessionId === "claude-uuid-frontend") {
        throw new Error("Fork crashed for frontend");
      }
      return {
        answer: "Backend answer here",
        forkSessionId: "fork-ok",
        durationMs: 100,
      };
    };

    const errorBroker = new BrokerServer(storage, undefined, {
      ...mockDeps,
      forker: errorForker,
    });
    await errorBroker.start();
    const errorUrl = `http://127.0.0.1:${errorBroker.getPort()}`;

    await fetch(`${errorUrl}/sessions/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "s1", claudeSessionId: "claude-uuid-frontend",
        pid: process.pid, workingDirectory: "/projects/frontend", group: "acme", name: "frontend",
      }),
    });
    await fetch(`${errorUrl}/sessions/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "s2", claudeSessionId: "claude-uuid-backend",
        pid: process.pid, workingDirectory: "/projects/backend", group: "acme", name: "backend",
      }),
    });

    const res = await fetch(`${errorUrl}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targets: ["frontend", "backend"],
        question: "test",
        group: "acme",
      }),
    });

    expect(res.status).toBe(207);
    const body = await res.json() as any;
    expect(body.answers.length).toBe(1);
    expect(body.answers[0].source).toBe("backend");
    expect(body.warnings.length).toBeGreaterThanOrEqual(1);
    expect(body.warnings.some((w: string) => w.includes("frontend"))).toBe(true);

    await errorBroker.stop();
  });

  test("warns for dead sessions in multi-target", async () => {
    await post("/sessions/register", {
      sessionId: "dead-session",
      claudeSessionId: "claude-uuid-dead",
      pid: 99999999,
      workingDirectory: "/projects/dead",
      group: "acme",
      name: "dead-service",
    });

    const res = await post("/ask", {
      targets: ["frontend", "dead-service"],
      question: "test question",
      group: "acme",
    });

    expect(res.status).toBe(207);
    const body = await res.json() as any;
    expect(body.answers.length).toBe(1);
    expect(body.answers[0].source).toBe("frontend");
    expect(body.warnings.length).toBe(1);
    expect(body.warnings[0]).toContain("no longer alive");
  });

  test("uses fuzzy matching for individual targets", async () => {
    const res = await post("/ask", {
      targets: ["frontnd", "bakend"],
      question: "test question",
      group: "acme",
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.answers.length).toBe(2);
  });

  test("single element in targets returns AskMultiResponse format", async () => {
    const res = await post("/ask", {
      targets: ["backend"],
      question: "test question",
      group: "acme",
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    // Must have answers array, not flat answer/source/fromFork
    expect(body.answers).toBeInstanceOf(Array);
    expect(body.answers.length).toBe(1);
    expect(body.warnings).toBeInstanceOf(Array);
  });

  test("targets with wrong group returns 404", async () => {
    const res = await post("/ask", {
      targets: ["backend"],
      question: "test question",
      group: "wrong-group",
    });

    expect(res.status).toBe(404);
  });

  test("self-exclusion via sourceSession", async () => {
    const res = await post("/ask", {
      targets: ["frontend", "backend"],
      question: "test question",
      group: "acme",
      sourceSession: "s1",
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.answers.length).toBe(1);
    expect(body.answers[0].source).toBe("backend");
  });

  test("self-exclusion with all targets being self returns 404", async () => {
    const res = await post("/ask", {
      targets: ["frontend"],
      question: "test question",
      group: "acme",
      sourceSession: "s1",
    });

    expect(res.status).toBe(404);
  });
});

describe("POST /ask - mutual exclusivity", () => {
  test("rejects targetSession + targets", async () => {
    const res = await post("/ask", {
      targetSession: "backend",
      targets: ["frontend"],
      question: "test question",
      group: "acme",
    });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBe("Validation failed");
    expect(body.details.some((d: any) => d.message.includes("Only one targeting mode"))).toBe(true);
  });

  test("rejects targets + broadcast: true", async () => {
    const res = await post("/ask", {
      targets: ["frontend"],
      broadcast: true,
      question: "test question",
      group: "acme",
    });

    expect(res.status).toBe(400);
  });

  test("broadcast: false does not conflict with targetSession", async () => {
    const res = await post("/ask", {
      targetSession: "backend",
      broadcast: false,
      question: "test question",
      group: "acme",
    });

    expect(res.status).toBe(200);
  });

  test("broadcast: false does not conflict with targets", async () => {
    const res = await post("/ask", {
      targets: ["frontend", "backend"],
      broadcast: false,
      question: "test question",
      group: "acme",
    });

    expect(res.status).toBe(200);
  });
});

describe("POST /ask - broadcast", () => {
  test("broadcast queries all sessions in group", async () => {
    const res = await post("/ask", {
      broadcast: true,
      question: "test question",
      group: "acme",
    });

    // 200 or 207 depending on whether all sessions succeeded
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThanOrEqual(207);
    const body = await res.json() as any;
    expect(body.answers).toBeInstanceOf(Array);
    expect(body.answers.length).toBe(2);
  });

  test("broadcast excludes sourceSession", async () => {
    const res = await post("/ask", {
      broadcast: true,
      question: "test question",
      group: "acme",
      sourceSession: "s1",
    });

    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThanOrEqual(207);
    const body = await res.json() as any;
    expect(body.answers.length).toBe(1);
    expect(body.answers[0].source).toBe("backend");
  });

  test("broadcast with empty group returns 404", async () => {
    const res = await post("/ask", {
      broadcast: true,
      question: "test question",
      group: "empty-group",
    });

    expect(res.status).toBe(404);
  });

  test("broadcast with only self returns 404", async () => {
    // Deregister s2, leaving only s1 which is excluded
    await post("/sessions/deregister", { sessionId: "s2" });

    const res2 = await post("/ask", {
      broadcast: true,
      question: "test question",
      group: "acme",
      sourceSession: "s1",
    });

    expect(res2.status).toBe(404);
  });

  test("broadcast exceeding maxFanOut returns 400", async () => {
    // Register 4 more sessions (total 6 with existing 2)
    for (let i = 3; i <= 8; i++) {
      await post("/sessions/register", {
        sessionId: `s${i}`,
        claudeSessionId: `claude-uuid-${i}`,
        pid: process.pid,
        workingDirectory: `/projects/svc-${i}`,
        group: "acme",
        name: `service-${i}`,
      });
    }

    const res = await post("/ask", {
      broadcast: true,
      question: "test question",
      group: "acme",
    });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain("max fan-out");
  });
});

describe("POST /ask - two-phase execution", () => {
  test("answers from summary skip fork", async () => {
    let forkCallCount = 0;
    const twoPhaseEntries: import("../../src/summary/types.ts").SummaryEntry[] = [
      { topic: "users endpoint", content: "POST /users expects { email, password }", addedAt: Date.now() },
    ];
    const twoPhaseDeps = {
      forker: async (): Promise<ForkResult> => {
        forkCallCount++;
        return { answer: "fork answer", forkSessionId: "fork-1", durationMs: 100 };
      },
      summaryGenerate: async (): Promise<import("../../src/summary/types.ts").SummaryEntry[]> => twoPhaseEntries,
      summaryQuery: async (entries: any[], _q: string): Promise<string> => {
        if (entries.length > 0) return entries[0].content;
        return INSUFFICIENT_CONTEXT;
      },
      summaryEnrich: mockSummaryEnrich,
    };

    const tpBroker = new BrokerServer(storage, undefined, twoPhaseDeps);
    await tpBroker.start();
    const tpUrl = `http://127.0.0.1:${tpBroker.getPort()}`;

    await fetch(`${tpUrl}/sessions/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "s1", claudeSessionId: "uuid-1", pid: process.pid,
        workingDirectory: "/p/a", group: "acme", name: "svc-a",
      }),
    });
    await fetch(`${tpUrl}/sessions/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "s2", claudeSessionId: "uuid-2", pid: process.pid,
        workingDirectory: "/p/b", group: "acme", name: "svc-b",
      }),
    });

    // Both sessions have matching summaries for "users"
    const res = await fetch(`${tpUrl}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targets: ["svc-a", "svc-b"],
        question: "users endpoint",
        group: "acme",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.answers.length).toBe(2);
    expect(body.answers.every((a: any) => a.fromFork === false)).toBe(true);
    expect(forkCallCount).toBe(0);

    await tpBroker.stop();
  });

  test("INSUFFICIENT_CONTEXT triggers fork for that session only", async () => {
    let forkCallCount = 0;
    const twoPhaseDeps = {
      forker: async (): Promise<ForkResult> => {
        forkCallCount++;
        return { answer: "forked answer", forkSessionId: "fork-1", durationMs: 100 };
      },
      summaryGenerate: async (claudeSessionId: string): Promise<import("../../src/summary/types.ts").SummaryEntry[]> => {
        if (claudeSessionId === "uuid-1") {
          return [{ topic: "users endpoint", content: "POST /users", addedAt: Date.now() }];
        }
        return []; // uuid-2 has no useful entries
      },
      summaryQuery: async (entries: any[], _q: string): Promise<string> => {
        if (entries.length > 0) return entries[0].content;
        return INSUFFICIENT_CONTEXT;
      },
      summaryEnrich: mockSummaryEnrich,
    };

    const tpBroker = new BrokerServer(storage, undefined, twoPhaseDeps);
    await tpBroker.start();
    const tpUrl = `http://127.0.0.1:${tpBroker.getPort()}`;

    await fetch(`${tpUrl}/sessions/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "s1", claudeSessionId: "uuid-1", pid: process.pid,
        workingDirectory: "/p/a", group: "acme", name: "svc-a",
      }),
    });
    await fetch(`${tpUrl}/sessions/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "s2", claudeSessionId: "uuid-2", pid: process.pid,
        workingDirectory: "/p/b", group: "acme", name: "svc-b",
      }),
    });

    const res = await fetch(`${tpUrl}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targets: ["svc-a", "svc-b"],
        question: "users endpoint",
        group: "acme",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.answers.length).toBe(2);

    const summaryAnswer = body.answers.find((a: any) => a.fromFork === false);
    const forkAnswer = body.answers.find((a: any) => a.fromFork === true);
    expect(summaryAnswer).toBeTruthy();
    expect(forkAnswer).toBeTruthy();
    expect(forkCallCount).toBe(1);

    await tpBroker.stop();
  });

  test("enrichment runs after successful fork", async () => {
    let enrichCallCount = 0;
    const twoPhaseDeps = {
      forker: async (): Promise<ForkResult> => ({
        answer: "forked answer here", forkSessionId: "fork-1", durationMs: 100,
      }),
      summaryGenerate: async (): Promise<import("../../src/summary/types.ts").SummaryEntry[]> => [],
      summaryQuery: async (): Promise<string> => INSUFFICIENT_CONTEXT,
      summaryEnrich: async (_q: string, _a: string): Promise<import("../../src/summary/types.ts").SummaryEntry> => {
        enrichCallCount++;
        return { topic: "enriched", content: "enriched", addedAt: Date.now() };
      },
    };

    const tpBroker = new BrokerServer(storage, undefined, twoPhaseDeps);
    await tpBroker.start();
    const tpUrl = `http://127.0.0.1:${tpBroker.getPort()}`;

    await fetch(`${tpUrl}/sessions/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "s1", claudeSessionId: "uuid-1", pid: process.pid,
        workingDirectory: "/p/a", group: "acme", name: "svc-a",
      }),
    });

    await fetch(`${tpUrl}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targets: ["svc-a"],
        question: "test",
        group: "acme",
      }),
    });

    // Give background enrichment time to complete
    await new Promise((r) => setTimeout(r, 50));
    expect(enrichCallCount).toBe(1);

    await tpBroker.stop();
  });

  test("all answer from summary, zero forks", async () => {
    let forkCallCount = 0;
    const twoPhaseDeps = {
      forker: async (): Promise<ForkResult> => {
        forkCallCount++;
        return { answer: "forked", forkSessionId: "f1", durationMs: 100 };
      },
      summaryGenerate: async (): Promise<import("../../src/summary/types.ts").SummaryEntry[]> => [
        { topic: "users endpoint", content: "POST /users", addedAt: Date.now() },
      ],
      summaryQuery: async (entries: any[], _q: string): Promise<string> => {
        if (entries.length > 0) return entries[0].content;
        return INSUFFICIENT_CONTEXT;
      },
      summaryEnrich: mockSummaryEnrich,
    };

    const tpBroker = new BrokerServer(storage, undefined, twoPhaseDeps);
    await tpBroker.start();
    const tpUrl = `http://127.0.0.1:${tpBroker.getPort()}`;

    await fetch(`${tpUrl}/sessions/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "s1", claudeSessionId: "uuid-1", pid: process.pid,
        workingDirectory: "/p/a", group: "acme", name: "svc-a",
      }),
    });
    await fetch(`${tpUrl}/sessions/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "s2", claudeSessionId: "uuid-2", pid: process.pid,
        workingDirectory: "/p/b", group: "acme", name: "svc-b",
      }),
    });

    const res = await fetch(`${tpUrl}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targets: ["svc-a", "svc-b"],
        question: "users endpoint",
        group: "acme",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.answers.length).toBe(2);
    expect(forkCallCount).toBe(0);

    await tpBroker.stop();
  });
});

describe("POST /ask - 207 Multi-Status", () => {
  test("returns 207 when some targets have warnings", async () => {
    const res = await post("/ask", {
      targets: ["frontend", "nonexistent"],
      question: "test question",
      group: "acme",
    });

    expect(res.status).toBe(207);
    const body = await res.json() as any;
    expect(body.answers.length).toBe(1);
    expect(body.warnings.length).toBeGreaterThanOrEqual(1);
  });

  test("returns 200 when all targets succeed", async () => {
    const res = await post("/ask", {
      targets: ["frontend", "backend"],
      question: "test question",
      group: "acme",
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.answers.length).toBe(2);
    expect(body.warnings.length).toBe(0);
  });
});
