import { z } from "zod";
import {
  DEFAULT_MAX_SUMMARY_ENTRIES,
  DEFAULT_MAX_ENTRY_SIZE_CHARS,
} from "../constants.ts";

export const SummaryEntrySchema = z.object({
  topic: z.string().min(1),
  content: z.string().min(1),
  addedAt: z.number(),
});

export const SummarySchema = z.object({
  sessionId: z.string().min(1),
  generatedAt: z.number(),
  entries: z.array(SummaryEntrySchema),
});

export type SummaryEntry = z.infer<typeof SummaryEntrySchema>;
export type Summary = z.infer<typeof SummarySchema>;

export interface SummaryConfig {
  maxEntries: number;
  maxEntrySizeChars: number;
}

export const DEFAULT_SUMMARY_CONFIG: SummaryConfig = {
  maxEntries: DEFAULT_MAX_SUMMARY_ENTRIES,
  maxEntrySizeChars: DEFAULT_MAX_ENTRY_SIZE_CHARS,
};

/** Generates a comprehensive knowledge dump from a Claude Code session. */
export type GenerateFn = (
  claudeSessionId: string
) => Promise<SummaryEntry[]>;

/** Answers a question from summary entries, or returns "INSUFFICIENT_CONTEXT". */
export type QueryFn = (
  entries: SummaryEntry[],
  question: string
) => Promise<string>;

/** Extracts a structured knowledge entry from a fork Q&A pair. */
export type EnrichFn = (
  question: string,
  answer: string
) => Promise<SummaryEntry>;
