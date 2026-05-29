// Pass 2 для two-pass extraction. На вход — operations и collisionCandidates
// из ChapterAnalyzer (Pass 1, с light-KB context); на выход — то же, обогащённое
// решениями LLM о совпадениях с существующими KB-карточками.
//
// Зачем это нужно: при полном KB-блоке (summary/role/status) в Pass 1 prompt
// модель в q4-квантизации уходит в FAST-EMPTY — видит «характеристики уже
// описаны» и возвращает пустые arrays. Решение — light-extraction (только
// aliases) + отдельный второй LLM-вызов на сверку. Pass 2 prompt устроен
// принципиально иначе и без «уже описано»-триггеров.

import type { ErrorObject } from "ajv";
import type { KnowledgeBase } from "../kb/KnowledgeBase";
import type { Artifact, Location } from "../kb/models/location";
import type { Operation, UpdateCharacterOp } from "../kb/operations";
import { CollisionResolver, scorePair, type MergeCandidate } from "../kb/CollisionResolver";
import precompiledValidate from "./__generated__/validate-reconcile.js";
import type { AnalysisLLMClient } from "./ChapterAnalyzer";
import {
  MAX_CANDIDATES_PER_DRAFT,
  RECONCILE_SYSTEM_PROMPT,
  buildReconcileRepairPrompt,
  buildReconcileUserPrompt,
  type ReconcileCandidate,
  type ReconcileDraft,
} from "./reconcile-prompts";
import type { CollisionCandidateResponse } from "./types";

// Результаты валидации точно соответствуют структуре в reconcile-response.schema.json.
interface DecisionRaw {
  temp_id: string;
  kind: "character" | "location" | "artifact";
  decision: "match" | "new";
  candidate_id?: string;
  probability: number;
  matched_features?: string[];
  transferable_facts?: Array<{ field: "summary" | "role" | "status"; new_value: string }>;
}

interface ReconcileResponse {
  decisions: DecisionRaw[];
}

// "llm_failed" больше НЕ входит в SkipReason: hard-fail Pass 2 теперь не
// возвращается как мягкий skip, а пробрасывается через ReconcileFailedError —
// иначе caller применил бы Pass 1 ops к KB без сверки и создал дубли.
export type SkipReason = "no_drafts" | "no_kb" | "no_overlap" | null;

// Hard-fail Pass 2: модель не вернула валидный reconcile-JSON даже после repair'ов.
// Caller (handler / CLI) ОБЯЗАН поймать это исключение и НЕ применять ops к KB —
// иначе вторая встреча сущности создаст дубликат вместо merge'а в существующую
// карточку. По принципу «недопустимо пускать новые данные без Pass 2» (2026-05-24).
export class ReconcileFailedError extends Error {
  constructor(
    public readonly attempts: number,
    public readonly errors: readonly string[],
    public readonly rawResponses: readonly string[],
  ) {
    super(
      `KbReconciler: Pass 2 не вернул валидный JSON за ${attempts} попыток. ` +
        `Последние ошибки: ${errors.join("; ")}`,
    );
    this.name = "ReconcileFailedError";
  }
}

export interface ReconcileInput {
  workId: string;
  operations: readonly Operation[];
  collisionCandidates: readonly CollisionCandidateResponse[];
}

export interface ReconcileResult {
  operations: Operation[];
  collisionCandidates: CollisionCandidateResponse[];
  llmHints: Map<string, number>;
  skipped: SkipReason;
  // Диагностика: сколько драфтов попало в LLM-промпт и сколько decisions
  // пришло обратно. Полезно для логов / отладки.
  draftsSent: number;
  decisionsReceived: number;
}

const RECONCILE_TEMPERATURE = 0.1;
// Pass 2 ответ почти всегда короткий: per-entity decision на 20 entities ~ 1200
// токенов. 2048 даёт запас на transferable_facts с длинными новыми summary.
const RECONCILE_MAX_TOKENS = 2048;

// 2 попытки repair: первая — общая ("ошибки validation"), вторая — модель уже
// видела свой первый ответ и список ошибок дословно. Дальнейшие попытки дают
// diminishing returns (Pass 2 prompt короткий и стабильный, если модель не
// смогла за 2 — что-то фундаментально не так).
const DEFAULT_RECONCILE_REPAIR_ATTEMPTS = 2;

export interface KbReconcilerOptions {
  maxRepairAttempts?: number;
}

export class KbReconciler {
  // CollisionResolver уже умеет искать кандидатов для характеров; для loc/art
  // делаем то же руками через scorePair над generic-карточкой.
  private readonly resolver: CollisionResolver;
  private readonly maxRepairAttempts: number;

  constructor(
    private readonly llm: AnalysisLLMClient,
    private readonly kb: KnowledgeBase,
    opts: KbReconcilerOptions = {},
  ) {
    this.resolver = new CollisionResolver(kb);
    this.maxRepairAttempts = opts.maxRepairAttempts ?? DEFAULT_RECONCILE_REPAIR_ATTEMPTS;
  }

  async reconcile(input: ReconcileInput): Promise<ReconcileResult> {
    const drafts = extractDrafts(input.operations);

    if (drafts.length === 0) {
      return emptyResult(input, "no_drafts");
    }

    const [allChars, allLocs, allArts] = await Promise.all([
      this.kb.listCharacters(input.workId),
      this.kb.listLocations(input.workId),
      this.kb.listArtifacts(input.workId),
    ]);
    if (allChars.length === 0 && allLocs.length === 0 && allArts.length === 0) {
      return emptyResult(input, "no_kb");
    }

    const candidatesByDraft = new Map<string, ReconcileCandidate[]>();
    let totalCandidates = 0;
    for (const draft of drafts) {
      let cands: ReconcileCandidate[];
      if (draft.kind === "character") {
        const merged = await this.resolver.findCandidates(
          input.workId,
          { name: draft.name, aliases: draft.aliases },
        );
        cands = merged.slice(0, MAX_CANDIDATES_PER_DRAFT).map(mergeCandidateToReconcile);
      } else if (draft.kind === "location") {
        cands = pickNamedCandidates(allLocs, draft).slice(0, MAX_CANDIDATES_PER_DRAFT);
      } else {
        cands = pickNamedCandidates(allArts, draft).slice(0, MAX_CANDIDATES_PER_DRAFT);
      }
      candidatesByDraft.set(draft.tempId, cands);
      totalCandidates += cands.length;
    }

    if (totalCandidates === 0) {
      return emptyResult(input, "no_overlap");
    }

    // LLM call для финального решения. С repair-loop'ом: если ответ не парсится
    // или не проходит validate-reconcile.js, кидаем repair-prompt с ошибками и
    // запрашиваем исправленный JSON. После исчерпания попыток — ReconcileFailedError,
    // и caller ОБЯЗАН прервать apply (см. handler.ts).
    const userPrompt = buildReconcileUserPrompt(drafts, candidatesByDraft);
    const baseMessages = [
      { role: "system" as const, content: RECONCILE_SYSTEM_PROMPT },
      { role: "user" as const, content: userPrompt },
    ];

    let raw = await this.callLlm(baseMessages);
    let parsed = parseAndValidate(raw);
    const allRaw: string[] = [raw];
    let attempts = 0;

    while (!parsed.ok && attempts < this.maxRepairAttempts) {
      attempts++;
      console.warn(
        `[KbReconciler] Pass 2 невалиден (repair ${attempts}/${this.maxRepairAttempts}). ` +
          `Errors: ${parsed.errors.join("; ")}`,
      );
      const repairMessages = [
        ...baseMessages,
        { role: "assistant" as const, content: raw },
        { role: "user" as const, content: buildReconcileRepairPrompt(raw, parsed.errors) },
      ];
      raw = await this.callLlm(repairMessages);
      allRaw.push(raw);
      parsed = parseAndValidate(raw);
    }

    if (!parsed.ok) {
      // Hard-fail: cluster в логе чтобы было видно полный диалог.
      console.error(
        `[KbReconciler] Pass 2 НЕ исправлен за ${attempts} repair-попыток. ` +
          `Apply ДОЛЖЕН быть пропущен (иначе создадим дубли в KB). ` +
          `Errors: ${parsed.errors.join("; ")}`,
      );
      throw new ReconcileFailedError(attempts + 1, parsed.errors, allRaw);
    }

    return assembleResult(input, drafts, candidatesByDraft, parsed.data.decisions);
  }

  private async callLlm(
    messages: ReadonlyArray<{ role: "system" | "user" | "assistant"; content: string }>,
  ): Promise<string> {
    return this.llm.generate(messages, {
      temperature: RECONCILE_TEMPERATURE,
      maxTokens: RECONCILE_MAX_TOKENS,
    });
  }
}

// ---------- Хелперы ----------

function extractDrafts(operations: readonly Operation[]): ReconcileDraft[] {
  const drafts: ReconcileDraft[] = [];
  for (const op of operations) {
    if (op.kind === "create_character") {
      drafts.push({
        tempId: op.tempId,
        kind: "character",
        name: op.name,
        aliases: op.aliases,
        evidence: op.evidence,
      });
    } else if (op.kind === "create_location") {
      drafts.push({ tempId: op.tempId, kind: "location", name: op.name, aliases: [], evidence: op.evidence });
    } else if (op.kind === "create_artifact") {
      drafts.push({ tempId: op.tempId, kind: "artifact", name: op.name, aliases: [], evidence: op.evidence });
    }
  }
  return drafts;
}

// Поиск кандидатов для location/artifact: у NamedEntity нет aliases, поэтому
// scorePair вызываем с пустым массивом псевдонимов draft'а; sort + slice.
function pickNamedCandidates(
  entities: readonly (Location | Artifact)[],
  draft: ReconcileDraft,
): ReconcileCandidate[] {
  const REVIEW_THRESHOLD = 0.6;
  const scored: Array<{ entity: Location | Artifact; score: number }> = [];
  for (const entity of entities) {
    // scorePair ожидает Pick<CharacterCard,name|normalizedName|aliases|keys>.
    // Location/Artifact подходят по структуре, кроме aliases (нет поля).
    // Подкладываем пустой массив.
    const result = scorePair(
      { name: entity.name, normalizedName: entity.normalizedName, aliases: [], keys: entity.keys },
      { name: draft.name, aliases: draft.aliases },
    );
    if (result.score >= REVIEW_THRESHOLD) {
      scored.push({ entity, score: result.score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map(({ entity }) => ({ id: entity.id, name: entity.name, aliases: [] }));
}

function mergeCandidateToReconcile(c: MergeCandidate): ReconcileCandidate {
  return { id: c.candidateId, name: c.candidateName, aliases: c.candidateAliases };
}

function emptyResult(input: ReconcileInput, skipped: SkipReason): ReconcileResult {
  return {
    operations: [...input.operations],
    collisionCandidates: [...input.collisionCandidates],
    llmHints: new Map(),
    skipped,
    draftsSent: 0,
    decisionsReceived: 0,
  };
}

type ParseResult = { ok: true; data: ReconcileResponse } | { ok: false; errors: string[] };

function parseAndValidate(raw: string): ParseResult {
  const extracted = extractFirstJsonObject(raw);
  if (!extracted) {
    return { ok: false, errors: ["JSON not found in response"] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted);
  } catch (err) {
    return { ok: false, errors: [`JSON.parse failed: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const sanitized = sanitizeReconcileResponse(parsed);
  if (!sanitized.ok) {
    return sanitized;
  }
  const ok = precompiledValidate(sanitized.data);
  if (!ok) {
    const errs = (precompiledValidate.errors ?? []).map(
      (e: ErrorObject) => `${e.instancePath || "(root)"}: ${e.message ?? "validation error"}`,
    );
    return { ok: false, errors: errs };
  }
  return { ok: true, data: sanitized.data };
}

function extractFirstJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start === -1) return null;

  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]!;

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      stack.push(ch);
      continue;
    }
    if (ch !== "}" && ch !== "]") continue;

    const open = stack.at(-1);
    if ((ch === "}" && open !== "{") || (ch === "]" && open !== "[")) {
      return null;
    }
    stack.pop();
    if (stack.length === 0) {
      return raw.slice(start, i + 1);
    }
  }

  if (inString || stack.length === 0) return null;
  const closers = stack
    .reverse()
    .map((open) => (open === "{" ? "}" : "]"))
    .join("");
  return raw.slice(start) + closers;
}

function sanitizeReconcileResponse(parsed: unknown): ParseResult {
  if (!isRecord(parsed)) {
    return { ok: false, errors: ["(root): must be an object"] };
  }
  const decisionsRaw = parsed.decisions;
  if (!Array.isArray(decisionsRaw)) {
    return { ok: false, errors: ["/decisions: must be array"] };
  }

  const decisions: DecisionRaw[] = [];
  for (let i = 0; i < decisionsRaw.length; i++) {
    const raw = decisionsRaw[i];
    if (!isRecord(raw)) {
      return { ok: false, errors: [`/decisions/${i}: must be object`] };
    }

    const tempId = raw.temp_id;
    const kind = raw.kind;
    const decision = raw.decision;
    const probability = raw.probability;
    if (typeof tempId !== "string" || tempId.length === 0) {
      return { ok: false, errors: [`/decisions/${i}/temp_id: must be non-empty string`] };
    }
    if (!isEntityKind(kind)) {
      return { ok: false, errors: [`/decisions/${i}/kind: must be character|location|artifact`] };
    }
    if (decision !== "match" && decision !== "new") {
      return { ok: false, errors: [`/decisions/${i}/decision: must be match|new`] };
    }
    if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) {
      return { ok: false, errors: [`/decisions/${i}/probability: must be number 0..1`] };
    }

    const out: DecisionRaw = {
      temp_id: tempId,
      kind,
      decision,
      probability,
    };

    if (decision === "match") {
      if (typeof raw.candidate_id !== "string" || raw.candidate_id.length === 0) {
        return { ok: false, errors: [`/decisions/${i}/candidate_id: match requires non-empty candidate_id`] };
      }
      out.candidate_id = raw.candidate_id;
    }

    if (Array.isArray(raw.matched_features)) {
      const matched = raw.matched_features.filter((v): v is string => typeof v === "string");
      if (matched.length > 0) out.matched_features = matched;
    }

    if (Array.isArray(raw.transferable_facts)) {
      const facts = raw.transferable_facts.filter(isTransferableFact);
      if (facts.length > 0) out.transferable_facts = facts;
    }

    decisions.push(out);
  }

  return { ok: true, data: { decisions } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEntityKind(value: unknown): value is DecisionRaw["kind"] {
  return value === "character" || value === "location" || value === "artifact";
}

function isTransferableFact(
  value: unknown,
): value is NonNullable<DecisionRaw["transferable_facts"]>[number] {
  if (!isRecord(value)) return false;
  const field = value.field;
  return (
    (field === "summary" || field === "role" || field === "status") &&
    typeof value.new_value === "string" &&
    value.new_value.length > 0
  );
}

function assembleResult(
  input: ReconcileInput,
  drafts: readonly ReconcileDraft[],
  candidatesByDraft: ReadonlyMap<string, readonly ReconcileCandidate[]>,
  decisions: readonly DecisionRaw[],
): ReconcileResult {
  const draftByTemp = new Map(drafts.map((d) => [d.tempId, d]));
  const llmHints = new Map<string, number>();
  const extraOps: Operation[] = [];
  const extraCollisions: CollisionCandidateResponse[] = [];

  for (const dec of decisions) {
    const draft = draftByTemp.get(dec.temp_id);
    if (!draft) continue; // модель придумала temp_id вне списка — игнорируем

    if (dec.decision !== "match") continue;

    const candidateId = dec.candidate_id;
    if (typeof candidateId !== "string" || candidateId === "") continue;

    // Проверяем, что candidate_id реально был в списке кандидатов этого draft'а —
    // иначе модель «галлюцинирует» id, лучше не доверять.
    const candList = candidatesByDraft.get(dec.temp_id) ?? [];
    if (!candList.some((c) => c.id === candidateId)) continue;

    llmHints.set(dec.temp_id, dec.probability);

    const collision: CollisionCandidateResponse = {
      new_character: dec.temp_id,
      candidate: candidateId,
      same_entity_probability: dec.probability,
      recommended_action: pickAction(dec.probability),
    };
    if (dec.matched_features) collision.matched_features = dec.matched_features;
    extraCollisions.push(collision);

    // Перенос фактов работает только для characters: схема Location/Artifact не
    // имеет полей summary/role/status в виде apply-able operations.
    if (draft.kind === "character" && dec.transferable_facts) {
      for (const fact of dec.transferable_facts) {
        const op: UpdateCharacterOp = {
          kind: "update_character",
          targetId: candidateId,
          field: fact.field,
          newValue: fact.new_value,
          evidence: draft.evidence,
          confidence: dec.probability,
        };
        extraOps.push(op);
      }
    }
  }

  return {
    operations: [...input.operations, ...extraOps],
    collisionCandidates: [...input.collisionCandidates, ...extraCollisions],
    llmHints,
    skipped: null,
    draftsSent: drafts.length,
    decisionsReceived: decisions.length,
  };
}

function pickAction(probability: number): "auto_merge" | "manual_review" | "create_separate" {
  if (probability >= 0.9) return "auto_merge";
  if (probability >= 0.6) return "manual_review";
  return "create_separate";
}
