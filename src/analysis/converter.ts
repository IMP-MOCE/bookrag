import type { Operation } from "../kb/operations";
import type {
  AnalysisResponse,
  CollisionCandidateResponse,
  NewEntityResponse,
} from "./types";

export interface ConvertOutput {
  operations: Operation[];
  collisionCandidates: CollisionCandidateResponse[];
  // Сколько записей пришлось отбросить из-за невалидного содержимого
  // (отсутствующих обязательных подполей для конкретного типа операции).
  dropped: number;
}

export interface ConvertOptions {
  // Префикс для генерируемых tempId, чтобы они не пересекались между чанками.
  tempIdPrefix?: string;
  // Стартовый порядковый номер. Возвращается актуализированный, чтобы вызывающий мог
  // продолжать нумерацию между чанками.
  startCounter?: number;
}

export interface ConvertResult extends ConvertOutput {
  endCounter: number;
}

// Преобразует ответ модели (после ajv-валидации) в массив операций KB.
// Резолвит модельные temp_id ("e1") в собственные ("tmp:bookrag:N"),
// чтобы и operations, и collision_candidates ссылались на одни и те же реальные сущности.
export function convertResponse(
  response: AnalysisResponse,
  opts: ConvertOptions = {},
): ConvertResult {
  const prefix = opts.tempIdPrefix ?? "tmp:bookrag";
  let counter = opts.startCounter ?? 1;
  const next = () => `${prefix}:${counter++}`;

  // Локальный resolver: модельный temp_id → наш канонический.
  const resolver = new Map<string, string>();
  const resolve = (modelRef: string | undefined): string | undefined => {
    if (!modelRef) return undefined;
    return resolver.get(modelRef) ?? modelRef;
  };

  const operations: Operation[] = [];
  let dropped = 0;

  // 1) Создания сущностей.
  for (const e of response.new_entities) {
    if (!isNewEntityValid(e)) {
      logDrop("new_entity", whyEntityInvalid(e), e.evidence);
      dropped++;
      continue;
    }
    const ourTempId = next();
    if (e.temp_id) resolver.set(e.temp_id, ourTempId);

    if (e.type === "character") {
      operations.push({
        kind: "create_character",
        tempId: ourTempId,
        name: e.name,
        aliases: e.aliases ?? [],
        summary: e.summary ?? "",
        ...(e.role ? { role: e.role } : {}),
        evidence: e.evidence,
        confidence: e.confidence,
      });
    } else if (e.type === "location") {
      operations.push({
        kind: "create_location",
        tempId: ourTempId,
        name: e.name,
        summary: e.summary ?? "",
        evidence: e.evidence,
        confidence: e.confidence,
      });
    } else {
      operations.push({
        kind: "create_artifact",
        tempId: ourTempId,
        name: e.name,
        summary: e.summary ?? "",
        evidence: e.evidence,
        confidence: e.confidence,
      });
    }
  }

  // 2) Операции над сущностями.
  for (const op of response.operations) {
    switch (op.type) {
      case "update_character": {
        if (!op.target_id || !op.field || op.new_value === undefined) {
          logDrop(
            "update_character",
            missingFields({ target_id: op.target_id, field: op.field, new_value: op.new_value }),
            op.evidence,
          );
          dropped++;
          break;
        }
        operations.push({
          kind: "update_character",
          targetId: resolve(op.target_id) ?? op.target_id,
          field: op.field,
          newValue: op.new_value,
          evidence: op.evidence,
          confidence: op.confidence,
        });
        break;
      }
      case "add_alias": {
        if (!op.target_id || !op.alias) {
          logDrop(
            "add_alias",
            missingFields({ target_id: op.target_id, alias: op.alias }),
            op.evidence,
          );
          dropped++;
          break;
        }
        operations.push({
          kind: "add_alias",
          targetId: resolve(op.target_id) ?? op.target_id,
          alias: op.alias,
          evidence: op.evidence,
          confidence: op.confidence,
        });
        break;
      }
      case "create_chapter_summary": {
        if (!op.summary || op.summary.trim() === "") {
          logDrop("create_chapter_summary", missingFields({ summary: op.summary }), op.evidence);
          dropped++;
          break;
        }
        operations.push({
          kind: "create_chapter_summary",
          summary: op.summary,
          charactersPresent: (op.characters_present ?? []).map((r) => resolve(r) ?? r),
          locationsPresent: (op.locations_present ?? []).map((r) => resolve(r) ?? r),
          artifactsMentioned: (op.artifacts_mentioned ?? []).map((r) => resolve(r) ?? r),
          keyEventsOneline: (op.key_events_oneline ?? []).filter(
            (s) => typeof s === "string" && s.trim() !== "",
          ),
          evidence: op.evidence,
          confidence: op.confidence,
        });
        break;
      }
    }
  }

  // 2.5) Дедуп: модель (особенно Qwen3.5) иногда эмитит несколько update_character
  // на одну и ту же пару (targetId, field) — пишет «версии» summary одна за другой.
  // По семантике applyOperations всё равно «последняя побеждает» в поле, но каждая
  // запись добавляется в history. Схлопываем к одной (последней), чтобы не засорять
  // историю. То же для add_alias по (targetId, alias) — он там идемпотентен.
  const deduped = dedupeOperations(operations);
  dropped += operations.length - deduped.length;

  // 3) Коллизии — переписываем new_character на резолвнутый id, чтобы reviewer видел стабильную ссылку.
  const collisionCandidates: CollisionCandidateResponse[] = response.collision_candidates.map(
    (c) => ({ ...c, new_character: resolve(c.new_character) ?? c.new_character }),
  );

  return { operations: deduped, collisionCandidates, dropped, endCounter: counter };
}

function dedupeOperations(ops: readonly Operation[]): Operation[] {
  // Идём с конца, чтобы оставить ПОСЛЕДНюю update_character на (targetId, field).
  const lastUpdateIdx = new Map<string, number>();
  const seenAlias = new Set<string>();
  ops.forEach((op, i) => {
    if (op.kind === "update_character") {
      const key = `${op.targetId}::${op.field}`;
      lastUpdateIdx.set(key, i);
    }
  });

  const out: Operation[] = [];
  ops.forEach((op, i) => {
    if (op.kind === "update_character") {
      const key = `${op.targetId}::${op.field}`;
      if (lastUpdateIdx.get(key) !== i) return;
    } else if (op.kind === "add_alias") {
      const key = `${op.targetId}::${op.alias}`;
      if (seenAlias.has(key)) return;
      seenAlias.add(key);
    }
    out.push(op);
  });
  return out;
}

function isNewEntityValid(e: NewEntityResponse): boolean {
  return (
    typeof e.name === "string" &&
    e.name.trim().length > 0 &&
    typeof e.evidence === "string" &&
    e.evidence.trim().length > 0 &&
    typeof e.confidence === "number"
  );
}

function whyEntityInvalid(e: NewEntityResponse): string {
  const missing: string[] = [];
  if (typeof e.name !== "string" || e.name.trim() === "") missing.push("name");
  if (typeof e.evidence !== "string" || e.evidence.trim() === "") missing.push("evidence");
  if (typeof e.confidence !== "number") missing.push("confidence");
  return missing.length > 0 ? `missing ${missing.join(", ")}` : "validation failed";
}

function missingFields(required: Record<string, unknown>): string {
  const missing = Object.entries(required)
    .filter(([, v]) => v === undefined || v === null || v === "")
    .map(([k]) => k);
  return missing.length > 0 ? `missing ${missing.join(", ")}` : "validation failed";
}

function logDrop(opType: string, reason: string, evidence: string | undefined): void {
  const snippet = typeof evidence === "string" ? evidence.slice(0, 100) : "<no evidence>";
  console.warn(`[BookRAG] drop ${opType}: ${reason}. evidence: "${snippet}"`);
}
