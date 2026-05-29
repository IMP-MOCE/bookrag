import { describe, expect, it } from "vitest";
import {
  filterContextByChunk,
  summarizeContext,
  summarizeContextLight,
} from "../../../src/analysis/prompts";

// Минимальная фикстура KB-контекста, который раньше ШЕЛ модели полностью на
// каждый чанк. Точка теста — убедиться, что filterContextByChunk оставляет
// только записи, имена которых видны в текущем чанке, и что для чанка без
// упоминаний summarize_context возвращает «Справочник пуст…» — что и нужно
// для борьбы с FAST-EMPTY на q4 MLC.
const KB = {
  characters: [
    { id: "char_a", name: "Андрей Богданов", aliases: ["Эхо"], summary: "герой" },
    { id: "char_k", name: "Карма", aliases: ["Зарница"], summary: "противница" },
    { id: "char_m", name: "Михаил", aliases: [], summary: "наставник" },
  ],
  locations: [
    { id: "loc_stroyka", name: "Заброшенная стройка", summary: "место с историей" },
    { id: "loc_kadia", name: "Кадия", summary: "полис" },
  ],
  artifacts: [
    { id: "art_bokken", name: "Бокен", summary: "деревянный меч" },
    { id: "art_lyk", name: "Лук", summary: "оружие героя" },
  ],
};

describe("filterContextByChunk", () => {
  it("отбирает только сущности с именем, упомянутым в чанке", () => {
    const chunkText = "Карма вышла из недостроя и направилась мне навстречу. Я достал бокен.";
    const filtered = filterContextByChunk(KB, chunkText);

    expect(filtered.characters.map((c) => c.id)).toEqual(["char_k"]);
    expect(filtered.locations).toEqual([]);
    expect(filtered.artifacts.map((a) => a.id)).toEqual(["art_bokken"]);
  });

  it("ловит сущности по псевдонимам", () => {
    // «Эхо» — это alias у char_a. Имени «Андрей» в тексте нет.
    const chunkText = "Эхо подошёл к воротам. Зарница ждала его.";
    const filtered = filterContextByChunk(KB, chunkText);

    expect(filtered.characters.map((c) => c.id).sort()).toEqual(["char_a", "char_k"]);
  });

  it("ловит склонения через буквенные стемы (≥4 символов)", () => {
    // buildKeys() кладёт токены ≥4 символов: «карма», «зарница», «богданов» и т.п.
    // Substring-match в normalized chunk text должен срабатывать на склонениях.
    const chunkText = "Они приехали в Кадию. Михаила там уже не было.";
    const filtered = filterContextByChunk(KB, chunkText);

    expect(filtered.locations.map((l) => l.id)).toContain("loc_kadia");
    expect(filtered.characters.map((c) => c.id)).toContain("char_m");
  });

  it("на чанке без упоминаний summarize даёт пустой плейсхолдер", () => {
    const chunkText = "Совершенно посторонний текст без знакомых имён.";
    const filtered = filterContextByChunk(KB, chunkText);
    const out = summarizeContext(filtered);

    expect(filtered.characters).toEqual([]);
    expect(filtered.locations).toEqual([]);
    expect(filtered.artifacts).toEqual([]);
    expect(out).toContain("Справочник пока пуст");
  });
});

describe("summarizeContextLight", () => {
  it("у character с aliases добавляет их в скобках после name[id]", () => {
    const ctx = {
      characters: [
        { id: "char_a", name: "Андрей Богданов", aliases: ["Эхо", "Богданов"] },
      ],
      locations: [],
      artifacts: [],
    };
    const out = summarizeContextLight(ctx);
    expect(out).toContain("Андрей Богданов[char_a] (Эхо, Богданов)");
  });

  it("у character без aliases — обычный name[id] без скобок (не «(...)»)", () => {
    const ctx = {
      characters: [{ id: "char_m", name: "Михаил", aliases: [] }],
      locations: [],
      artifacts: [],
    };
    const out = summarizeContextLight(ctx);
    expect(out).toContain("Михаил[char_m]");
    expect(out).not.toContain("Михаил[char_m] (");
  });

  it("разделяет characters через '; ' (запятая зарезервирована для aliases)", () => {
    const ctx = {
      characters: [
        { id: "char_a", name: "Андрей", aliases: ["Эхо"] },
        { id: "char_k", name: "Карма", aliases: ["Зарница"] },
      ],
      locations: [],
      artifacts: [],
    };
    const out = summarizeContextLight(ctx);
    expect(out).toContain("Андрей[char_a] (Эхо); Карма[char_k] (Зарница)");
  });

  it("locations и artifacts — без aliases (их нет в типе KbContextLike), формат как в summarizeContext", () => {
    const ctx = {
      characters: [],
      locations: [
        { id: "loc_kadia", name: "Кадия" },
        { id: "loc_stroyka", name: "Заброшенная стройка" },
      ],
      artifacts: [{ id: "art_bokken", name: "Бокен" }],
    };
    const out = summarizeContextLight(ctx);
    expect(out).toContain("Локации: Кадия[loc_kadia], Заброшенная стройка[loc_stroyka].");
    expect(out).toContain("Артефакты: Бокен[art_bokken].");
  });

  it("aliases capped at 5 per character — длинный список aliases обрезается", () => {
    const longAliases = ["A1", "A2", "A3", "A4", "A5", "A6", "A7"];
    const ctx = {
      characters: [{ id: "char_x", name: "X", aliases: longAliases }],
      locations: [],
      artifacts: [],
    };
    const out = summarizeContextLight(ctx);
    expect(out).toContain("(A1, A2, A3, A4, A5)");
    expect(out).not.toContain("A6");
  });

  it("на пустом KB даёт тот же плейсхолдер, что и summarizeContext", () => {
    const ctx = { characters: [], locations: [], artifacts: [] };
    expect(summarizeContextLight(ctx)).toBe(summarizeContext(ctx));
  });

  it("принципиально НЕ упоминает summary/role/status (FAST-EMPTY guard)", () => {
    // Принимаем структурно совместимый KB-ctx с лишними summary полями —
    // light-вариант должен их игнорировать.
    const ctx = {
      characters: [
        {
          id: "char_a",
          name: "Андрей",
          aliases: ["Эхо"],
          // эти поля могут быть на CharacterCard из KnowledgeBase, light-блок их НЕ должен показывать:
          summary: "герой, бывший охотник, сейчас в розыске",
          role: "главный герой",
          status: "в бегах",
        } as unknown as { id: string; name: string; aliases: string[] },
      ],
      locations: [],
      artifacts: [],
    };
    const out = summarizeContextLight(ctx);
    expect(out).not.toContain("герой");
    expect(out).not.toContain("розыск");
    expect(out).not.toContain("в бегах");
  });
});
