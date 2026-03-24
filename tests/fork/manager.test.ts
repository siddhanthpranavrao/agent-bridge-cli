import { describe, test, expect } from "bun:test";
import { ForkManager } from "../../src/fork/manager.ts";
import { DEFAULT_FORK_CONFIG, type ForkConfig, type ForkResult } from "../../src/fork/types.ts";

describe("ForkManager - configuration", () => {
  test("uses default config when none provided", () => {
    const manager = new ForkManager(() => Promise.resolve({ answer: "", forkSessionId: "", durationMs: 0 }));
    const config = manager.getConfig();
    expect(config.timeoutMs).toBe(DEFAULT_FORK_CONFIG.timeoutMs);
    expect(config.systemPrompt).toBe(DEFAULT_FORK_CONFIG.systemPrompt);
  });

  test("accepts custom timeout", () => {
    const manager = new ForkManager(undefined, { timeoutMs: 10000 });
    expect(manager.getConfig().timeoutMs).toBe(10000);
  });

  test("accepts custom system prompt", () => {
    const manager = new ForkManager(undefined, { systemPrompt: "Custom prompt" });
    expect(manager.getConfig().systemPrompt).toBe("Custom prompt");
  });

  test("merges partial config with defaults", () => {
    const manager = new ForkManager(undefined, { timeoutMs: 30000 });
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

    const manager = new ForkManager(mockForker);
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

    const manager = new ForkManager(mockForker);
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

    const manager = new ForkManager(mockForker);
    const result = await manager.forkAndAsk("session-uuid", "Unknown question");

    expect(result.answer).toBe("INSUFFICIENT_CONTEXT");
  });

  test("propagates forker errors", async () => {
    const mockForker = async (): Promise<ForkResult> => {
      throw new Error("Fork failed");
    };

    const manager = new ForkManager(mockForker);
    expect(manager.forkAndAsk("session-uuid", "question")).rejects.toThrow("Fork failed");
  });

  test("propagates timeout errors", async () => {
    const mockForker = async (): Promise<ForkResult> => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    };

    const manager = new ForkManager(mockForker);
    expect(manager.forkAndAsk("session-uuid", "question")).rejects.toThrow("aborted");
  });
});
