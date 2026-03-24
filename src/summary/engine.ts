import { SUMMARIES_DIR, INSUFFICIENT_CONTEXT } from "../constants.ts";
import type { Storage } from "../storage/storage.ts";
import {
  SummarySchema,
  DEFAULT_SUMMARY_CONFIG,
  type Summary,
  type SummaryEntry,
  type SummaryConfig,
  type GenerateFn,
  type QueryFn,
  type EnrichFn,
} from "./types.ts";
import { defaultGenerateFn, defaultQueryFn, defaultEnrichFn } from "./llm.ts";

export class SummaryEngine {
  private readonly storage: Storage;
  private readonly generateFn: GenerateFn;
  private readonly queryFn: QueryFn;
  private readonly enrichFn: EnrichFn;
  private readonly config: SummaryConfig;

  constructor(
    storage: Storage,
    generateFn?: GenerateFn,
    queryFn?: QueryFn,
    enrichFn?: EnrichFn,
    config?: Partial<SummaryConfig>
  ) {
    this.storage = storage;
    this.generateFn = generateFn ?? defaultGenerateFn;
    this.queryFn = queryFn ?? defaultQueryFn;
    this.enrichFn = enrichFn ?? defaultEnrichFn;
    this.config = { ...DEFAULT_SUMMARY_CONFIG, ...config };
  }

  async generate(
    sessionId: string,
    claudeSessionId: string,
    cwd?: string
  ): Promise<Summary> {
    let entries: SummaryEntry[];
    try {
      entries = await this.generateFn(claudeSessionId, cwd);
    } catch (err) {
      console.error("[bridge] Summary generation error:", err instanceof Error ? err.message : err);
      entries = [];
    }

    const truncatedEntries = entries
      .map((e) => ({
        ...e,
        content: e.content.slice(0, this.config.maxEntrySizeChars),
      }))
      .slice(0, this.config.maxEntries);

    const summary: Summary = {
      sessionId,
      generatedAt: Date.now(),
      entries: truncatedEntries,
    };

    await this.persistSummary(summary);
    return summary;
  }

  async query(sessionId: string, question: string): Promise<string> {
    const summary = await this.getSummary(sessionId);
    if (!summary || summary.entries.length === 0) {
      return INSUFFICIENT_CONTEXT;
    }

    const matchedEntries = this.findMatchingEntries(
      summary.entries,
      question
    );
    if (matchedEntries.length === 0) {
      return INSUFFICIENT_CONTEXT;
    }

    return await this.queryFn(matchedEntries, question);
  }

  async enrich(
    sessionId: string,
    question: string,
    answer: string
  ): Promise<void> {
    const newEntry = await this.enrichFn(question, answer);

    const truncatedEntry: SummaryEntry = {
      ...newEntry,
      content: newEntry.content.slice(0, this.config.maxEntrySizeChars),
      addedAt: Date.now(),
    };

    const summary = await this.getSummary(sessionId);
    if (!summary) {
      // No existing summary — create one with just this entry
      const newSummary: Summary = {
        sessionId,
        generatedAt: Date.now(),
        entries: [truncatedEntry],
      };
      await this.persistSummary(newSummary);
      return;
    }

    summary.entries.push(truncatedEntry);

    // Prune oldest if over limit
    if (summary.entries.length > this.config.maxEntries) {
      summary.entries = summary.entries.slice(
        summary.entries.length - this.config.maxEntries
      );
    }

    await this.persistSummary(summary);
  }

  async delete(sessionId: string): Promise<void> {
    await this.storage.delete(this.summaryPath(sessionId));
  }

  async getSummary(sessionId: string): Promise<Summary | null> {
    const content = await this.storage.read(this.summaryPath(sessionId));
    if (!content) {
      return null;
    }

    try {
      const parsed = JSON.parse(content);
      return SummarySchema.parse(parsed);
    } catch {
      return null;
    }
  }

  async hasSummary(sessionId: string): Promise<boolean> {
    return await this.storage.exists(this.summaryPath(sessionId));
  }

  async hasFreshSummary(sessionId: string): Promise<boolean> {
    const summary = await this.getSummary(sessionId);
    if (!summary) {
      return false;
    }
    const age = Date.now() - summary.generatedAt;
    return age < this.config.maxSummaryAgeMs;
  }

  /**
   * Simple keyword matching: find entries whose topics overlap with question words.
   * This is a fast pre-filter — false negatives just trigger a fork (safe).
   */
  findMatchingEntries(
    entries: SummaryEntry[],
    question: string
  ): SummaryEntry[] {
    const questionWords = this.extractWords(question);
    if (questionWords.length === 0) {
      return [];
    }

    return entries.filter((entry) => {
      const topicWords = this.extractWords(entry.topic);
      return topicWords.some((tw) => questionWords.includes(tw));
    });
  }

  /**
   * Rank sessions by how relevant their summaries are to a question.
   * Uses keyword matching — zero LLM cost.
   * Returns sorted descending by score, filtered to score > 0.
   */
  async rankSessions(
    sessionIds: string[],
    question: string
  ): Promise<{ sessionId: string; score: number }[]> {
    const results: { sessionId: string; score: number }[] = [];

    for (const sessionId of sessionIds) {
      const summary = await this.getSummary(sessionId);
      if (!summary || summary.entries.length === 0) {
        continue;
      }

      const matched = this.findMatchingEntries(summary.entries, question);
      if (matched.length > 0) {
        results.push({ sessionId, score: matched.length });
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  private extractWords(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1); // skip single-char words
  }

  private summaryPath(sessionId: string): string {
    return `${SUMMARIES_DIR}/${sessionId}.json`;
  }

  private async persistSummary(summary: Summary): Promise<void> {
    await this.storage.write(
      this.summaryPath(summary.sessionId),
      JSON.stringify(summary, null, 2)
    );
  }
}
