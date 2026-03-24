import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { INSUFFICIENT_CONTEXT } from "../../src/constants.ts";
import { Storage } from "../../src/storage/storage.ts";
import { SummaryEngine } from "../../src/summary/engine.ts";
import type { SummaryEntry, GenerateFn, QueryFn, EnrichFn } from "../../src/summary/types.ts";

let testDir: string;
let storage: Storage;

const mockEntries: SummaryEntry[] = [
  { topic: "/users endpoint", content: "POST /users expects { email, password }. Returns 201.", addedAt: 1000 },
  { topic: "authentication flow", content: "JWT-based auth. Tokens issued at POST /auth/login. 24h expiry.", addedAt: 1001 },
  { topic: "database schema", content: "PostgreSQL. users table: id, email, password_hash, role, created_at.", addedAt: 1002 },
];

const mockGenerateFn: GenerateFn = async () => [...mockEntries];

const mockQueryFn: QueryFn = async (entries, _question) => {
  if (entries.length > 0) {
    return entries[0]!.content;
  }
  return INSUFFICIENT_CONTEXT;
};

const mockEnrichFn: EnrichFn = async (question, answer) => ({
  topic: question.slice(0, 50),
  content: answer.slice(0, 200),
  addedAt: Date.now(),
});

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "agent-bridge-summary-test-"));
  storage = new Storage({ baseDir: testDir });
  await storage.initDirectories();
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("SummaryEngine - generate", () => {
  test("creates summary with entries from generateFn", async () => {
    const engine = new SummaryEngine(storage, mockGenerateFn, mockQueryFn, mockEnrichFn);
    const summary = await engine.generate("s1", "claude-uuid-1");

    expect(summary.sessionId).toBe("s1");
    expect(summary.entries.length).toBe(3);
    expect(summary.entries[0]!.topic).toBe("/users endpoint");
    expect(typeof summary.generatedAt).toBe("number");
  });

  test("persists summary to disk", async () => {
    const engine = new SummaryEngine(storage, mockGenerateFn, mockQueryFn, mockEnrichFn);
    await engine.generate("s1", "claude-uuid-1");

    expect(await storage.exists("summaries/s1.json")).toBe(true);
  });

  test("truncates entries exceeding maxEntries", async () => {
    const manyEntries: SummaryEntry[] = Array.from({ length: 150 }, (_, i) => ({
      topic: `topic-${i}`,
      content: `content-${i}`,
      addedAt: Date.now(),
    }));
    const bigGenerateFn: GenerateFn = async () => manyEntries;

    const engine = new SummaryEngine(storage, bigGenerateFn, mockQueryFn, mockEnrichFn, {
      maxEntries: 50,
    });
    const summary = await engine.generate("s1", "claude-uuid-1");

    expect(summary.entries.length).toBe(50);
  });

  test("truncates entry content exceeding maxEntrySizeChars", async () => {
    const longEntry: SummaryEntry[] = [
      { topic: "long", content: "x".repeat(5000), addedAt: Date.now() },
    ];
    const longGenerateFn: GenerateFn = async () => longEntry;

    const engine = new SummaryEngine(storage, longGenerateFn, mockQueryFn, mockEnrichFn, {
      maxEntrySizeChars: 100,
    });
    const summary = await engine.generate("s1", "claude-uuid-1");

    expect(summary.entries[0]!.content.length).toBe(100);
  });
});

describe("SummaryEngine - query", () => {
  test("returns answer when matching entries found", async () => {
    const engine = new SummaryEngine(storage, mockGenerateFn, mockQueryFn, mockEnrichFn);
    await engine.generate("s1", "claude-uuid-1");

    const answer = await engine.query("s1", "What does the users endpoint expect?");
    expect(answer).not.toBe(INSUFFICIENT_CONTEXT);
    expect(answer).toContain("/users");
  });

  test("returns INSUFFICIENT_CONTEXT when no summary exists", async () => {
    const engine = new SummaryEngine(storage, mockGenerateFn, mockQueryFn, mockEnrichFn);
    const answer = await engine.query("nonexistent", "question");
    expect(answer).toBe(INSUFFICIENT_CONTEXT);
  });

  test("returns INSUFFICIENT_CONTEXT when no keywords match", async () => {
    let queryFnCalled = false;
    const trackingQueryFn: QueryFn = async (entries, question) => {
      queryFnCalled = true;
      return mockQueryFn(entries, question);
    };

    const engine = new SummaryEngine(storage, mockGenerateFn, trackingQueryFn, mockEnrichFn);
    await engine.generate("s1", "claude-uuid-1");

    const answer = await engine.query("s1", "what is the weather today?");
    expect(answer).toBe(INSUFFICIENT_CONTEXT);
    expect(queryFnCalled).toBe(false); // LLM should NOT have been called
  });

  test("passes only matched entries to queryFn", async () => {
    let receivedEntries: SummaryEntry[] = [];
    const trackingQueryFn: QueryFn = async (entries, _question) => {
      receivedEntries = entries;
      return entries[0]!.content;
    };

    const engine = new SummaryEngine(storage, mockGenerateFn, trackingQueryFn, mockEnrichFn);
    await engine.generate("s1", "claude-uuid-1");

    await engine.query("s1", "How does authentication work?");

    // Should only pass the "authentication flow" entry, not all 3
    expect(receivedEntries.length).toBe(1);
    expect(receivedEntries[0]!.topic).toBe("authentication flow");
  });

  test("propagates INSUFFICIENT_CONTEXT from queryFn", async () => {
    const alwaysInsufficient: QueryFn = async () => INSUFFICIENT_CONTEXT;

    const engine = new SummaryEngine(storage, mockGenerateFn, alwaysInsufficient, mockEnrichFn);
    await engine.generate("s1", "claude-uuid-1");

    const answer = await engine.query("s1", "users endpoint details");
    expect(answer).toBe(INSUFFICIENT_CONTEXT);
  });
});

describe("SummaryEngine - keyword matching", () => {
  test("matches question words to entry topics", () => {
    const engine = new SummaryEngine(storage, mockGenerateFn, mockQueryFn, mockEnrichFn);
    const matched = engine.findMatchingEntries(mockEntries, "users endpoint");

    expect(matched.length).toBe(1);
    expect(matched[0]!.topic).toBe("/users endpoint");
  });

  test("matches case-insensitively", () => {
    const engine = new SummaryEngine(storage, mockGenerateFn, mockQueryFn, mockEnrichFn);
    const matched = engine.findMatchingEntries(mockEntries, "AUTHENTICATION");

    expect(matched.length).toBe(1);
    expect(matched[0]!.topic).toBe("authentication flow");
  });

  test("returns empty for no matches", () => {
    const engine = new SummaryEngine(storage, mockGenerateFn, mockQueryFn, mockEnrichFn);
    const matched = engine.findMatchingEntries(mockEntries, "kubernetes deployment");

    expect(matched.length).toBe(0);
  });

  test("matches multiple entries", () => {
    const engine = new SummaryEngine(storage, mockGenerateFn, mockQueryFn, mockEnrichFn);
    // "database" matches "database schema", this tests the matching works
    const matched = engine.findMatchingEntries(mockEntries, "database schema details");

    expect(matched.length).toBeGreaterThanOrEqual(1);
    expect(matched.some((e) => e.topic === "database schema")).toBe(true);
  });

  test("skips single-character words", () => {
    const engine = new SummaryEngine(storage, mockGenerateFn, mockQueryFn, mockEnrichFn);
    // "a" and "I" should be skipped
    const matched = engine.findMatchingEntries(mockEntries, "a I");

    expect(matched.length).toBe(0);
  });
});

describe("SummaryEngine - enrich", () => {
  test("appends new entry to existing summary", async () => {
    const engine = new SummaryEngine(storage, mockGenerateFn, mockQueryFn, mockEnrichFn);
    await engine.generate("s1", "claude-uuid-1");

    await engine.enrich("s1", "How does caching work?", "Redis is used for caching with a 5min TTL");

    const summary = await engine.getSummary("s1");
    expect(summary!.entries.length).toBe(4); // 3 original + 1 enriched
  });

  test("creates summary if none exists when enriching", async () => {
    const engine = new SummaryEngine(storage, mockGenerateFn, mockQueryFn, mockEnrichFn);

    await engine.enrich("s1", "topic", "answer");

    const summary = await engine.getSummary("s1");
    expect(summary).not.toBeNull();
    expect(summary!.entries.length).toBe(1);
  });

  test("prunes oldest entries when exceeding maxEntries", async () => {
    const engine = new SummaryEngine(storage, mockGenerateFn, mockQueryFn, mockEnrichFn, {
      maxEntries: 4,
    });
    await engine.generate("s1", "claude-uuid-1"); // 3 entries

    await engine.enrich("s1", "new-1", "answer-1");
    await engine.enrich("s1", "new-2", "answer-2");

    const summary = await engine.getSummary("s1");
    expect(summary!.entries.length).toBe(4); // capped at 4
    // Oldest entry should have been pruned
    expect(summary!.entries.some((e) => e.topic === "/users endpoint")).toBe(false);
  });

  test("enriched data persists to disk", async () => {
    const engine = new SummaryEngine(storage, mockGenerateFn, mockQueryFn, mockEnrichFn);
    await engine.generate("s1", "claude-uuid-1");
    await engine.enrich("s1", "caching", "Redis caching");

    // Read from disk with a new engine instance
    const engine2 = new SummaryEngine(storage, mockGenerateFn, mockQueryFn, mockEnrichFn);
    const summary = await engine2.getSummary("s1");
    expect(summary!.entries.length).toBe(4);
  });
});

describe("SummaryEngine - delete", () => {
  test("removes summary file", async () => {
    const engine = new SummaryEngine(storage, mockGenerateFn, mockQueryFn, mockEnrichFn);
    await engine.generate("s1", "claude-uuid-1");

    await engine.delete("s1");

    expect(await storage.exists("summaries/s1.json")).toBe(false);
    expect(await engine.hasSummary("s1")).toBe(false);
  });

  test("is no-op if no summary exists", async () => {
    const engine = new SummaryEngine(storage, mockGenerateFn, mockQueryFn, mockEnrichFn);
    // Should not throw
    await engine.delete("nonexistent");
  });
});

describe("SummaryEngine - hasSummary", () => {
  test("returns true when summary exists", async () => {
    const engine = new SummaryEngine(storage, mockGenerateFn, mockQueryFn, mockEnrichFn);
    await engine.generate("s1", "claude-uuid-1");

    expect(await engine.hasSummary("s1")).toBe(true);
  });

  test("returns false when no summary", async () => {
    const engine = new SummaryEngine(storage, mockGenerateFn, mockQueryFn, mockEnrichFn);
    expect(await engine.hasSummary("nonexistent")).toBe(false);
  });
});

describe("SummaryEngine - rankSessions", () => {
  test("ranks sessions with matching summaries higher", async () => {
    const engine = new SummaryEngine(storage, mockGenerateFn, mockQueryFn, mockEnrichFn);

    // Create different summaries for different sessions
    const backendGenerate: GenerateFn = async () => [
      { topic: "/users endpoint", content: "POST /users", addedAt: Date.now() },
      { topic: "authentication", content: "JWT auth", addedAt: Date.now() },
    ];
    const frontendGenerate: GenerateFn = async () => [
      { topic: "React components", content: "UserProfile component", addedAt: Date.now() },
    ];

    const backendEngine = new SummaryEngine(storage, backendGenerate, mockQueryFn, mockEnrichFn);
    await backendEngine.generate("backend", "uuid-1");

    const frontendEngine = new SummaryEngine(storage, frontendGenerate, mockQueryFn, mockEnrichFn);
    await frontendEngine.generate("frontend", "uuid-2");

    const ranked = await engine.rankSessions(["backend", "frontend"], "users authentication");

    expect(ranked.length).toBe(1);
    expect(ranked[0]!.sessionId).toBe("backend");
    expect(ranked[0]!.score).toBe(2); // matches both "users" and "authentication"
  });

  test("returns empty when no sessions have summaries", async () => {
    const engine = new SummaryEngine(storage, mockGenerateFn, mockQueryFn, mockEnrichFn);
    const ranked = await engine.rankSessions(["s1", "s2"], "any question");
    expect(ranked).toEqual([]);
  });

  test("returns empty when no summaries match the question", async () => {
    const engine = new SummaryEngine(storage, mockGenerateFn, mockQueryFn, mockEnrichFn);
    await engine.generate("s1", "uuid-1");

    const ranked = await engine.rankSessions(["s1"], "kubernetes deployment");
    expect(ranked).toEqual([]);
  });

  test("sorts by score descending", async () => {
    const engine = new SummaryEngine(storage, mockGenerateFn, mockQueryFn, mockEnrichFn);
    // mockEntries has: "/users endpoint", "authentication flow", "database schema"
    await engine.generate("s1", "uuid-1");

    // Create session with only one matching entry
    const singleGenerate: GenerateFn = async () => [
      { topic: "database migrations", content: "migration files", addedAt: Date.now() },
    ];
    const singleEngine = new SummaryEngine(storage, singleGenerate, mockQueryFn, mockEnrichFn);
    await singleEngine.generate("s2", "uuid-2");

    const ranked = await engine.rankSessions(["s1", "s2"], "database schema");

    expect(ranked.length).toBe(2);
    expect(ranked[0]!.sessionId).toBe("s1"); // "database schema" matches topic
    expect(ranked[1]!.sessionId).toBe("s2"); // "database" matches "database migrations"
  });

  test("skips sessions without summaries", async () => {
    const engine = new SummaryEngine(storage, mockGenerateFn, mockQueryFn, mockEnrichFn);
    await engine.generate("s1", "uuid-1");
    // s2 has no summary

    const ranked = await engine.rankSessions(["s1", "s2"], "users endpoint");
    expect(ranked.length).toBe(1);
    expect(ranked[0]!.sessionId).toBe("s1");
  });
});

describe("SummaryEngine - persistence", () => {
  test("summary survives write-read cycle", async () => {
    const engine1 = new SummaryEngine(storage, mockGenerateFn, mockQueryFn, mockEnrichFn);
    await engine1.generate("s1", "claude-uuid-1");

    const engine2 = new SummaryEngine(storage, mockGenerateFn, mockQueryFn, mockEnrichFn);
    const summary = await engine2.getSummary("s1");

    expect(summary).not.toBeNull();
    expect(summary!.sessionId).toBe("s1");
    expect(summary!.entries.length).toBe(3);
  });
});
