import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KnowledgeBase } from "@/kb/KnowledgeBase";
import type { Operation } from "@/kb/operations";

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

async function seedTwoCharacters(): Promise<{
  workId: string;
  chapterId: string;
  primaryId: string;
  secondaryId: string;
}> {
  const work = await kb.createWork({ title: "T", siteUrl: "https://t.test" });
  const ch = await kb.addChapter({ workId: work.id, number: 1, title: "x", url: "u", text: "." });
  const ops: Operation[] = [
    {
      kind: "create_character",
      tempId: "tmp:a",
      name: "Алексей Волков",
      aliases: ["Лёша"],
      summary: "Главный герой",
      evidence: "Алексей",
      confidence: 0.9,
    },
    {
      kind: "create_character",
      tempId: "tmp:b",
      name: "князь Волков",
      aliases: ["А. Волков"],
      summary: "Загадочный аристократ",
      evidence: "князь",
      confidence: 0.7,
    },
  ];
  const res = await kb.applyOperations({
    workId: work.id,
    chapterId: ch.id,
    chapterNumber: 1,
    operations: ops,
  });
  return {
    workId: work.id,
    chapterId: ch.id,
    primaryId: res.tempIdMap["tmp:a"]!,
    secondaryId: res.tempIdMap["tmp:b"]!,
  };
}

describe("KnowledgeBase.mergeCharacters", () => {
  it("merges aliases, keys, summary; deletes secondary", async () => {
    const { workId, chapterId, primaryId, secondaryId } = await seedTwoCharacters();
    await kb.enqueueReview({
      workId,
      chapterId,
      newCharacterId: secondaryId,
      candidateId: primaryId,
      score: 0.88,
      features: ["same-name"],
    });

    await kb.mergeCharacters({
      workId,
      primaryId,
      secondaryId,
      reason: "Same person under different titles",
    });

    const primary = await kb.getCharacter(primaryId);
    const secondary = await kb.getCharacter(secondaryId);

    expect(secondary).toBeUndefined();
    expect(primary!.aliases).toContain("Лёша");
    expect(primary!.aliases).toContain("А. Волков");
    expect(primary!.aliases).not.toContain("князь Волков");
    expect(primary!.keys).toContain("волков");
    expect(primary!.summary).toContain("Главный герой");
    expect(primary!.summary).toContain("Загадочный");
    expect(primary!.history.some((h) => h.operation === "merged")).toBe(true);
    expect(await kb.listPendingReviews(workId)).toHaveLength(0);
  });

  it("redirects relationships and dedupes against existing edges", async () => {
    const { workId, chapterId, primaryId, secondaryId } = await seedTwoCharacters();

    // Создадим Марию и две связи: primary→Мария (brother), secondary→Мария (brother).
    const seed = await kb.applyOperations({
      workId,
      chapterId,
      chapterNumber: 1,
      operations: [
        {
          kind: "create_character",
          tempId: "tmp:m",
          name: "Мария",
          aliases: [],
          summary: "",
          evidence: "Мария",
          confidence: 0.9,
        },
      ],
    });
    void seed;

    // FTv6: relationships удалены. Их семантика «X — брат Y» теперь либо в role
    // character'а, либо упоминается в chapter_summary.summary текстом. mergeCharacters
    // больше не должен трогать relationships store (он удалён в DB_VERSION=3).
    await kb.mergeCharacters({ workId, primaryId, secondaryId, reason: "test" });

    const primary = await kb.getCharacter(primaryId);
    const secondaryAfter = await kb.getCharacter(secondaryId);
    expect(primary).toBeDefined();
    expect(secondaryAfter).toBeUndefined(); // удалён при merge
  });

  it("unions appearances without duplicates and recomputes counters", async () => {
    const { workId, chapterId, primaryId, secondaryId } = await seedTwoCharacters();

    // primary упомянут в гл.1 (через seedTwoCharacters создал summary в seed?
    // Нет — seedTwoCharacters только create_character. Добавим явно chapter_summary
    // на гл.1 с обоими, плюс гл.3 только с secondary, плюс гл.5 только с primary.
    await kb.applyOperations({
      workId,
      chapterId,
      chapterNumber: 1,
      operations: [
        {
          kind: "create_chapter_summary",
          summary: "Гл1.",
          charactersPresent: [primaryId, secondaryId],
          locationsPresent: [],
          artifactsMentioned: [],
          keyEventsOneline: [],
          evidence: "e",
          confidence: 0.8,
        },
      ],
    });
    const ch3 = await kb.addChapter({
      workId,
      number: 3,
      title: "3",
      url: "u3",
      text: ".",
    });
    await kb.applyOperations({
      workId,
      chapterId: ch3.id,
      chapterNumber: 3,
      operations: [
        {
          kind: "create_chapter_summary",
          summary: "Гл3.",
          charactersPresent: [secondaryId],
          locationsPresent: [],
          artifactsMentioned: [],
          keyEventsOneline: [],
          evidence: "e",
          confidence: 0.8,
        },
      ],
    });
    const ch5 = await kb.addChapter({
      workId,
      number: 5,
      title: "5",
      url: "u5",
      text: ".",
    });
    await kb.applyOperations({
      workId,
      chapterId: ch5.id,
      chapterNumber: 5,
      operations: [
        {
          kind: "create_chapter_summary",
          summary: "Гл5.",
          charactersPresent: [primaryId],
          locationsPresent: [],
          artifactsMentioned: [],
          keyEventsOneline: [],
          evidence: "e",
          confidence: 0.8,
        },
      ],
    });

    await kb.mergeCharacters({
      workId,
      primaryId,
      secondaryId,
      reason: "merge appearances test",
    });
    const merged = await kb.getCharacter(primaryId);
    // primary был в [1, 5], secondary в [1, 3] → union [1, 3, 5], count=3.
    expect(merged!.appearances).toEqual([1, 3, 5]);
    expect(merged!.appearanceCount).toBe(3);
    expect(merged!.firstSeenChapter).toBe(1);
    expect(merged!.lastUpdatedChapter).toBe(5);
  });

  it("redirects chapter_summary.charactersPresent to primary id", async () => {
    const { workId, chapterId, primaryId, secondaryId } = await seedTwoCharacters();

    await kb.applyOperations({
      workId,
      chapterId,
      chapterNumber: 1,
      operations: [
        {
          kind: "create_chapter_summary",
          summary: "В главе появился secondary и устроил дуэль.",
          charactersPresent: [secondaryId],
          locationsPresent: [],
          artifactsMentioned: [],
          keyEventsOneline: ["дуэль"],
          evidence: "duel",
          confidence: 0.9,
        },
      ],
    });

    await kb.mergeCharacters({ workId, primaryId, secondaryId, reason: "test" });
    const summaries = await kb.listChapterSummaries(workId);
    expect(summaries[0]!.charactersPresent).toEqual([primaryId]);
  });

  it("rejects cross-work merge", async () => {
    const { workId: w1, primaryId } = await seedTwoCharacters();
    const w2 = await kb.createWork({ title: "Other", siteUrl: "https://o.test" });
    const ch2 = await kb.addChapter({ workId: w2.id, number: 1, title: "x", url: "u", text: "." });
    const seed = await kb.applyOperations({
      workId: w2.id,
      chapterId: ch2.id,
      chapterNumber: 1,
      operations: [
        {
          kind: "create_character",
          tempId: "tmp:x",
          name: "X",
          aliases: [],
          summary: "",
          evidence: "x",
          confidence: 0.9,
        },
      ],
    });
    const otherId = seed.tempIdMap["tmp:x"]!;
    await expect(
      kb.mergeCharacters({ workId: w1, primaryId, secondaryId: otherId, reason: "x" }),
    ).rejects.toThrow();
  });
});

describe("KnowledgeBase review queue", () => {
  it("enqueues, lists pending and resolves review", async () => {
    const work = await kb.createWork({ title: "T", siteUrl: "https://t.test" });
    const ch = await kb.addChapter({ workId: work.id, number: 1, title: "x", url: "u", text: "." });
    const seed = await kb.applyOperations({
      workId: work.id,
      chapterId: ch.id,
      chapterNumber: 1,
      operations: [
        {
          kind: "create_character",
          tempId: "tmp:a",
          name: "A",
          aliases: [],
          summary: "",
          evidence: "a",
          confidence: 0.9,
        },
        {
          kind: "create_character",
          tempId: "tmp:b",
          name: "B",
          aliases: [],
          summary: "",
          evidence: "b",
          confidence: 0.9,
        },
      ],
    });
    const aId = seed.tempIdMap["tmp:a"]!;
    const bId = seed.tempIdMap["tmp:b"]!;

    const review = await kb.enqueueReview({
      workId: work.id,
      chapterId: ch.id,
      newCharacterId: bId,
      candidateId: aId,
      score: 0.78,
      features: ["fuzzy:0.82"],
      llmHint: 0.7,
    });

    let pending = await kb.listPendingReviews(work.id);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe(review.id);

    await kb.resolveReview(review.id, { status: "kept_separate", note: "Это другой персонаж" });
    pending = await kb.listPendingReviews(work.id);
    expect(pending).toHaveLength(0);
  });
});

describe("KnowledgeBase manual character editing", () => {
  it("updates editable fields, normalizes aliases and appends history", async () => {
    const { workId, primaryId } = await seedTwoCharacters();

    const updated = await kb.updateCharacter(workId, primaryId, {
      name: "Алекс Азаров",
      aliases: ["Светлый", "Алекс Азаров", "  ", "Светлый"],
      summary: "Ходит в светлой рубашке.",
      role: "ученик",
      status: "жив",
      confidence: 1.4,
    });

    expect(updated.name).toBe("Алекс Азаров");
    expect(updated.normalizedName).toBe("алекс азаров");
    expect(updated.aliases).toEqual(["Светлый"]);
    expect(updated.keys).toContain("алекс азаров");
    expect(updated.keys).toContain("светлый");
    expect(updated.summary).toBe("Ходит в светлой рубашке.");
    expect(updated.role).toBe("ученик");
    expect(updated.status).toBe("жив");
    expect(updated.confidence).toBe(1);
    expect(updated.history.some((entry) => entry.operation === "manual_edit" && entry.field === "name")).toBe(true);

    const searched = await kb.searchByKey(workId, "Светлый");
    expect(searched.characters.map((c) => c.id)).toContain(primaryId);
  });

  it("deletes a character and removes dependent references", async () => {
    const { workId, chapterId, primaryId, secondaryId } = await seedTwoCharacters();
    const seed = await kb.applyOperations({
      workId,
      chapterId,
      chapterNumber: 1,
      operations: [
        {
          kind: "create_chapter_summary",
          summary: "Primary встретился с secondary в библиотеке.",
          charactersPresent: [primaryId, secondaryId],
          locationsPresent: [],
          artifactsMentioned: [],
          keyEventsOneline: ["встреча"],
          evidence: "встреча",
          confidence: 0.8,
        },
      ],
    });
    expect(seed.applied).toBe(1);
    await kb.enqueueReview({
      workId,
      chapterId,
      newCharacterId: secondaryId,
      candidateId: primaryId,
      score: 0.81,
      features: ["manual"],
    });

    await kb.deleteCharacter(workId, secondaryId);

    expect(await kb.getCharacter(secondaryId)).toBeUndefined();
    // FTv6: chapter_summary.charactersPresent очищается от удалённого id.
    const summaries = await kb.listChapterSummaries(workId);
    expect(summaries[0]!.charactersPresent).toEqual([primaryId]);
    const evidences = await kb["db"].getAllFromIndex("evidences", "by-target", ["character", secondaryId]);
    expect(evidences).toHaveLength(0);
    expect(await kb.listPendingReviews(workId)).toHaveLength(0);
  });
});
