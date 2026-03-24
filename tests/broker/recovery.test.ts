import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Storage } from "../../src/storage/storage.ts";
import { SessionManager } from "../../src/sessions/manager.ts";
import { SummaryEngine } from "../../src/summary/engine.ts";
import { recoverFromCrash } from "../../src/broker/recovery.ts";
import { INSUFFICIENT_CONTEXT } from "../../src/constants.ts";
import type { SummaryEntry } from "../../src/summary/types.ts";

let testDir: string;
let storage: Storage;
let sessionManager: SessionManager;
let summaryEngine: SummaryEngine;

const mockGenerateFn = async () => [] as SummaryEntry[];
const mockQueryFn = async () => INSUFFICIENT_CONTEXT;
const mockEnrichFn = async () => ({ topic: "mock", content: "mock", addedAt: Date.now() });

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "agent-bridge-recovery-test-"));
  storage = new Storage({ baseDir: testDir });
  await storage.initDirectories();
  sessionManager = new SessionManager(storage);
  summaryEngine = new SummaryEngine(storage, mockGenerateFn, mockQueryFn, mockEnrichFn);
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("Crash recovery - stale PID detection", () => {
  test("clean start when no PID file exists", async () => {
    const result = await recoverFromCrash(storage, sessionManager, summaryEngine);
    expect(result.wasCrash).toBe(false);
    expect(result.sessionsLoaded).toBe(0);
  });

  test("detects crash when PID file contains dead process", async () => {
    await storage.write("broker.pid", "99999999");
    await storage.write("broker.port", "12345");

    const result = await recoverFromCrash(storage, sessionManager, summaryEngine);
    expect(result.wasCrash).toBe(true);

    // Stale files should be cleaned up
    expect(await storage.exists("broker.pid")).toBe(false);
    expect(await storage.exists("broker.port")).toBe(false);
  });

  test("throws when PID file contains alive process", async () => {
    await storage.write("broker.pid", String(process.pid));

    expect(recoverFromCrash(storage, sessionManager, summaryEngine))
      .rejects.toThrow("already running");
  });

  test("handles corrupted PID file gracefully", async () => {
    await storage.write("broker.pid", "not-a-number");
    await storage.write("broker.port", "12345");

    const result = await recoverFromCrash(storage, sessionManager, summaryEngine);
    expect(result.wasCrash).toBe(false);

    // Corrupted files should be cleaned up
    expect(await storage.exists("broker.pid")).toBe(false);
    expect(await storage.exists("broker.port")).toBe(false);
  });
});

describe("Crash recovery - session reload", () => {
  test("loads persisted sessions with alive PIDs", async () => {
    // Simulate persisted sessions
    const sessions = [
      {
        sessionId: "s1",
        claudeSessionId: "uuid-1",
        pid: process.pid, // alive
        workingDirectory: "/projects/frontend",
        group: "acme",
        name: "frontend",
        connectedAt: Date.now(),
      },
    ];
    await storage.write("groups/acme/sessions.json", JSON.stringify(sessions));
    await storage.write("broker.pid", "99999999"); // dead PID to trigger recovery

    const result = await recoverFromCrash(storage, sessionManager, summaryEngine);
    expect(result.sessionsLoaded).toBe(1);
    expect(result.sessionsRemoved).toBe(0);
    expect(sessionManager.getSessionCount()).toBe(1);
  });

  test("removes persisted sessions with dead PIDs", async () => {
    const sessions = [
      {
        sessionId: "dead-s1",
        claudeSessionId: "uuid-dead",
        pid: 99999999, // dead
        workingDirectory: "/projects/backend",
        group: "acme",
        name: "backend",
        connectedAt: Date.now(),
      },
    ];
    await storage.write("groups/acme/sessions.json", JSON.stringify(sessions));
    await storage.write("broker.pid", "99999998"); // dead PID

    const result = await recoverFromCrash(storage, sessionManager, summaryEngine);
    expect(result.sessionsLoaded).toBe(1);
    expect(result.sessionsRemoved).toBe(1);
    expect(sessionManager.getSessionCount()).toBe(0);
  });

  test("handles mixed alive and dead sessions", async () => {
    const sessions = [
      {
        sessionId: "alive",
        claudeSessionId: "uuid-alive",
        pid: process.pid,
        workingDirectory: "/projects/frontend",
        group: "acme",
        name: "frontend",
        connectedAt: Date.now(),
      },
      {
        sessionId: "dead",
        claudeSessionId: "uuid-dead",
        pid: 99999999,
        workingDirectory: "/projects/backend",
        group: "acme",
        name: "backend",
        connectedAt: Date.now(),
      },
    ];
    await storage.write("groups/acme/sessions.json", JSON.stringify(sessions));
    await storage.write("broker.pid", "99999998");

    const result = await recoverFromCrash(storage, sessionManager, summaryEngine);
    expect(result.sessionsLoaded).toBe(2);
    expect(result.sessionsRemoved).toBe(1);
    expect(sessionManager.getSessionCount()).toBe(1);
    expect(sessionManager.getSession("alive")).not.toBeNull();
    expect(sessionManager.getSession("dead")).toBeNull();
  });
});

describe("Crash recovery - orphaned summaries", () => {
  test("cleans summaries for non-existent sessions", async () => {
    // Write an orphaned summary (no matching session)
    await storage.write("summaries/orphan.json", JSON.stringify({
      sessionId: "orphan",
      generatedAt: Date.now(),
      entries: [],
    }));
    await storage.write("broker.pid", "99999999");

    const result = await recoverFromCrash(storage, sessionManager, summaryEngine);
    expect(result.summariesCleaned).toBe(1);
    expect(await storage.exists("summaries/orphan.json")).toBe(false);
  });

  test("keeps summaries for alive sessions", async () => {
    // Persisted session + matching summary
    const sessions = [{
      sessionId: "s1",
      claudeSessionId: "uuid-1",
      pid: process.pid,
      workingDirectory: "/projects/frontend",
      group: "acme",
      name: "frontend",
      connectedAt: Date.now(),
    }];
    await storage.write("groups/acme/sessions.json", JSON.stringify(sessions));
    await storage.write("summaries/s1.json", JSON.stringify({
      sessionId: "s1",
      generatedAt: Date.now(),
      entries: [{ topic: "test", content: "test", addedAt: Date.now() }],
    }));
    await storage.write("broker.pid", "99999999");

    const result = await recoverFromCrash(storage, sessionManager, summaryEngine);
    expect(result.summariesCleaned).toBe(0);
    expect(await storage.exists("summaries/s1.json")).toBe(true);
  });
});

describe("Crash recovery - full integration", () => {
  test("complete crash recovery flow", async () => {
    // Simulate state before crash:
    // - 2 sessions (1 alive, 1 dead)
    // - 2 summaries (1 matching alive, 1 orphaned from dead)
    const sessions = [
      {
        sessionId: "alive",
        claudeSessionId: "uuid-alive",
        pid: process.pid,
        workingDirectory: "/projects/frontend",
        group: "acme",
        name: "frontend",
        connectedAt: Date.now(),
      },
      {
        sessionId: "dead",
        claudeSessionId: "uuid-dead",
        pid: 99999999,
        workingDirectory: "/projects/backend",
        group: "acme",
        name: "backend",
        connectedAt: Date.now(),
      },
    ];
    await storage.write("groups/acme/sessions.json", JSON.stringify(sessions));
    await storage.write("summaries/alive.json", JSON.stringify({
      sessionId: "alive", generatedAt: Date.now(), entries: [],
    }));
    await storage.write("summaries/dead.json", JSON.stringify({
      sessionId: "dead", generatedAt: Date.now(), entries: [],
    }));
    await storage.write("broker.pid", "99999998");
    await storage.write("broker.port", "12345");

    const result = await recoverFromCrash(storage, sessionManager, summaryEngine);

    expect(result.wasCrash).toBe(true);
    expect(result.sessionsLoaded).toBe(2);
    expect(result.sessionsRemoved).toBe(1);
    expect(result.summariesCleaned).toBe(1);

    // Verify state
    expect(sessionManager.getSessionCount()).toBe(1);
    expect(sessionManager.getSession("alive")).not.toBeNull();
    expect(await storage.exists("summaries/alive.json")).toBe(true);
    expect(await storage.exists("summaries/dead.json")).toBe(false);
    expect(await storage.exists("broker.pid")).toBe(false);
    expect(await storage.exists("broker.port")).toBe(false);
  });
});
