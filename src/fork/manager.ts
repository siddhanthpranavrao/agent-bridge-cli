import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  DEFAULT_FORK_CONFIG,
  type ForkConfig,
  type ForkResult,
  type ForkerFn,
} from "./types.ts";

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

  constructor(forker?: ForkerFn, config?: Partial<ForkConfig>) {
    this.config = { ...DEFAULT_FORK_CONFIG, ...config };
    this.forker = forker ?? defaultForker;
  }

  async forkAndAsk(
    claudeSessionId: string,
    question: string
  ): Promise<ForkResult> {
    return this.forker(claudeSessionId, question, this.config);
  }

  getConfig(): ForkConfig {
    return { ...this.config };
  }
}
