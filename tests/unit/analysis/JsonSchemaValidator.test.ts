import { describe, expect, it } from "vitest";
import { JsonSchemaValidator } from "@/analysis/JsonSchemaValidator";

const validResponse = {
  chapter_id: "ch_001",
  new_entities: [
    {
      type: "character",
      temp_id: "e1",
      name: "Алексей Волков",
      aliases: ["Лёша"],
      summary: "Наследник северного рода.",
      evidence: "Алексей Волков шагнул вперёд.",
      confidence: 0.86,
    },
  ],
  operations: [
    {
      type: "update_character",
      target_id: "char_003",
      field: "status",
      new_value: "ранен",
      evidence: "ранен после дуэли",
      confidence: 0.91,
    },
  ],
  collision_candidates: [],
};

describe("JsonSchemaValidator", () => {
  const v = new JsonSchemaValidator();

  it("accepts a valid response", () => {
    const result = v.parseAndValidate(JSON.stringify(validResponse));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.new_entities).toHaveLength(1);
      expect(result.dropped).toEqual({ newEntities: 0, operations: 0 });
    }
  });

  it("drops entity with out-of-range confidence (sanitize)", () => {
    const bad = {
      ...validResponse,
      new_entities: [
        validResponse.new_entities[0]!,
        { ...validResponse.new_entities[0]!, name: "Y", confidence: 1.5 },
      ],
    };
    const result = v.parseAndValidate(JSON.stringify(bad));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.new_entities).toHaveLength(1);
      expect(result.dropped.newEntities).toBe(1);
    }
  });

  it("drops entity with unknown type (sanitize)", () => {
    const bad = {
      ...validResponse,
      new_entities: [
        validResponse.new_entities[0]!,
        { ...validResponse.new_entities[0]!, name: "Y", type: "demon" },
      ],
    };
    const result = v.parseAndValidate(JSON.stringify(bad));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.new_entities).toHaveLength(1);
      expect(result.dropped.newEntities).toBe(1);
    }
  });

  it("drops entity with missing evidence (sanitize)", () => {
    const bad = {
      ...validResponse,
      new_entities: [
        validResponse.new_entities[0]!,
        { type: "character", name: "X", confidence: 0.9 },
      ],
    };
    const result = v.parseAndValidate(JSON.stringify(bad));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.new_entities).toHaveLength(1);
      expect(result.dropped.newEntities).toBe(1);
    }
  });

  it("drops trailing placeholder entity (model padding pattern)", () => {
    // Реальный паттерн из прода: модель добавляет в конец пустую заглушку.
    const bad = {
      ...validResponse,
      new_entities: [
        validResponse.new_entities[0]!,
        { type: "", name: "", evidence: "", summary: "", temp_id: "", confidence: 0.5 },
      ],
    };
    const result = v.parseAndValidate(JSON.stringify(bad));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.new_entities).toHaveLength(1);
      expect(result.dropped.newEntities).toBe(1);
    }
  });

  it("repairs markdown code fences and trailing commas", () => {
    const dirty = "```json\n" + JSON.stringify(validResponse).replace(/}/g, ",}").replace(/]/g, ",]") + "\n```";
    const result = v.parseAndValidate(dirty);
    expect(result.ok).toBe(true);
  });

  it("repairs leading prose by trimming to first '{'", () => {
    const dirty = "Конечно, вот результат:\n\n" + JSON.stringify(validResponse) + "\n\nНадеюсь, помог!";
    const result = v.parseAndValidate(dirty);
    expect(result.ok).toBe(true);
  });

  it("returns errors for completely broken input", () => {
    const result = v.parseAndValidate("not even close to json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThan(0);
  });

  it("drops update_character missing target_id (sanitize)", () => {
    const bad = {
      ...validResponse,
      operations: [
        { type: "update_character", field: "status", new_value: "ранен", evidence: "e", confidence: 0.9 },
      ],
    };
    const result = v.parseAndValidate(JSON.stringify(bad));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.operations).toHaveLength(0);
      expect(result.dropped.operations).toBe(1);
    }
  });

  it("drops add_alias missing alias field (sanitize)", () => {
    const bad = {
      ...validResponse,
      operations: [{ type: "add_alias", target_id: "char_001", evidence: "e", confidence: 0.9 }],
    };
    const result = v.parseAndValidate(JSON.stringify(bad));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.operations).toHaveLength(0);
      expect(result.dropped.operations).toBe(1);
    }
  });

  it("drops unknown operation types (sanitize)", () => {
    const bad = {
      ...validResponse,
      operations: [{ type: "add_relation", source_id: "c1", target_id: "c2", evidence: "e", confidence: 0.9 }],
    };
    const result = v.parseAndValidate(JSON.stringify(bad));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.operations).toHaveLength(0);
      expect(result.dropped.operations).toBe(1);
    }
  });

  it("accepts complete add_alias operation (strict oneOf schema)", () => {
    const good = {
      ...validResponse,
      operations: [{ type: "add_alias", target_id: "char_001", alias: "Лёша", evidence: "звали его Лёша", confidence: 0.95 }],
    };
    const result = v.parseAndValidate(JSON.stringify(good));
    expect(result.ok).toBe(true);
  });

  it("accepts complete create_chapter_summary operation (strict oneOf schema)", () => {
    const good = {
      ...validResponse,
      operations: [{
        type: "create_chapter_summary",
        summary: "Иван прибыл в Лавру и встретился с князем Волковым.",
        characters_present: ["char_001", "char_002"],
        locations_present: ["loc_001"],
        artifacts_mentioned: [],
        key_events_oneline: ["встреча с князем"],
        evidence: "Иван подошёл к Волкову…",
        confidence: 0.88,
      }],
    };
    const result = v.parseAndValidate(JSON.stringify(good));
    expect(result.ok).toBe(true);
  });
});
