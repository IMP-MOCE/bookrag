import { describe, expect, it } from "vitest";
import { levenshtein, similarity } from "@/lib/levenshtein";

describe("levenshtein", () => {
  it("returns 0 for equal strings", () => {
    expect(levenshtein("foo", "foo")).toBe(0);
  });

  it("handles empty strings", () => {
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
    expect(levenshtein("", "")).toBe(0);
  });

  it("counts edits correctly", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("алексей", "алёксей")).toBe(1);
  });
});

describe("similarity", () => {
  it("returns 1 for equal strings", () => {
    expect(similarity("foo", "foo")).toBe(1);
  });

  it("returns 0 for completely different strings of same length", () => {
    expect(similarity("abc", "xyz")).toBe(0);
  });

  it("scales between 0 and 1", () => {
    const s = similarity("волков", "волковский");
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
  });
});
