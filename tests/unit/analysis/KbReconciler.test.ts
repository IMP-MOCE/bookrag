// Юнит-тесты для Pass 2 (KbReconciler).
//
// Пускаем настоящий KnowledgeBase (fake-indexeddb), чтобы CollisionResolver и
// listCharacters/listLocations/listArtifacts отрабатывали без моков —
// это даёт реальное поведение нормализации/scorePair. LLM мокается через
// FakeReconcileLLM с canned-ответами.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AnalysisLLMClient } from "@/analysis/ChapterAnalyzer";
import { KbReconciler, ReconcileFailedError } from "@/analysis/KbReconciler";
import { KnowledgeBase } from "@/kb/KnowledgeBase";
import type { Operation } from "@/kb/operations";

class FakeReconcileLLM implements AnalysisLLMClient {
  public calls: Array<{ messages: ReadonlyArray<{ role: string; content: string }>; opts?: object }> = [];
  constructor(private readonly responses: string[]) {}
  async generate(
    messages: ReadonlyArray<{ role: "system" | "user" | "assistant"; content: string }>,
    opts?: object,
  ): Promise<string> {
    this.calls.push({ messages, ...(opts ? { opts } : {}) });
    if (this.responses.length === 0) {
      throw new Error("FakeReconcileLLM: no canned responses left");
    }
    return this.responses.shift()!;
  }
}

let kb: KnowledgeBase;
let dbName: string;
let workId: string;
let chapterId: string;

beforeEach(async () => {
  dbName = `bookrag-test-reconciler-${crypto.randomUUID()}`;
  kb = await KnowledgeBase.open(dbName);
  const work = await kb.createWork({ title: "Test", siteUrl: "https://t.test" });
  workId = work.id;
  const ch = await kb.addChapter({
    workId,
    number: 1,
    title: "ch1",
    url: "u",
    text: "seed",
  });
  chapterId = ch.id;
});
afterEach(() => {
  kb.close();
  indexedDB.deleteDatabase(dbName);
});

// ---------- Хелперы ----------

async function seedCharacter(name: string, aliases: string[] = [], summary = "seed"): Promise<string> {
  const res = await kb.applyOperations({
    workId,
    chapterId,
    chapterNumber: 1,
    operations: [
      {
        kind: "create_character",
        tempId: `tmp:seed:${name}`,
        name,
        aliases,
        summary,
        evidence: name,
        confidence: 0.9,
      },
    ],
  });
  return res.tempIdMap[`tmp:seed:${name}`]!;
}

async function seedLocation(name: string): Promise<string> {
  const res = await kb.applyOperations({
    workId,
    chapterId,
    chapterNumber: 1,
    operations: [
      {
        kind: "create_location",
        tempId: `tmp:loc:${name}`,
        name,
        summary: "seed",
        evidence: name,
        confidence: 0.9,
      },
    ],
  });
  return res.tempIdMap[`tmp:loc:${name}`]!;
}

async function seedArtifact(name: string): Promise<string> {
  const res = await kb.applyOperations({
    workId,
    chapterId,
    chapterNumber: 1,
    operations: [
      {
        kind: "create_artifact",
        tempId: `tmp:art:${name}`,
        name,
        summary: "seed",
        evidence: name,
        confidence: 0.9,
      },
    ],
  });
  return res.tempIdMap[`tmp:art:${name}`]!;
}

function draftCharacter(tempId: string, name: string, aliases: string[] = []): Operation {
  return {
    kind: "create_character",
    tempId,
    name,
    aliases,
    summary: "из текста",
    evidence: `${name} появился`,
    confidence: 0.9,
  };
}

function draftLocation(tempId: string, name: string): Operation {
  return {
    kind: "create_location",
    tempId,
    name,
    summary: "из текста",
    evidence: `${name} упомянут`,
    confidence: 0.9,
  };
}

function draftArtifact(tempId: string, name: string): Operation {
  return {
    kind: "create_artifact",
    tempId,
    name,
    summary: "из текста",
    evidence: `${name} упомянут`,
    confidence: 0.9,
  };
}

// ---------- Тесты ----------

describe("KbReconciler", () => {
  it("skip=no_drafts когда в operations нет create_*", async () => {
    // KB не пустой — но и драфтов нет, потому что Pass 1 эмитит только update/summary.
    await seedCharacter("Алексей Волков", ["Лёша"]);
    const llm = new FakeReconcileLLM([]);
    const rec = new KbReconciler(llm, kb);

    const result = await rec.reconcile({
      workId,
      operations: [
        {
          kind: "update_character",
          targetId: "tmp:1",
          field: "status",
          newValue: "вернулся",
          evidence: "e",
          confidence: 0.9,
        },
      ],
      collisionCandidates: [],
    });
    expect(result.skipped).toBe("no_drafts");
    expect(llm.calls).toHaveLength(0);
    expect(result.operations).toHaveLength(1);
    expect(result.llmHints.size).toBe(0);
  });

  it("skip=no_kb когда справочник полностью пуст", async () => {
    const llm = new FakeReconcileLLM([]);
    const rec = new KbReconciler(llm, kb);

    const result = await rec.reconcile({
      workId,
      operations: [draftCharacter("tmp:1", "Кто-то новый")],
      collisionCandidates: [],
    });
    expect(result.skipped).toBe("no_kb");
    expect(llm.calls).toHaveLength(0);
  });

  it("skip=no_overlap когда KB есть, но никто не похож на драфты", async () => {
    await seedCharacter("Совершенно посторонний", []);
    await seedLocation("Дальнее место");
    const llm = new FakeReconcileLLM([]);
    const rec = new KbReconciler(llm, kb);

    const result = await rec.reconcile({
      workId,
      operations: [draftCharacter("tmp:1", "Алексей Волков", ["Лёша"])],
      collisionCandidates: [],
    });
    expect(result.skipped).toBe("no_overlap");
    expect(llm.calls).toHaveLength(0);
  });

  it("exact-match даёт llmHint ≥ 0.9 и collision_candidate auto_merge", async () => {
    const realId = await seedCharacter("Алексей Волков", ["Лёша"]);
    const decision = {
      decisions: [
        {
          temp_id: "tmp:1",
          kind: "character",
          decision: "match",
          candidate_id: realId,
          probability: 0.97,
          matched_features: ["exact_name"],
        },
      ],
    };
    const llm = new FakeReconcileLLM([JSON.stringify(decision)]);
    const rec = new KbReconciler(llm, kb);

    const result = await rec.reconcile({
      workId,
      operations: [draftCharacter("tmp:1", "Алексей Волков", ["Лёша"])],
      collisionCandidates: [],
    });
    expect(result.skipped).toBeNull();
    expect(llm.calls).toHaveLength(1);
    expect(result.llmHints.get("tmp:1")).toBeCloseTo(0.97, 2);
    expect(result.collisionCandidates).toHaveLength(1);
    const cand = result.collisionCandidates[0]!;
    expect(cand.new_character).toBe("tmp:1");
    expect(cand.candidate).toBe(realId);
    expect(cand.recommended_action).toBe("auto_merge");
    expect(cand.matched_features).toEqual(["exact_name"]);
  });

  it("fuzzy match (probability 0.7-0.9) идёт в manual_review", async () => {
    const realId = await seedCharacter("Александр Васильев");
    const decision = {
      decisions: [
        {
          temp_id: "tmp:1",
          kind: "character",
          decision: "match",
          candidate_id: realId,
          probability: 0.72,
        },
      ],
    };
    const llm = new FakeReconcileLLM([JSON.stringify(decision)]);
    const rec = new KbReconciler(llm, kb);

    const result = await rec.reconcile({
      workId,
      operations: [draftCharacter("tmp:1", "Александр Василев")],
      collisionCandidates: [],
    });
    expect(result.skipped).toBeNull();
    expect(result.llmHints.get("tmp:1")).toBeCloseTo(0.72, 2);
    expect(result.collisionCandidates).toHaveLength(1);
    expect(result.collisionCandidates[0]!.recommended_action).toBe("manual_review");
  });

  it("decision=new не порождает collision и не добавляет llmHint", async () => {
    await seedCharacter("Алексей Волков");
    const decision = {
      decisions: [
        {
          temp_id: "tmp:1",
          kind: "character",
          decision: "new",
          probability: 0.1,
        },
      ],
    };
    const llm = new FakeReconcileLLM([JSON.stringify(decision)]);
    const rec = new KbReconciler(llm, kb);

    const result = await rec.reconcile({
      workId,
      operations: [draftCharacter("tmp:1", "Алексей Волков")],
      collisionCandidates: [],
    });
    expect(result.skipped).toBeNull();
    expect(result.collisionCandidates).toHaveLength(0);
    expect(result.llmHints.size).toBe(0);
    // Драфт-операция остаётся как была — финальный merge решит CollisionResolver.
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]!.kind).toBe("create_character");
  });

  it("transferable_facts превращаются в update_character на candidate_id", async () => {
    const realId = await seedCharacter("Алексей Волков");
    const decision = {
      decisions: [
        {
          temp_id: "tmp:1",
          kind: "character",
          decision: "match",
          candidate_id: realId,
          probability: 0.95,
          transferable_facts: [
            { field: "summary", new_value: "узнал об отце" },
            { field: "status", new_value: "ранен" },
          ],
        },
      ],
    };
    const llm = new FakeReconcileLLM([JSON.stringify(decision)]);
    const rec = new KbReconciler(llm, kb);

    const result = await rec.reconcile({
      workId,
      operations: [draftCharacter("tmp:1", "Алексей Волков")],
      collisionCandidates: [],
    });
    expect(result.skipped).toBeNull();
    // Исходный create_character + 2 update_character.
    expect(result.operations).toHaveLength(3);
    const updates = result.operations.filter((o) => o.kind === "update_character");
    expect(updates).toHaveLength(2);
    for (const u of updates) {
      if (u.kind === "update_character") {
        expect(u.targetId).toBe(realId);
        expect(["summary", "status"]).toContain(u.field);
      }
    }
  });

  it("repair-loop: первая попытка невалидна, вторая ОК — успех без throw", async () => {
    const realId = await seedCharacter("Алексей Волков");
    const goodDecision = {
      decisions: [
        {
          temp_id: "tmp:1",
          kind: "character",
          decision: "match",
          candidate_id: realId,
          probability: 0.95,
        },
      ],
    };
    // 1 невалидный + 1 валидный → 1 repair-цикл, успех.
    const llm = new FakeReconcileLLM(["мусор без JSON", JSON.stringify(goodDecision)]);
    const rec = new KbReconciler(llm, kb);

    const result = await rec.reconcile({
      workId,
      operations: [draftCharacter("tmp:1", "Алексей Волков")],
      collisionCandidates: [],
    });
    expect(llm.calls).toHaveLength(2);
    // Второй вызов содержит assistant (плохой ответ) + user(repair).
    expect(llm.calls[1]!.messages.length).toBeGreaterThan(2);
    expect(llm.calls[1]!.messages[2]!.role).toBe("assistant");
    expect(llm.calls[1]!.messages[3]!.role).toBe("user");
    expect(llm.calls[1]!.messages[3]!.content).toContain("Твой предыдущий ответ");
    expect(result.skipped).toBeNull();
    expect(result.llmHints.get("tmp:1")).toBeCloseTo(0.95, 2);
  });

  it("tolerant parser: удаляет лишние поля и не запускает repair", async () => {
    const realId = await seedCharacter("Алексей Волков");
    const raw = JSON.stringify({
      decisions: [
        {
          temp_id: "tmp:1",
          kind: "character",
          decision: "match",
          candidate_id: realId,
          probability: 0.95,
          matched_features: ["exact_name", 42],
          extra_noise: "drop me",
        },
      ],
      transferable_facts: [],
    });
    const llm = new FakeReconcileLLM([raw]);
    const rec = new KbReconciler(llm, kb);

    const result = await rec.reconcile({
      workId,
      operations: [draftCharacter("tmp:1", "Алексей Волков")],
      collisionCandidates: [],
    });

    expect(llm.calls).toHaveLength(1);
    expect(result.skipped).toBeNull();
    expect(result.llmHints.get("tmp:1")).toBeCloseTo(0.95, 2);
    expect(result.collisionCandidates[0]!.matched_features).toEqual(["exact_name"]);
  });

  it("tolerant parser: берёт первый сбалансированный JSON и отрезает хвост", async () => {
    const realId = await seedCharacter("Алексей Волков");
    const good = {
      decisions: [
        {
          temp_id: "tmp:1",
          kind: "character",
          decision: "match",
          candidate_id: realId,
          probability: 0.94,
        },
      ],
    };
    const llm = new FakeReconcileLLM([JSON.stringify(good) + '{"candidate_id":"junk"}']);
    const rec = new KbReconciler(llm, kb);

    const result = await rec.reconcile({
      workId,
      operations: [draftCharacter("tmp:1", "Алексей Волков")],
      collisionCandidates: [],
    });

    expect(llm.calls).toHaveLength(1);
    expect(result.llmHints.get("tmp:1")).toBeCloseTo(0.94, 2);
  });

  it("tolerant parser: дозакрывает незавершённый корневой объект", async () => {
    const realId = await seedCharacter("Алексей Волков");
    const decision = JSON.stringify({
      temp_id: "tmp:1",
      kind: "character",
      decision: "match",
      candidate_id: realId,
      probability: 0.93,
    });
    const llm = new FakeReconcileLLM([`{"decisions":[${decision}]`]);
    const rec = new KbReconciler(llm, kb);

    const result = await rec.reconcile({
      workId,
      operations: [draftCharacter("tmp:1", "Алексей Волков")],
      collisionCandidates: [],
    });

    expect(llm.calls).toHaveLength(1);
    expect(result.llmHints.get("tmp:1")).toBeCloseTo(0.93, 2);
  });

  it("tolerant parser: смысловую поломку отдаёт в repair-loop", async () => {
    const realId = await seedCharacter("Алексей Волков");
    const missingCandidate = {
      decisions: [
        {
          temp_id: "tmp:1",
          kind: "character",
          decision: "match",
          probability: 0.95,
        },
      ],
    };
    const repaired = {
      decisions: [
        {
          temp_id: "tmp:1",
          kind: "character",
          decision: "match",
          candidate_id: realId,
          probability: 0.95,
        },
      ],
    };
    const llm = new FakeReconcileLLM([JSON.stringify(missingCandidate), JSON.stringify(repaired)]);
    const rec = new KbReconciler(llm, kb);

    const result = await rec.reconcile({
      workId,
      operations: [draftCharacter("tmp:1", "Алексей Волков")],
      collisionCandidates: [],
    });

    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1]!.messages[3]!.content).toContain("candidate_id");
    expect(result.llmHints.get("tmp:1")).toBeCloseTo(0.95, 2);
  });

  it("hard-fail: repair исчерпан → ReconcileFailedError, KB-apply должен быть пропущен", async () => {
    await seedCharacter("Алексей Волков");
    // 3 невалидных подряд = 1 initial + 2 repair. Дефолт maxRepairAttempts=2.
    const llm = new FakeReconcileLLM(["мусор 1", "мусор 2", "мусор 3"]);
    const rec = new KbReconciler(llm, kb);

    await expect(
      rec.reconcile({
        workId,
        operations: [draftCharacter("tmp:1", "Алексей Волков")],
        collisionCandidates: [],
      }),
    ).rejects.toBeInstanceOf(ReconcileFailedError);
    // Все 3 LLM-вызова были сделаны.
    expect(llm.calls).toHaveLength(3);
  });

  it("ReconcileFailedError содержит attempts и rawResponses для диагностики", async () => {
    await seedCharacter("Алексей Волков");
    const llm = new FakeReconcileLLM(["bad1", "bad2", "bad3"]);
    const rec = new KbReconciler(llm, kb, { maxRepairAttempts: 2 });

    let caught: ReconcileFailedError | null = null;
    try {
      await rec.reconcile({
        workId,
        operations: [draftCharacter("tmp:1", "Алексей Волков")],
        collisionCandidates: [],
      });
    } catch (err) {
      if (err instanceof ReconcileFailedError) caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught!.attempts).toBe(3); // 1 initial + 2 repair
    expect(caught!.rawResponses).toHaveLength(3);
    expect(caught!.errors.length).toBeGreaterThan(0);
  });

  it("maxRepairAttempts=0 → первая ошибка сразу кидает ReconcileFailedError", async () => {
    await seedCharacter("Алексей Волков");
    const llm = new FakeReconcileLLM(["мусор"]);
    const rec = new KbReconciler(llm, kb, { maxRepairAttempts: 0 });

    await expect(
      rec.reconcile({
        workId,
        operations: [draftCharacter("tmp:1", "Алексей Волков")],
        collisionCandidates: [],
      }),
    ).rejects.toBeInstanceOf(ReconcileFailedError);
    expect(llm.calls).toHaveLength(1); // никаких repair
  });

  it("decision с несуществующим temp_id игнорируется", async () => {
    const realId = await seedCharacter("Алексей Волков");
    const decision = {
      decisions: [
        {
          temp_id: "tmp:phantom", // нет такого драфта
          kind: "character",
          decision: "match",
          candidate_id: realId,
          probability: 0.9,
        },
      ],
    };
    const llm = new FakeReconcileLLM([JSON.stringify(decision)]);
    const rec = new KbReconciler(llm, kb);

    const result = await rec.reconcile({
      workId,
      operations: [draftCharacter("tmp:1", "Алексей Волков")],
      collisionCandidates: [],
    });
    expect(result.skipped).toBeNull();
    expect(result.collisionCandidates).toHaveLength(0);
    expect(result.llmHints.size).toBe(0);
  });

  it("decision с candidate_id, которого не было среди кандидатов, игнорируется", async () => {
    await seedCharacter("Алексей Волков");
    const decision = {
      decisions: [
        {
          temp_id: "tmp:1",
          kind: "character",
          decision: "match",
          candidate_id: "char_phantom_999",
          probability: 0.9,
        },
      ],
    };
    const llm = new FakeReconcileLLM([JSON.stringify(decision)]);
    const rec = new KbReconciler(llm, kb);

    const result = await rec.reconcile({
      workId,
      operations: [draftCharacter("tmp:1", "Алексей Волков")],
      collisionCandidates: [],
    });
    expect(result.skipped).toBeNull();
    expect(result.collisionCandidates).toHaveLength(0);
  });

  it("match для location создаёт collision без transferable_facts", async () => {
    const realId = await seedLocation("Кадия");
    const decision = {
      decisions: [
        {
          temp_id: "tmp:1",
          kind: "location",
          decision: "match",
          candidate_id: realId,
          probability: 0.95,
          // transferable_facts для locations должны игнорироваться (схема Location
          // не имеет update-полей).
          transferable_facts: [{ field: "summary", new_value: "новое описание" }],
        },
      ],
    };
    const llm = new FakeReconcileLLM([JSON.stringify(decision)]);
    const rec = new KbReconciler(llm, kb);

    const result = await rec.reconcile({
      workId,
      operations: [draftLocation("tmp:1", "Кадия")],
      collisionCandidates: [],
    });
    expect(result.skipped).toBeNull();
    expect(result.collisionCandidates).toHaveLength(1);
    expect(result.collisionCandidates[0]!.candidate).toBe(realId);
    // Никаких update_character для location.
    const updates = result.operations.filter((o) => o.kind === "update_character");
    expect(updates).toHaveLength(0);
  });

  it("match для artifact — симметрично location", async () => {
    const realId = await seedArtifact("Меч");
    const decision = {
      decisions: [
        {
          temp_id: "tmp:1",
          kind: "artifact",
          decision: "match",
          candidate_id: realId,
          probability: 0.93,
        },
      ],
    };
    const llm = new FakeReconcileLLM([JSON.stringify(decision)]);
    const rec = new KbReconciler(llm, kb);

    const result = await rec.reconcile({
      workId,
      operations: [draftArtifact("tmp:1", "Меч")],
      collisionCandidates: [],
    });
    expect(result.skipped).toBeNull();
    expect(result.collisionCandidates).toHaveLength(1);
    expect(result.collisionCandidates[0]!.candidate).toBe(realId);
    expect(result.collisionCandidates[0]!.recommended_action).toBe("auto_merge");
  });
});
