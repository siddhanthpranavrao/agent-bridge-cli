import { describe, test, expect } from "bun:test";
import { levenshteinDistance, fuzzyMatch } from "../../src/utils/fuzzy.ts";

describe("levenshteinDistance", () => {
  test("identical strings have distance 0", () => {
    expect(levenshteinDistance("hello", "hello")).toBe(0);
  });

  test("single character insertion has distance 1", () => {
    expect(levenshteinDistance("cat", "cats")).toBe(1);
  });

  test("single character deletion has distance 1", () => {
    expect(levenshteinDistance("cats", "cat")).toBe(1);
  });

  test("single character substitution has distance 1", () => {
    expect(levenshteinDistance("cat", "car")).toBe(1);
  });

  test("transposition has distance 2", () => {
    expect(levenshteinDistance("ab", "ba")).toBe(2);
  });

  test("completely different strings have large distance", () => {
    expect(levenshteinDistance("abc", "xyz")).toBe(3);
  });

  test("empty string vs non-empty returns length", () => {
    expect(levenshteinDistance("", "hello")).toBe(5);
    expect(levenshteinDistance("hello", "")).toBe(5);
  });

  test("both empty strings have distance 0", () => {
    expect(levenshteinDistance("", "")).toBe(0);
  });

  test("is case-insensitive", () => {
    expect(levenshteinDistance("Hello", "hello")).toBe(0);
    expect(levenshteinDistance("BACKEND", "backend")).toBe(0);
  });

  test("handles multi-word strings", () => {
    expect(levenshteinDistance("backend-api", "backend-aip")).toBe(2);
  });
});

describe("fuzzyMatch", () => {
  const candidates = ["backend", "frontend", "database", "auth-service"];

  test("returns exact match", () => {
    expect(fuzzyMatch("backend", candidates)).toBe("backend");
  });

  test("returns closest match within distance", () => {
    expect(fuzzyMatch("bakend", candidates)).toBe("backend");
  });

  test("returns closest match for typo", () => {
    expect(fuzzyMatch("frntend", candidates)).toBe("frontend");
  });

  test("returns null when all candidates exceed maxDistance", () => {
    expect(fuzzyMatch("zzzzzzz", candidates)).toBeNull();
  });

  test("returns null for empty candidates", () => {
    expect(fuzzyMatch("backend", [])).toBeNull();
  });

  test("respects custom maxDistance", () => {
    // "bkend" -> "backend" is distance 2 (missing 'a' and 'c')
    expect(fuzzyMatch("bkend", candidates, 1)).toBeNull();
    expect(fuzzyMatch("bkend", candidates, 2)).toBe("backend");
  });

  test("picks the closest when multiple are within range", () => {
    expect(fuzzyMatch("backend", ["backen", "backnd", "xyz"])).toBe("backen");
  });

  test("is case-insensitive", () => {
    expect(fuzzyMatch("BACKEND", candidates)).toBe("backend");
  });
});
