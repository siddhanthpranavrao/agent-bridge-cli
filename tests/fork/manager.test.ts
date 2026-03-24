import { describe, test, expect, afterEach } from "bun:test";
import { ForkManager } from "../../src/fork/manager.ts";
import { DEFAULT_FORK_CONFIG, type ForkConfig, type ForkResult } from "../../src/fork/types.ts";

// Track managers to dispose after each test
const managers: ForkManager[] = [];
function createManager(forker?: any, config?: any): ForkManager {
  const m = new ForkManager(forker, config);
  managers.push(m);
  return m;
}
afterEach(() => {
  managers.forEach((m) => m.dispose());
  managers.length = 0;
});

describe("ForkManager - configuration", () => {
  test("uses default config when none provided", () => {
    const manager = createManager(() => Promise.resolve({ answer: "", forkSessionId: "", durationMs: 0 }));
    const config = manager.getConfig();
    expect(config.timeoutMs).toBe(DEFAULT_FORK_CONFIG.timeoutMs);
    expect(config.systemPrompt).toBe(DEFAULT_FORK_CONFIG.systemPrompt);
  });

  test("accepts custom timeout", () => {
    const manager = createManager(undefined, { timeoutMs: 10000 });
    expect(manager.getConfig().timeoutMs).toBe(10000);
  });

  test("accepts custom system prompt", () => {
    const manager = createManager(undefined, { systemPrompt: "Custom prompt" });
    expect(manager.getConfig().systemPrompt).toBe("Custom prompt");
  });

  test("merges partial config with defaults", () => {
    const manager = createManager(undefined, { timeoutMs: 30000 });
    const config = manager.getConfig();
    expect(config.timeoutMs).toBe(30000);
    expect(config.systemPrompt).toBe(DEFAULT_FORK_CONFIG.systemPrompt);
  });
});

describe("ForkManager - forkAndAsk with mock forker", () => {
  test("calls forker with correct arguments", async () => {
    let receivedSessionId = "";
    let receivedQuestion = "";
    let receivedConfig: ForkConfig | null = null;

    const mockForker = async (sessionId: string, question: string, config: ForkConfig): Promise<ForkResult> => {
      receivedSessionId = sessionId;
      receivedQuestion = question;
      receivedConfig = config;
      return { answer: "test answer", forkSessionId: "fork-123", durationMs: 100 };
    };

    const manager = createManager(mockForker);
    await manager.forkAndAsk("session-uuid", "What is this?");

    expect(receivedSessionId).toBe("session-uuid");
    expect(receivedQuestion).toBe("What is this?");
    expect(receivedConfig).not.toBeNull();
    expect(receivedConfig!.timeoutMs).toBe(DEFAULT_FORK_CONFIG.timeoutMs);
  });

  test("returns fork result from forker", async () => {
    const mockForker = async (): Promise<ForkResult> => ({
      answer: "The /users endpoint expects { email, password }",
      forkSessionId: "fork-456",
      durationMs: 250,
    });

    const manager = createManager(mockForker);
    const result = await manager.forkAndAsk("session-uuid", "What does /users expect?");

    expect(result.answer).toBe("The /users endpoint expects { email, password }");
    expect(result.forkSessionId).toBe("fork-456");
    expect(result.durationMs).toBe(250);
  });

  test("returns INSUFFICIENT_CONTEXT when forker says so", async () => {
    const mockForker = async (): Promise<ForkResult> => ({
      answer: "INSUFFICIENT_CONTEXT",
      forkSessionId: "fork-789",
      durationMs: 50,
    });

    const manager = createManager(mockForker);
    const result = await manager.forkAndAsk("session-uuid", "Unknown question");

    expect(result.answer).toBe("INSUFFICIENT_CONTEXT");
  });

  test("propagates forker errors", async () => {
    const mockForker = async (): Promise<ForkResult> => {
      throw new Error("Fork failed");
    };

    const manager = createManager(mockForker);
    expect(manager.forkAndAsk("session-uuid", "question")).rejects.toThrow("Fork failed");
  });

  test("propagates timeout errors", async () => {
    const mockForker = async (): Promise<ForkResult> => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    };

    const manager = createManager(mockForker);
    expect(manager.forkAndAsk("session-uuid", "question")).rejects.toThrow("aborted");
  });
});

describe("ForkManager - fork TTL cache", () => {
  test("second ask to same session reuses cached fork", async () => {
    let forkerCallCount = 0;
    const sessionIds: string[] = [];

    const mockForker = async (sessionId: string): Promise<ForkResult> => {
      forkerCallCount++;
      sessionIds.push(sessionId);
      return { answer: "answer", forkSessionId: "fork-001", durationMs: 50 };
    };

    const manager = createManager(mockForker, { forkTtlMs: 5000 });

    await manager.forkAndAsk("original-session", "question 1");
    await manager.forkAndAsk("original-session", "question 2");

    expect(forkerCallCount).toBe(2);
    // First call uses original session, second uses the cached fork's session ID
    expect(sessionIds[0]).toBe("original-session");
    expect(sessionIds[1]).toBe("fork-001"); // reused!
  });

  test("different sessions get separate forks", async () => {
    const sessionIds: string[] = [];

    const mockForker = async (sessionId: string): Promise<ForkResult> => {
      sessionIds.push(sessionId);
      return { answer: "answer", forkSessionId: `fork-${sessionId}`, durationMs: 50 };
    };

    const manager = createManager(mockForker, { forkTtlMs: 5000 });

    await manager.forkAndAsk("session-a", "q1");
    await manager.forkAndAsk("session-b", "q2");

    expect(sessionIds[0]).toBe("session-a");
    expect(sessionIds[1]).toBe("session-b"); // not cached, different session
  });

  test("expired cache creates new fork", async () => {
    const sessionIds: string[] = [];

    const mockForker = async (sessionId: string): Promise<ForkResult> => {
      sessionIds.push(sessionId);
      return { answer: "answer", forkSessionId: "fork-001", durationMs: 50 };
    };

    const manager = createManager(mockForker, { forkTtlMs: 50 }); // 50ms TTL

    await manager.forkAndAsk("original-session", "question 1");
    await new Promise((r) => setTimeout(r, 100)); // wait for TTL to expire
    manager.cleanExpired(); // force cleanup
    await manager.forkAndAsk("original-session", "question 2");

    // Both calls should use the original session (cache expired)
    expect(sessionIds[0]).toBe("original-session");
    expect(sessionIds[1]).toBe("original-session");
  });

  test("getActiveForkCount returns correct count", async () => {
    const mockForker = async (sessionId: string): Promise<ForkResult> => ({
      answer: "answer",
      forkSessionId: `fork-${sessionId}`,
      durationMs: 50,
    });

    const manager = createManager(mockForker, { forkTtlMs: 5000 });

    expect(manager.getActiveForkCount()).toBe(0);
    await manager.forkAndAsk("session-a", "q");
    expect(manager.getActiveForkCount()).toBe(1);
    await manager.forkAndAsk("session-b", "q");
    expect(manager.getActiveForkCount()).toBe(2);
  });

  test("cleanExpired removes stale entries", async () => {
    const mockForker = async (): Promise<ForkResult> => ({
      answer: "answer",
      forkSessionId: "fork-001",
      durationMs: 50,
    });

    const manager = createManager(mockForker, { forkTtlMs: 50 });

    await manager.forkAndAsk("session-a", "q");
    expect(manager.getActiveForkCount()).toBe(1);

    await new Promise((r) => setTimeout(r, 100));
    const cleaned = manager.cleanExpired();
    expect(cleaned).toBe(1);
    expect(manager.getActiveForkCount()).toBe(0);
  });

  test("dispose clears cache and stops interval", () => {
    const mockForker = async (): Promise<ForkResult> => ({
      answer: "answer",
      forkSessionId: "fork-001",
      durationMs: 50,
    });

    const manager = createManager(mockForker);
    manager.dispose();
    expect(manager.getActiveForkCount()).toBe(0);
  });
});
