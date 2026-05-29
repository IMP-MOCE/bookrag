import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CollisionResolver, scorePair } from "@/kb/CollisionResolver";
import { KnowledgeBase } from "@/kb/KnowledgeBase";
import type { Operation } from "@/kb/operations";
import { buildKeys, normalizeAlias } from "@/lib/normalize";

function makeCandidate(name: string, aliases: string[]) {
  return {
    name,
    normalizedName: normalizeAlias(name),
    aliases,
    keys: buildKeys(name, aliases),
  };
}

describe("scorePair (pure)", () => {
  it("gives 1.0 on exact normalized name match", () => {
    const r = scorePair(makeCandidate("Алексей", []), { name: "АЛЕКСЕЙ" });
    expect(r.score).toBe(1.0);
    expect(r.features).toContain("exact_name");
  });

  it("scores high when draft name matches existing alias", () => {
    const r = scorePair(makeCandidate("Алексей Волков", ["Лёша"]), { name: "Лёша" });
    expect(r.score).toBeGreaterThanOrEqual(0.9);
    expect(r.features.some((f) => f.includes("alias"))).toBe(true);
  });

  it("matches by stripped-titles key overlap («князь Волков» ↔ «Алексей Волков»)", () => {
    const r = scorePair(makeCandidate("Алексей Волков", []), { name: "князь Волков" });
    expect(r.score).toBeGreaterThanOrEqual(0.85);
    expect(r.features.some((f) => f.includes("key_overlap"))).toBe(true);
  });

  it("returns low score for unrelated names", () => {
    const r = scorePair(makeCandidate("Алексей Волков", ["Лёша"]), { name: "Мария" });
    expect(r.score).toBeLessThan(0.6);
  });

  it("blends llmHint into the score", () => {
    const baseline = scorePair(makeCandidate("Иван Петров", []), { name: "Петя" });
    const withHint = scorePair(makeCandidate("Иван Петров", []), { name: "Петя" }, 0.85);
    expect(withHint.score).toBeGreaterThan(baseline.score);
    expect(withHint.features.some((f) => f.startsWith("llm_hint"))).toBe(true);
  });

  it("fuzzy match catches one-letter typos but caps below auto-merge threshold", () => {
    const r = scorePair(makeCandidate("Алексей", []), { name: "Алексий" });
    expect(r.score).toBeGreaterThanOrEqual(0.7);
    expect(r.score).toBeLessThan(0.9);
  });
});

describe("CollisionResolver.planForOperations", () => {
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

  async function seedCharacter(workId: string, chapterId: string, name: string, aliases: string[]) {
    const res = await kb.applyOperations({
      workId,
      chapterId,
      chapterNumber: 1,
      operations: [
        {
          kind: "create_character",
          tempId: "tmp:seed",
          name,
          aliases,
          summary: "",
          evidence: name,
          confidence: 0.9,
        },
      ],
    });
    return res.tempIdMap["tmp:seed"]!;
  }

  it("auto-merges high-score draft and remaps subsequent op references", async () => {
    const work = await kb.createWork({ title: "T", siteUrl: "https://t.test" });
    const ch = await kb.addChapter({ workId: work.id, number: 1, title: "x", url: "u", text: "." });
    const existingId = await seedCharacter(work.id, ch.id, "Алексей Волков", ["Лёша"]);

    const resolver = new CollisionResolver(kb);
    const ops: Operation[] = [
      {
        kind: "create_character",
        tempId: "tmp:1",
        name: "Лёша", // alias_match → score ≥ 0.9 → auto_merge
        aliases: ["Алексей"],
        summary: "",
        evidence: "Лёша",
        confidence: 0.9,
      },
      {
        kind: "create_chapter_summary",
        summary: "Глава начинается с появления Лёши на дуэли.",
        charactersPresent: ["tmp:1"], // должно резолвнуться в existingId
        locationsPresent: [],
        artifactsMentioned: [],
        keyEventsOneline: ["дуэль"],
        evidence: "duel",
        confidence: 0.9,
      },
    ];

    const plan = await resolver.planForOperations(work.id, ops);
    expect(plan.autoMergeMap["tmp:1"]).toBe(existingId);
    expect(plan.pendingReviews).toHaveLength(0);
    // create_character убран: "Лёша" уже alias, а "Алексей" уже ключ имени
    // "Алексей Волков", поэтому новый alias не нужен.
    expect(plan.rewrittenOps.find((o) => o.kind === "create_character")).toBeUndefined();
    const aliasOp = plan.rewrittenOps.find((o) => o.kind === "add_alias");
    expect(aliasOp).toBeUndefined();
    // chapter_summary.charactersPresent[0] резолвнулся в existingId.
    const summaryOp = plan.rewrittenOps.find((o) => o.kind === "create_chapter_summary");
    if (summaryOp && summaryOp.kind === "create_chapter_summary") {
      expect(summaryOp.charactersPresent[0]).toBe(existingId);
    }
  });

  it("enqueues manual_review when score lands in mid range", async () => {
    const work = await kb.createWork({ title: "T", siteUrl: "https://t.test" });
    const ch = await kb.addChapter({ workId: work.id, number: 1, title: "x", url: "u", text: "." });
    await seedCharacter(work.id, ch.id, "Алексей", []);

    const resolver = new CollisionResolver(kb);
    const ops: Operation[] = [
      {
        kind: "create_character",
        tempId: "tmp:new",
        name: "Алексий", // fuzzy ~0.85 cap → manual_review
        aliases: [],
        summary: "",
        evidence: "Алексий",
        confidence: 0.8,
      },
    ];

    const plan = await resolver.planForOperations(work.id, ops);
    expect(plan.autoMergeMap).toEqual({});
    expect(plan.pendingReviews).toHaveLength(1);
    expect(plan.pendingReviews[0]!.newCharacterTempId).toBe("tmp:new");
    expect(plan.rewrittenOps[0]!.kind).toBe("create_character");
  });

  it("creates separately when no candidate matches", async () => {
    const work = await kb.createWork({ title: "T", siteUrl: "https://t.test" });
    const ch = await kb.addChapter({ workId: work.id, number: 1, title: "x", url: "u", text: "." });
    await seedCharacter(work.id, ch.id, "Иван", []);

    const resolver = new CollisionResolver(kb);
    const ops: Operation[] = [
      {
        kind: "create_character",
        tempId: "tmp:new",
        name: "Мария",
        aliases: [],
        summary: "",
        evidence: "Мария",
        confidence: 0.9,
      },
    ];
    const plan = await resolver.planForOperations(work.id, ops);
    expect(plan.autoMergeMap).toEqual({});
    expect(plan.pendingReviews).toHaveLength(0);
    expect(plan.rewrittenOps).toHaveLength(1);
  });

  it("uses llmHint to upgrade decision into review/auto", async () => {
    const work = await kb.createWork({ title: "T", siteUrl: "https://t.test" });
    const ch = await kb.addChapter({ workId: work.id, number: 1, title: "x", url: "u", text: "." });
    await seedCharacter(work.id, ch.id, "Алексей", []);

    const resolver = new CollisionResolver(kb);
    const ops: Operation[] = [
      {
        kind: "create_character",
        tempId: "tmp:n",
        name: "Молодой человек",
        aliases: [],
        summary: "",
        evidence: ".",
        confidence: 0.8,
      },
    ];
    // С хинтом 0.85 → должно подняться в auto_merge или хотя бы review.
    const plan = await resolver.planForOperations(work.id, ops, new Map([["tmp:n", 0.85]]));
    const totalActions =
      Object.keys(plan.autoMergeMap).length + plan.pendingReviews.length;
    expect(totalActions).toBeGreaterThanOrEqual(1);
  });
});
