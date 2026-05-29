import { describe, expect, it } from "vitest";
import { convertResponse } from "@/analysis/converter";
import type { AnalysisResponse } from "@/analysis/types";

describe("convertResponse", () => {
  it("converts new_entities into create_* ops with stable tempIds", () => {
    const resp: AnalysisResponse = {
      new_entities: [
        {
          type: "character",
          temp_id: "e1",
          name: "Алексей",
          aliases: ["Лёша"],
          summary: "Герой",
          evidence: "Алексей",
          confidence: 0.9,
        },
        {
          type: "location",
          temp_id: "e2",
          name: "Лес",
          summary: "тёмный",
          evidence: "Лес",
          confidence: 0.8,
        },
      ],
      operations: [],
      collision_candidates: [],
    };
    const out = convertResponse(resp, { tempIdPrefix: "tmp:t", startCounter: 1 });
    expect(out.operations).toHaveLength(2);
    expect(out.operations[0]!.kind).toBe("create_character");
    expect(out.operations[1]!.kind).toBe("create_location");
    expect(out.endCounter).toBe(3);
    expect(out.dropped).toBe(0);
  });

  it("resolves model temp_id references in operations and collisions", () => {
    const resp: AnalysisResponse = {
      new_entities: [
        {
          type: "character",
          temp_id: "e1",
          name: "Алексей",
          evidence: "...",
          confidence: 0.9,
        },
      ],
      operations: [
        {
          type: "add_alias",
          target_id: "e1",
          alias: "князь",
          evidence: "...",
          confidence: 0.8,
        },
      ],
      collision_candidates: [
        {
          new_character: "e1",
          candidate: "char_existing",
          same_entity_probability: 0.7,
          recommended_action: "manual_review",
        },
      ],
    };
    const out = convertResponse(resp, { tempIdPrefix: "tmp:t", startCounter: 1 });
    const create = out.operations[0]!;
    expect(create.kind).toBe("create_character");
    const ourTempId = create.kind === "create_character" ? create.tempId : "";
    const alias = out.operations[1]!;
    expect(alias.kind).toBe("add_alias");
    if (alias.kind === "add_alias") expect(alias.targetId).toBe(ourTempId);
    expect(out.collisionCandidates[0]!.new_character).toBe(ourTempId);
  });

  it("collapses repeated update_character on same (targetId, field) to the last one", () => {
    const resp: AnalysisResponse = {
      new_entities: [],
      operations: [
        {
          type: "update_character",
          target_id: "char_1",
          field: "summary",
          new_value: "версия 1",
          evidence: "...",
          confidence: 0.7,
        },
        {
          type: "update_character",
          target_id: "char_1",
          field: "summary",
          new_value: "версия 2 финальная",
          evidence: "...",
          confidence: 0.8,
        },
        {
          type: "update_character",
          target_id: "char_1",
          field: "role",
          new_value: "герой",
          evidence: "...",
          confidence: 0.9,
        },
        {
          type: "add_alias",
          target_id: "char_1",
          alias: "Лёша",
          evidence: "...",
          confidence: 0.8,
        },
        {
          type: "add_alias",
          target_id: "char_1",
          alias: "Лёша",
          evidence: "...",
          confidence: 0.8,
        },
      ],
      collision_candidates: [],
    };
    const out = convertResponse(resp);
    // Остаются: последний update_character(summary), update_character(role), один add_alias.
    expect(out.operations).toHaveLength(3);
    const summaryOp = out.operations.find(
      (o) => o.kind === "update_character" && o.field === "summary",
    );
    expect(summaryOp?.kind === "update_character" && summaryOp.newValue).toBe("версия 2 финальная");
    expect(out.dropped).toBe(2);
  });

  it("drops operations with missing required fields, increments dropped counter", () => {
    const resp: AnalysisResponse = {
      new_entities: [],
      operations: [
        {
          type: "update_character",
          field: "status",
          // target_id отсутствует
          new_value: "ранен",
          evidence: "...",
          confidence: 0.9,
        } as any,
        {
          type: "create_chapter_summary",
          // summary пустая — должна отбрасываться
          summary: "",
          evidence: "...",
          confidence: 0.9,
        } as any,
      ],
      collision_candidates: [],
    };
    const out = convertResponse(resp);
    expect(out.operations).toHaveLength(0);
    expect(out.dropped).toBe(2);
  });
});
