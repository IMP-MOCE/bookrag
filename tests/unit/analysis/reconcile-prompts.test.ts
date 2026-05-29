import { describe, expect, it } from "vitest";

import {
  MAX_CANDIDATES_PER_DRAFT,
  RECONCILE_SYSTEM_PROMPT,
  buildReconcileUserPrompt,
  type ReconcileCandidate,
  type ReconcileDraft,
} from "@/analysis/reconcile-prompts";

function draft(over: Partial<ReconcileDraft> = {}): ReconcileDraft {
  return {
    tempId: "tmp:1",
    kind: "character",
    name: "Алексей Волков",
    aliases: [],
    evidence: "Алексей Волков шагнул вперёд.",
    ...over,
  };
}

function cand(id: string, name: string, aliases: string[] = []): ReconcileCandidate {
  return { id, name, aliases };
}

describe("RECONCILE_SYSTEM_PROMPT", () => {
  it("содержит schema-эталон с required-полями", () => {
    expect(RECONCILE_SYSTEM_PROMPT).toContain("decisions");
    expect(RECONCILE_SYSTEM_PROMPT).toContain('"match"');
    expect(RECONCILE_SYSTEM_PROMPT).toContain('"new"');
  });
});

describe("buildReconcileUserPrompt", () => {
  it("корректно строит prompt для одной entity с кандидатом", () => {
    const drafts = [draft()];
    const cands = new Map([
      ["tmp:1", [cand("char_abc", "Алексей Волков", ["Лёша"])]],
    ]);
    const prompt = buildReconcileUserPrompt(drafts, cands);

    expect(prompt).toContain("NEW ENTITIES:");
    expect(prompt).toContain("KB CANDIDATES:");
    expect(prompt).toContain("tmp:1 character");
    expect(prompt).toContain("char_abc");
    expect(prompt).toContain("Лёша");
    expect(prompt).toContain("Верни JSON по схеме");
  });

  it("на entity без KB-кандидатов выводит «нет кандидатов»", () => {
    const drafts = [draft({ tempId: "tmp:loc1", kind: "location", name: "Кадия" })];
    const cands = new Map<string, ReconcileCandidate[]>([["tmp:loc1", []]]);
    const prompt = buildReconcileUserPrompt(drafts, cands);

    expect(prompt).toContain("tmp:loc1 location");
    expect(prompt).toContain("- tmp:loc1: (нет кандидатов");
  });

  it("режет список кандидатов до MAX_CANDIDATES_PER_DRAFT", () => {
    const drafts = [draft()];
    const many: ReconcileCandidate[] = [];
    for (let i = 0; i < MAX_CANDIDATES_PER_DRAFT + 3; i++) {
      many.push(cand(`char_${i}`, `Кандидат_${i}`));
    }
    const cands = new Map([["tmp:1", many]]);
    const prompt = buildReconcileUserPrompt(drafts, cands);

    // Первые MAX штук обязаны быть в промпте.
    for (let i = 0; i < MAX_CANDIDATES_PER_DRAFT; i++) {
      expect(prompt).toContain(`char_${i}`);
    }
    // А «лишний» кандидат не должен попасть.
    expect(prompt).not.toContain(`char_${MAX_CANDIDATES_PER_DRAFT + 2}`);
  });

  it("экранирует кавычки и переводы строк в имени и evidence", () => {
    const drafts = [
      draft({
        name: 'Имя с "кавычками"',
        evidence: 'Эта цитата содержит "кавычки"\nи перевод строки',
      }),
    ];
    const cands = new Map<string, ReconcileCandidate[]>([["tmp:1", []]]);
    const prompt = buildReconcileUserPrompt(drafts, cands);

    expect(prompt).toContain('\\"кавычки\\"');
    // Переводы строк в evidence заменяются на пробел, иначе они ломают
    // одностроковую структуру дроп-листа.
    expect(prompt).not.toMatch(/перевод строки\nЭта/);
  });

  it("обрезает длинный evidence до ~120 символов", () => {
    // Уникальный «маркер» в конце цитаты — он не должен попасть в prompt,
    // если обрезка реально работает. Повторяющийся текст в начале для длины.
    const long = "А".repeat(200) + " HIDDEN_TAIL_MARKER";
    const drafts = [draft({ evidence: long })];
    const cands = new Map<string, ReconcileCandidate[]>([["tmp:1", []]]);
    const prompt = buildReconcileUserPrompt(drafts, cands);

    // Многоточие — признак обрезки.
    expect(prompt).toContain("…");
    // Маркер на хвосте находится за пределами лимита — должен быть отрезан.
    expect(prompt).not.toContain("HIDDEN_TAIL_MARKER");
  });

  it("прокидывает aliases в строку драфта (но не более 4)", () => {
    const drafts = [draft({ aliases: ["a1", "a2", "a3", "a4", "a5", "a6"] })];
    const cands = new Map<string, ReconcileCandidate[]>([["tmp:1", []]]);
    const prompt = buildReconcileUserPrompt(drafts, cands);

    expect(prompt).toContain("aliases: a1, a2, a3, a4");
    expect(prompt).not.toContain("a5");
    expect(prompt).not.toContain("a6");
  });
});
