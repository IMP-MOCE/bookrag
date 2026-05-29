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

describe("KnowledgeBase — works & chapters", () => {
  it("creates work and chapter, returns same chapter on identical re-add", async () => {
    const work = await kb.createWork({ title: "Северный род", siteUrl: "https://example.test/x" });
    expect(work.id).toMatch(/^work_/);

    const ch = await kb.addChapter({
      workId: work.id,
      number: 1,
      title: "Глава 1",
      url: "https://example.test/x/1",
      text: "Текст главы.",
    });
    expect(ch.contentHash).toHaveLength(64);

    const again = await kb.addChapter({
      workId: work.id,
      number: 1,
      title: "Глава 1",
      url: "https://example.test/x/1",
      text: "Текст главы.",
    });
    expect(again.id).toBe(ch.id);
  });

  it("re-adding same chapter number with new text updates contentHash", async () => {
    const work = await kb.createWork({ title: "T", siteUrl: "https://t.test" });
    const c1 = await kb.addChapter({
      workId: work.id,
      number: 5,
      title: "x",
      url: "u",
      text: "v1",
    });
    const c2 = await kb.addChapter({
      workId: work.id,
      number: 5,
      title: "x",
      url: "u",
      text: "v2",
    });
    expect(c2.id).toBe(c1.id);
    expect(c2.contentHash).not.toBe(c1.contentHash);
  });
});

describe("KnowledgeBase.applyOperations", () => {
  it("creates character, alias, event and resolves tempId references", async () => {
    const work = await kb.createWork({ title: "Северный род", siteUrl: "https://x.test" });
    const ch = await kb.addChapter({
      workId: work.id,
      number: 12,
      title: "Дуэль",
      url: "u",
      text: "Алексей Волков шагнул вперёд.",
    });

    const ops: Operation[] = [
      {
        kind: "create_character",
        tempId: "tmp:1",
        name: "Алексей Волков",
        aliases: ["Лёша", "князь Волков"],
        summary: "Наследник северного рода.",
        evidence: "Алексей Волков шагнул вперёд.",
        confidence: 0.86,
      },
      {
        kind: "create_chapter_summary",
        summary: "Алексей Волков сразился на дуэли с противником.",
        charactersPresent: ["tmp:1"],
        locationsPresent: [],
        artifactsMentioned: [],
        keyEventsOneline: ["дуэль"],
        evidence: "шагнул вперёд",
        confidence: 0.9,
      },
    ];

    const res = await kb.applyOperations({
      workId: work.id,
      chapterId: ch.id,
      chapterNumber: ch.number,
      operations: ops,
    });
    expect(res.applied).toBe(2);
    expect(res.skipped).toBe(0);

    const charId = res.tempIdMap["tmp:1"];
    expect(charId).toBeTruthy();
    const card = await kb.getCharacter(charId!);
    expect(card?.name).toBe("Алексей Волков");
    expect(card?.aliases).toContain("Лёша");
    expect(card?.keys).toContain("алексей волков");
    expect(card?.keys).toContain("волков"); // после стрипа титула "князь"

    const summaries = await kb.listChapterSummaries(work.id);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.charactersPresent).toEqual([charId]);

    // v4: create_character + create_chapter_summary в одной главе → одно появление.
    expect(card!.appearanceCount).toBe(1);
    expect(card!.appearances).toEqual([12]);
    expect(card!.firstSeenChapter).toBe(12);
    expect(card!.lastUpdatedChapter).toBe(12);
  });

  it("appearance counter растёт при появлении персонажа в новой главе и idempotent на повторном apply", async () => {
    const work = await kb.createWork({ title: "T", siteUrl: "https://t.test" });
    const ch1 = await kb.addChapter({
      workId: work.id,
      number: 1,
      title: "гл1",
      url: "u1",
      text: "Алексей.",
    });
    const seed = await kb.applyOperations({
      workId: work.id,
      chapterId: ch1.id,
      chapterNumber: 1,
      operations: [
        {
          kind: "create_character",
          tempId: "tmp:1",
          name: "Алексей",
          aliases: [],
          summary: "",
          evidence: "e",
          confidence: 0.9,
        },
        {
          kind: "create_chapter_summary",
          summary: "Гл1.",
          charactersPresent: ["tmp:1"],
          locationsPresent: [],
          artifactsMentioned: [],
          keyEventsOneline: [],
          evidence: "e",
          confidence: 0.8,
        },
      ],
    });
    const charId = seed.tempIdMap["tmp:1"]!;

    // Повторный apply ТОЙ ЖЕ главы: счётчик не должен расти (idempotent).
    await kb.applyOperations({
      workId: work.id,
      chapterId: ch1.id,
      chapterNumber: 1,
      operations: [
        {
          kind: "create_character",
          tempId: "tmp:1",
          name: "Алексей",
          aliases: [],
          summary: "",
          evidence: "e",
          confidence: 0.9,
        },
        {
          kind: "create_chapter_summary",
          summary: "Гл1 v2.",
          charactersPresent: [charId],
          locationsPresent: [],
          artifactsMentioned: [],
          keyEventsOneline: [],
          evidence: "e",
          confidence: 0.8,
        },
      ],
    });
    let card = await kb.getCharacter(charId);
    expect(card!.appearanceCount).toBe(1);
    expect(card!.appearances).toEqual([1]);

    // Глава 2 с тем же персонажем (canonical id) → счётчик 2, lastUpdatedChapter=2.
    const ch2 = await kb.addChapter({
      workId: work.id,
      number: 2,
      title: "гл2",
      url: "u2",
      text: "Алексей снова.",
    });
    await kb.applyOperations({
      workId: work.id,
      chapterId: ch2.id,
      chapterNumber: 2,
      operations: [
        {
          kind: "create_chapter_summary",
          summary: "Гл2.",
          charactersPresent: [charId],
          locationsPresent: [],
          artifactsMentioned: [],
          keyEventsOneline: [],
          evidence: "e",
          confidence: 0.8,
        },
      ],
    });
    card = await kb.getCharacter(charId);
    expect(card!.appearanceCount).toBe(2);
    expect(card!.appearances).toEqual([1, 2]);
    expect(card!.firstSeenChapter).toBe(1);
    expect(card!.lastUpdatedChapter).toBe(2);
  });

  it("appearance counter работает для location и artifact", async () => {
    const work = await kb.createWork({ title: "T", siteUrl: "https://t.test" });
    const ch1 = await kb.addChapter({
      workId: work.id,
      number: 1,
      title: "x",
      url: "u",
      text: ".",
    });
    const seed = await kb.applyOperations({
      workId: work.id,
      chapterId: ch1.id,
      chapterNumber: 1,
      operations: [
        {
          kind: "create_location",
          tempId: "tmp:l",
          name: "Северный лес",
          summary: "",
          evidence: "e",
          confidence: 0.9,
        },
        {
          kind: "create_artifact",
          tempId: "tmp:a",
          name: "Меч",
          summary: "",
          evidence: "e",
          confidence: 0.9,
        },
        {
          kind: "create_chapter_summary",
          summary: "Гл1.",
          charactersPresent: [],
          locationsPresent: ["tmp:l"],
          artifactsMentioned: ["tmp:a"],
          keyEventsOneline: [],
          evidence: "e",
          confidence: 0.8,
        },
      ],
    });
    const locId = seed.tempIdMap["tmp:l"]!;
    const artId = seed.tempIdMap["tmp:a"]!;

    const ch2 = await kb.addChapter({
      workId: work.id,
      number: 5,
      title: "x",
      url: "u2",
      text: ".",
    });
    await kb.applyOperations({
      workId: work.id,
      chapterId: ch2.id,
      chapterNumber: 5,
      operations: [
        {
          kind: "create_chapter_summary",
          summary: "Гл5.",
          charactersPresent: [],
          locationsPresent: [locId],
          artifactsMentioned: [artId],
          keyEventsOneline: [],
          evidence: "e",
          confidence: 0.8,
        },
      ],
    });

    const locs = await kb.listLocations(work.id);
    const arts = await kb.listArtifacts(work.id);
    expect(locs[0]!.appearances).toEqual([1, 5]);
    expect(locs[0]!.appearanceCount).toBe(2);
    expect(locs[0]!.lastUpdatedChapter).toBe(5);
    expect(arts[0]!.appearances).toEqual([1, 5]);
    expect(arts[0]!.appearanceCount).toBe(2);
    expect(arts[0]!.lastUpdatedChapter).toBe(5);
  });

  it("is idempotent: re-applying same ops adds nothing", async () => {
    const work = await kb.createWork({ title: "T", siteUrl: "https://t.test" });
    const ch = await kb.addChapter({
      workId: work.id,
      number: 1,
      title: "x",
      url: "u",
      text: "Алексей.",
    });
    const ops: Operation[] = [
      {
        kind: "create_character",
        tempId: "tmp:1",
        name: "Алексей",
        aliases: [],
        summary: "s",
        evidence: "Алексей",
        confidence: 0.8,
      },
      {
        kind: "update_character",
        targetId: "tmp:1",
        field: "summary",
        newValue: "обновлено",
        evidence: "e",
        confidence: 0.7,
      },
    ];

    const r1 = await kb.applyOperations({
      workId: work.id,
      chapterId: ch.id,
      chapterNumber: 1,
      operations: ops,
    });
    expect(r1.applied).toBe(2);

    const r2 = await kb.applyOperations({
      workId: work.id,
      chapterId: ch.id,
      chapterNumber: 1,
      operations: ops,
    });
    // Создание персонажа дедуплицируется по нормализованному имени, апдейт — по равенству поля.
    expect(r2.applied).toBe(0);
    expect(r2.skipped).toBe(2);

    const chars = await kb.listCharacters(work.id);
    expect(chars).toHaveLength(1);
  });

  it("skips add_alias when alias is already covered by name keys", async () => {
    const work = await kb.createWork({ title: "T", siteUrl: "https://t.test" });
    const ch = await kb.addChapter({ workId: work.id, number: 1, title: "x", url: "u", text: "." });
    const seed = await kb.applyOperations({
      workId: work.id,
      chapterId: ch.id,
      chapterNumber: 1,
      operations: [
        {
          kind: "create_character",
          tempId: "tmp:1",
          name: "Савва Бурый",
          aliases: [],
          summary: "",
          evidence: "Савва Бурый",
          confidence: 0.9,
        },
      ],
    });
    const charId = seed.tempIdMap["tmp:1"]!;

    const res = await kb.applyOperations({
      workId: work.id,
      chapterId: ch.id,
      chapterNumber: 2,
      operations: [
        {
          kind: "add_alias",
          targetId: charId,
          alias: "Савва",
          evidence: "Савва шёл впереди",
          confidence: 0.92,
        },
        {
          kind: "add_alias",
          targetId: charId,
          alias: "Бурый Лис",
          evidence: "Бурый Лис улыбнулся",
          confidence: 0.92,
        },
      ],
    });

    expect(res.applied).toBe(1);
    expect(res.skipped).toBe(1);
    const card = await kb.getCharacter(charId);
    expect(card?.aliases).not.toContain("Савва");
    expect(card?.aliases).toContain("Бурый Лис");
  });

  it("chapter_summary upsert: повторная операция на ту же главу обновляет запись", async () => {
    const work = await kb.createWork({ title: "T", siteUrl: "https://t.test" });
    const ch = await kb.addChapter({
      workId: work.id,
      number: 1,
      title: "x",
      url: "u",
      text: ".",
    });

    await kb.applyOperations({
      workId: work.id,
      chapterId: ch.id,
      chapterNumber: 1,
      operations: [
        {
          kind: "create_chapter_summary",
          summary: "Первая версия резюме.",
          charactersPresent: [],
          locationsPresent: [],
          artifactsMentioned: [],
          keyEventsOneline: ["событие А"],
          evidence: "ev",
          confidence: 0.8,
        },
      ],
    });
    await kb.applyOperations({
      workId: work.id,
      chapterId: ch.id,
      chapterNumber: 1,
      operations: [
        {
          kind: "create_chapter_summary",
          summary: "Вторая версия резюме.",
          charactersPresent: [],
          locationsPresent: [],
          artifactsMentioned: [],
          keyEventsOneline: ["событие Б"],
          evidence: "ev",
          confidence: 0.9,
        },
      ],
    });

    const summaries = await kb.listChapterSummaries(work.id);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.summary).toBe("Вторая версия резюме.");
    expect(summaries[0]!.keyEventsOneline).toEqual(["событие Б"]);
  });
});

describe("KnowledgeBase.searchByKey & buildContextForAnalysis", () => {
  it("searches by normalized key and finds character", async () => {
    const work = await kb.createWork({ title: "T", siteUrl: "https://t.test" });
    const ch = await kb.addChapter({
      workId: work.id,
      number: 1,
      title: "x",
      url: "u",
      text: ".",
    });
    await kb.applyOperations({
      workId: work.id,
      chapterId: ch.id,
      chapterNumber: 1,
      operations: [
        {
          kind: "create_character",
          tempId: "tmp:1",
          name: "Алексей Волков",
          aliases: ["Лёша"],
          summary: "",
          evidence: "e",
          confidence: 0.9,
        },
      ],
    });

    const r1 = await kb.searchByKey(work.id, "Лёша");
    expect(r1.characters).toHaveLength(1);
    const r2 = await kb.searchByKey(work.id, "леша"); // ё→е
    expect(r2.characters).toHaveLength(1);
    const r3 = await kb.searchByKey(work.id, "  АЛЕКСЕЙ ВОЛКОВ  ");
    expect(r3.characters).toHaveLength(1);
  });

  it("buildContextForAnalysis returns only entities mentioned in chapter text", async () => {
    const work = await kb.createWork({ title: "T", siteUrl: "https://t.test" });
    const ch = await kb.addChapter({
      workId: work.id,
      number: 1,
      title: "x",
      url: "u",
      text: ".",
    });
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
          summary: "",
          evidence: "e",
          confidence: 0.9,
        },
        {
          kind: "create_character",
          tempId: "tmp:2",
          name: "Мария",
          aliases: [],
          summary: "",
          evidence: "e",
          confidence: 0.9,
        },
        {
          kind: "create_location",
          tempId: "tmp:3",
          name: "Северный лес",
          summary: "",
          evidence: "e",
          confidence: 0.9,
        },
      ],
    });

    const ctx = await kb.buildContextForAnalysis(
      work.id,
      "В этой главе Алексей шёл через северный лес и встретил незнакомца.",
    );
    const names = ctx.characters.map((c) => c.name);
    expect(names).toContain("Алексей");
    expect(names).not.toContain("Мария");
    expect(ctx.locations.map((l) => l.name)).toContain("Северный лес");
  });
});
