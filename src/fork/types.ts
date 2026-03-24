import { z } from "zod";
import { DEFAULT_FORK_TIMEOUT_MS, DEFAULT_FORK_TTL_MS } from "../constants.ts";

export const AskRequestSchema = z
  .object({
    targetSession: z.string().min(1).optional(),
    targets: z.array(z.string().min(1)).min(1).optional(),
    broadcast: z.boolean().optional(),
    question: z.string().min(1),
    group: z.string().min(1),
    sourceSession: z.string().min(1).optional(),
  })
  .superRefine((data, ctx) => {
    const modes: string[] = [];
    if (data.targetSession) modes.push("targetSession");
    if (data.targets) modes.push("targets");
    if (data.broadcast === true) modes.push("broadcast");
    if (modes.length > 1) {
      ctx.addIssue({
        code: "custom",
        message: `Only one targeting mode allowed. Found: ${modes.join(", ")}`,
        path: [modes[1]!],
      });
    }
  });

export type AskRequest = z.infer<typeof AskRequestSchema>;

export interface AskResponse {
  answer: string;
  source: string;
  fromFork: boolean;
}

export interface AskMultiResponse {
  answers: AskResponse[];
  warnings: string[];
}

export interface ForkResult {
  answer: string;
  forkSessionId: string;
  durationMs: number;
}

export interface ForkConfig {
  timeoutMs: number;
  systemPrompt: string;
  forkTtlMs: number;
}

export type ForkerFn = (
  claudeSessionId: string,
  question: string,
  config: ForkConfig,
  cwd?: string
) => Promise<ForkResult>;

export const DEFAULT_FORK_CONFIG: ForkConfig = {
  timeoutMs: DEFAULT_FORK_TIMEOUT_MS,
  forkTtlMs: DEFAULT_FORK_TTL_MS,
  systemPrompt:
    "You are answering a question from another Claude Code session. Answer concisely and directly. Only provide information you are confident about based on this session's context. If you don't have enough context to answer, say exactly: INSUFFICIENT_CONTEXT",
};
