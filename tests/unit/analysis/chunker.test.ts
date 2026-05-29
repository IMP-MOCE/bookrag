import { describe, expect, it } from "vitest";
import { chunkParagraphs, joinChunk } from "@/analysis/chunker";

describe("chunkParagraphs", () => {
  it("returns empty array for no paragraphs", () => {
    expect(chunkParagraphs([])).toEqual([]);
  });

  it("returns one chunk when total size below limit", () => {
    const chunks = chunkParagraphs(["a".repeat(100), "b".repeat(100)], {
      maxChars: 1000,
      overlapParagraphs: 1,
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(2);
  });

  it("splits when total size exceeds limit and applies overlap", () => {
    const paras = ["P1".repeat(50), "P2".repeat(50), "P3".repeat(50), "P4".repeat(50)];
    // Каждый параграф = 100 символов; maxChars=200 => после двух параграфов выходим за лимит при добавлении третьего.
    const chunks = chunkParagraphs(paras, { maxChars: 200, overlapParagraphs: 1 });
    expect(chunks.length).toBeGreaterThan(1);
    // Overlap: первый абзац следующего чанка = последний абзац предыдущего.
    expect(chunks[1]![0]).toBe(chunks[0]![chunks[0]!.length - 1]);
  });

  it("emits oversized single paragraph as its own chunk", () => {
    const huge = "X".repeat(10000);
    const chunks = chunkParagraphs([huge], { maxChars: 1000, overlapParagraphs: 1 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]![0]!.length).toBe(10000);
  });

  it("joinChunk uses double newlines", () => {
    expect(joinChunk(["a", "b", "c"])).toBe("a\n\nb\n\nc");
  });
});
