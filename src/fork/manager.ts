import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  DEFAULT_FORK_CONFIG,
  type ForkConfig,
  type ForkResult,
  type ForkerFn,
} from "./types.ts";

interface CachedFork {
  claudeSessionId: string;
  forkSessionId: string;
  lastUsedAt: number;
}

async function defaultForker(
  claudeSessionId: string,
  question: string,
  config: ForkConfig
): Promise<ForkResult> {
  const startTime = Date.now();
  let forkSessionId = "";
  let answer = "";

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), config.timeoutMs);

  try {
    const stream: AsyncGenerator<SDKMessage, void> = query({
      prompt: question,
      options: {
        resume: claudeSessionId,
        forkSession: true,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: config.systemPrompt,
        },
        allowedTools: ["Read", "Glob", "Grep"],
        abortController,
        persistSession: false,
        maxTurns: 3,
        effort: "low",
      },
    });

    for await (const message of stream) {
      if (message.type === "system" && message.subtype === "init") {
        forkSessionId = message.session_id;
      }
      if (message.type === "result" && message.subtype === "success") {
        answer = message.result;
      }
    }
  } finally {
    clearTimeout(timeout);
  }

  return {
    answer,
    forkSessionId,
    durationMs: Date.now() - startTime,
  };
}

export class ForkManager {
  private readonly config: ForkConfig;
  private readonly forker: ForkerFn;
  private readonly forkCache: Map<string, CachedFork> = new Map();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(forker?: ForkerFn, config?: Partial<ForkConfig>) {
    this.config = { ...DEFAULT_FORK_CONFIG, ...config };
    this.forker = forker ?? defaultForker;
    this.cleanupInterval = setInterval(() => this.cleanExpired(), 60_000);
  }

  async forkAndAsk(
    claudeSessionId: string,
    question: string
  ): Promise<ForkResult> {
    // Check cache for a reusable fork
    const cached = this.forkCache.get(claudeSessionId);
    if (cached && !this.isExpired(cached)) {
      cached.lastUsedAt = Date.now();
      // Reuse: call forker with the fork's session ID to continue its conversation
      return this.forker(cached.forkSessionId, question, this.config);
    }

    // No usable cache — create new fork
    const result = await this.forker(claudeSessionId, question, this.config);

    // Cache the fork for future reuse
    if (result.forkSessionId) {
      this.forkCache.set(claudeSessionId, {
        claudeSessionId,
        forkSessionId: result.forkSessionId,
        lastUsedAt: Date.now(),
      });
    }

    return result;
  }

  cleanExpired(): number {
    let cleaned = 0;
    const now = Date.now();
    for (const [key, cached] of this.forkCache) {
      if (now - cached.lastUsedAt > this.config.forkTtlMs) {
        this.forkCache.delete(key);
        cleaned++;
      }
    }
    return cleaned;
  }

  getActiveForkCount(): number {
    return this.forkCache.size;
  }

  getConfig(): ForkConfig {
    return { ...this.config };
  }

  dispose(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.forkCache.clear();
  }

  private isExpired(cached: CachedFork): boolean {
    return Date.now() - cached.lastUsedAt > this.config.forkTtlMs;
  }
}
