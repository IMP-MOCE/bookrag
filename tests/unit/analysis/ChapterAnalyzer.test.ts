import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChapterAnalyzer, type AnalysisLLMClient } from "@/analysis/ChapterAnalyzer";
import { KnowledgeBase } from "@/kb/KnowledgeBase";

class FakeLLM implements AnalysisLLMClient {
  public calls: Array<{ messages: ReadonlyArray<{ role: string; content: string }>; opts?: object }> = [];
  constructor(private readonly responses: string[]) {}
  async generate(messages: ReadonlyArray<{ role: "system" | "user" | "assistant"; content: string }>, opts?: object): Promise<string> {
    this.calls.push({ messages, ...(opts ? { opts } : {}) });
    if (this.responses.length === 0) throw new Error("FakeLLM: no more canned responses");
    return this.responses.shift()!;
  }
}

let kb: KnowledgeBase;
let dbName: string;

beforeEach(async () => {
  dbName = `bookrag-test-${crypto.randomUUID()}`;
  kb = await KnowledgeBase.open(dbName);
});
afterEach(() => {
  kb.close();
  indexedDB.deleteDatabase(dbName);
});

describe("ChapterAnalyzer", () => {
  it("analyzes single-chunk chapter and produces operations", async () => {
    const work = await kb.createWork({ title: "T", siteUrl: "https://t.test" });
    const ch = await kb.addChapter({
      workId: work.id,
      number: 12,
      title: "Глава 12",
      url: "u",
      text: "Алексей",
    });

    const cannedResponse = JSON.stringify({
      chapter_id: ch.id,
      new_entities: [
        {
          type: "character",
          temp_id: "e1",
          name: "Алексей Волков",
          aliases: ["Лёша"],
          summary: "Герой",
          evidence: "Алексей Волков",
          confidence: 0.9,
        },
      ],
      operations: [
        {
          type: "create_chapter_summary",
          summary: "Алексей Волков вышел на дуэль с противником.",
          characters_present: ["e1"],
          locations_present: [],
          artifacts_mentioned: [],
          key_events_oneline: ["дуэль"],
          evidence: "Дуэль",
          confidence: 0.85,
        },
      ],
      collision_candidates: [],
    });

    const llm = new FakeLLM([cannedResponse]);
    const analyzer = new ChapterAnalyzer(llm, kb);
    const result = await analyzer.analyze({ chapter: ch, paragraphs: ["Алексей Волков шагнул вперёд."] });

    expect(result.chunkErrors).toHaveLength(0);
    expect(result.operations).toHaveLength(2);
    expect(result.operations[0]!.kind).toBe("create_character");
    expect(result.operations[1]!.kind).toBe("create_chapter_summary");
    if (result.operations[1]!.kind === "create_chapter_summary") {
      // summary.charactersPresent должен ссылаться на наш resolved tempId, не на "e1".
      expect(result.operations[1]!.charactersPresent[0]).not.toBe("e1");
      const charId =
        result.operations[0]!.kind === "create_character" ? result.operations[0]!.tempId : "";
      expect(result.operations[1]!.charactersPresent[0]).toBe(charId);
    }
  });

  it("retries with repair prompt on invalid JSON, succeeds on retry", async () => {
    const work = await kb.createWork({ title: "T", siteUrl: "https://t.test" });
    const ch = await kb.addChapter({ workId: work.id, number: 1, title: "x", url: "u", text: "." });

    const goodResponse = JSON.stringify({
      new_entities: [],
      operations: [],
      collision_candidates: [],
    });
    const llm = new FakeLLM(["this is not json", goodResponse]);
    const analyzer = new ChapterAnalyzer(llm, kb);
    const result = await analyzer.analyze({ chapter: ch, paragraphs: ["hello"] });

    expect(llm.calls).toHaveLength(2);
    // Второй вызов содержит assistant + user(repair).
    expect(llm.calls[1]!.messages[2]!.role).toBe("assistant");
    expect(llm.calls[1]!.messages[3]!.role).toBe("user");
    expect(result.chunkErrors).toHaveLength(0);
    expect(result.rawResponses).toHaveLength(2);
  });

  it("records chunk error after exhausting repair attempts", async () => {
    const work = await kb.createWork({ title: "T", siteUrl: "https://t.test" });
    const ch = await kb.addChapter({ workId: work.id, number: 1, title: "x", url: "u", text: "." });

    const llm = new FakeLLM(["broken", "still broken"]);
    const analyzer = new ChapterAnalyzer(llm, kb, undefined, { maxRepairAttempts: 1 });
    const result = await analyzer.analyze({ chapter: ch, paragraphs: ["hello"] });

    expect(result.chunkErrors).toHaveLength(1);
    expect(result.chunkErrors[0]!.errors.length).toBeGreaterThan(0);
    expect(result.operations).toHaveLength(0);
  });

  it("processes multiple chunks and continues tempId numbering", async () => {
    const work = await kb.createWork({ title: "T", siteUrl: "https://t.test" });
    const ch = await kb.addChapter({ workId: work.id, number: 1, title: "x", url: "u", text: "." });

    const r1 = JSON.stringify({
      new_entities: [{ type: "character", temp_id: "e1", name: "A", evidence: "A", confidence: 0.9 }],
      operations: [],
      collision_candidates: [],
    });
    const r2 = JSON.stringify({
      new_entities: [{ type: "character", temp_id: "e1", name: "B", evidence: "B", confidence: 0.9 }],
      operations: [],
      collision_candidates: [],
    });

    const llm = new FakeLLM([r1, r2]);
    const analyzer = new ChapterAnalyzer(llm, kb, undefined, {
      chunkOptions: { maxChars: 200, overlapParagraphs: 0 },
    });
    // 3 параграфа по 100 символов: первый чанк = [P1, P2] (200 символов = лимит),
    // третий перекидывается в новый чанк = [P3]. Итого ровно 2 чанка.
    const longParagraphs = ["P".repeat(100), "Q".repeat(100), "R".repeat(100)];
    const result = await analyzer.analyze({ chapter: ch, paragraphs: longParagraphs });
    expect(llm.calls).toHaveLength(2);
    expect(result.operations).toHaveLength(2);
    // tempId должны различаться между чанками.
    if (
      result.operations[0]!.kind === "create_character" &&
      result.operations[1]!.kind === "create_character"
    ) {
      expect(result.operations[0]!.tempId).not.toBe(result.operations[1]!.tempId);
    }
  });

  it("includes summarized KB context in user prompt", async () => {
    const work = await kb.createWork({ title: "T", siteUrl: "https://t.test" });
    const ch = await kb.addChapter({ workId: work.id, number: 1, title: "x", url: "u", text: "Алексей" });
    await kb.applyOperations({
      workId: work.id,
      chapterId: ch.id,
      chapterNumber: 1,
      operations: [
        {
          kind: "create_character",
          tempId: "tmp:1",
          name: "Алексей",
          aliases: [],
          summary: "Существующий",
          evidence: "Алексей",
          confidence: 0.9,
        },
      ],
    });

    const goodResponse = JSON.stringify({
      new_entities: [],
      operations: [],
      collision_candidates: [],
    });
    const llm = new FakeLLM([goodResponse]);
    const analyzer = new ChapterAnalyzer(llm, kb);
    await analyzer.analyze({ chapter: ch, paragraphs: ["Алексей шёл по дороге."] });

    const userMsg = llm.calls[0]!.messages.find((m) => m.role === "user")!;
    // Default kbContextMode="light": KB-блок содержит имя + aliases, но НЕ
    // содержит summary/role/status — это компромисс между FAST-EMPTY-safe
    // и surname-collision-mitigation.
    expect(userMsg.content).toContain("Уже встречались персонажи");
    expect(userMsg.content).toContain("Алексей");
    expect(userMsg.content).not.toContain("Существующий"); // summary НЕ утекает
    // chunk text сам остаётся в user prompt — он же главный сигнал.
    expect(userMsg.content).toContain("Алексей шёл по дороге");
  });
});
