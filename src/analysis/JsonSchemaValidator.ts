import type { ErrorObject } from "ajv";
import precompiledValidate from "./__generated__/validate-analysis.js";
import type { AnalysisOperationResponse, AnalysisResponse } from "./types";

export interface SanitizationStats {
  /** Сколько записей new_entities молча выкинули (нарушенные required-поля). */
  newEntities: number;
  /** Сколько operations молча выкинули (отсутствуют per-type required-поля). */
  operations: number;
}

export interface ValidationOk {
  ok: true;
  data: AnalysisResponse;
  dropped: SanitizationStats;
}

export interface ValidationErr {
  ok: false;
  errors: string[];
}

export type ValidationResult = ValidationOk | ValidationErr;

// Используем precompiled standalone-валидатор (см. scripts/precompile-schema.mjs).
// Runtime-компиляция через `Ajv.compile()` упирается в CSP сервис-воркера MV3,
// где запрещён 'unsafe-eval'.
export class JsonSchemaValidator {
  private readonly validate: (data: unknown) => boolean;
  private getErrors: () => ErrorObject[] | null | undefined;

  constructor() {
    this.validate = precompiledValidate;
    this.getErrors = () => precompiledValidate.errors;
  }

  // Полный цикл: распарсить (с попыткой repair), просанировать, затем проверить по схеме.
  parseAndValidate(rawText: string): ValidationResult {
    let text = rawText;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      const repaired = JsonSchemaValidator.tryRepair(rawText);
      if (repaired === null) return { ok: false, errors: ["Не удалось распарсить ответ как JSON"] };
      text = repaired;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, errors: [`JSON.parse после repair: ${message}`] };
      }
    }
    // Sanitize до schema-валидации: после отключения xgrammar guided decoding
    // (см. LocalLLMService.ts) модель иногда добавляет в конец new_entities
    // пустой placeholder ({"type":"","name":"","evidence":""}) или ставит type
    // вне enum (например, "event" в new_entities). Repair-цикл не лечит этот
    // паттерн (модель воспроизводит его и в repair-попытке) — поэтому молча
    // дропаем такие записи здесь, сохраняя остальной валидный контент чанка.
    const dropped = sanitizeInPlace(parsed);
    return this.validateParsed(parsed, dropped);
  }

  validateParsed(value: unknown, dropped: SanitizationStats = { newEntities: 0, operations: 0 }): ValidationResult {
    const ok = this.validate(value);
    if (!ok) {
      const errors = (this.getErrors() ?? []).map(formatError);
      return { ok: false, errors };
    }
    return { ok: true, data: value as AnalysisResponse, dropped };
  }

  // Эвристики чистки распространённых дефектов LLM-вывода.
  static tryRepair(rawText: string): string | null {
    let text = rawText.trim();

    // 1. Убрать ```json ... ``` или ``` ... ``` обёртку.
    const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fenceMatch && fenceMatch[1]) text = fenceMatch[1].trim();

    // 2. Если перед JSON есть прозу — обрезать до первого '{'.
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
    text = text.slice(firstBrace, lastBrace + 1);

    // 3. Убрать висячие запятые перед } и ].
    text = text.replace(/,(\s*[}\]])/g, "$1");

    return text;
  }
}

function formatError(err: ErrorObject): string {
  const path = err.instancePath || "(root)";
  return `${path}: ${err.message ?? "validation error"}`;
}

// Per-type required-поля операций. Зеркало converter.ts:91-156 — должны совпадать.
// FTv6: add_relation и create_event удалены, добавлен create_chapter_summary
// (он требует только summary; characters_present/locations_present/key_events_oneline
// необязательные, но проверяются на типы при apply).
const OPERATION_REQUIREMENTS: Record<string, ReadonlyArray<keyof AnalysisOperationResponse>> = {
  update_character: ["target_id", "field", "new_value"],
  add_alias: ["target_id", "alias"],
  create_chapter_summary: ["summary"],
};

const VALID_NEW_ENTITY_TYPES: ReadonlySet<string> = new Set(["character", "location", "artifact"]);
const VALID_OPERATION_TYPES: ReadonlySet<string> = new Set([
  "update_character",
  "add_alias",
  "create_chapter_summary",
]);

function isValidConfidence(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
}
function isNonEmptyString(v: unknown): boolean {
  return typeof v === "string" && v.trim() !== "";
}

function isValidNewEntity(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const obj = e as Record<string, unknown>;
  if (typeof obj.type !== "string" || !VALID_NEW_ENTITY_TYPES.has(obj.type)) return false;
  if (!isNonEmptyString(obj.name)) return false;
  if (!isNonEmptyString(obj.evidence)) return false;
  if (!isValidConfidence(obj.confidence)) return false;
  return true;
}

function isValidOperation(op: unknown): boolean {
  if (!op || typeof op !== "object") return false;
  const obj = op as Record<string, unknown>;
  if (typeof obj.type !== "string" || !VALID_OPERATION_TYPES.has(obj.type)) return false;
  if (!isNonEmptyString(obj.evidence)) return false;
  if (!isValidConfidence(obj.confidence)) return false;
  const required = OPERATION_REQUIREMENTS[obj.type];
  if (required) {
    for (const k of required) {
      const v = obj[k];
      if (v === undefined || v === null) return false;
      if (typeof v === "string" && v.trim() === "") return false;
    }
  }
  return true;
}

// Молча вычищает невалидные записи из массивов. Мутирует parsed — schema-проверка
// потом видит уже очищенные данные. Возвращает счётчики дропов для лога.
function sanitizeInPlace(parsed: unknown): SanitizationStats {
  const stats: SanitizationStats = { newEntities: 0, operations: 0 };
  if (!parsed || typeof parsed !== "object") return stats;
  const obj = parsed as { new_entities?: unknown; operations?: unknown };
  const rawEntities = obj.new_entities;
  if (Array.isArray(rawEntities)) {
    const filtered = (rawEntities as unknown[]).filter(isValidNewEntity);
    stats.newEntities = rawEntities.length - filtered.length;
    obj.new_entities = filtered;
  }
  const rawOps = obj.operations;
  if (Array.isArray(rawOps)) {
    const filtered = (rawOps as unknown[]).filter(isValidOperation);
    stats.operations = rawOps.length - filtered.length;
    obj.operations = filtered;
  }
  return stats;
}

