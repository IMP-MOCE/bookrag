import { similarity } from "../lib/levenshtein";
import { buildKeys, isRedundantAliasForName, normalizeAlias, stripTitles } from "../lib/normalize";
import type { KnowledgeBase } from "./KnowledgeBase";
import type { CharacterCard } from "./models/character";
import type { Operation, EntityRef } from "./operations";

export interface NameDraft {
  name: string;
  aliases?: readonly string[];
}

export interface MatchScore {
  score: number;
  features: string[];
}

export interface MergeCandidate extends MatchScore {
  candidateId: string;
  candidateName: string;
  candidateAliases: string[];
}

export type MergeAction = "auto_merge" | "manual_review" | "create_separate";

export interface MergeDecision {
  action: MergeAction;
  candidate?: MergeCandidate;
}

export interface PendingReview {
  newCharacterTempId: string;
  candidateId: string;
  score: number;
  features: string[];
  llmHint?: number;
}

export interface CollisionPlan {
  rewrittenOps: Operation[];
  // Для авто-слияний: модельный/наш tempId → реальный existing id, чтобы вызывающий
  // мог переписать оставшиеся ссылки в собственном пайплайне.
  autoMergeMap: Record<string, string>;
  // Среднеуверенные кандидаты на ручную проверку — закидываются в очередь после applyOperations.
  pendingReviews: PendingReview[];
}

export interface CollisionResolverOptions {
  autoMergeThreshold?: number; // по умолчанию 0.9
  reviewThreshold?: number; // по умолчанию 0.6
}

const DEFAULT_AUTO = 0.9;
const DEFAULT_REVIEW = 0.6;

// Чистая функция: считает score между уже существующей карточкой и черновиком новой.
// Не зависит от KB — удобно тестировать.
export function scorePair(
  candidate: Pick<CharacterCard, "name" | "normalizedName" | "aliases" | "keys">,
  draft: NameDraft,
  llmHint?: number,
): MatchScore {
  const draftName = normalizeAlias(draft.name);
  const draftAliases = (draft.aliases ?? []).map(normalizeAlias);
  const draftKeys = buildKeys(draft.name, draft.aliases ?? []);

  const candName = candidate.normalizedName || normalizeAlias(candidate.name);
  const candAliases = candidate.aliases.map(normalizeAlias);
  const candKeys = candidate.keys;

  const features: string[] = [];
  let score = 0;

  // 1. Точное совпадение основного имени.
  if (draftName && draftName === candName) {
    features.push("exact_name");
    score = Math.max(score, 1.0);
  }

  // 2. Имя draft входит в alias кандидата (или обратно).
  if (candAliases.includes(draftName) || draftAliases.includes(candName)) {
    features.push("alias_match");
    score = Math.max(score, 0.95);
  }

  // 3. Совпадение по любому из псевдонимов.
  for (const da of draftAliases) {
    if (candAliases.includes(da)) {
      features.push(`alias_alias:${da}`);
      score = Math.max(score, 0.9);
      break;
    }
  }

  // 4. Совпадение по multiEntry-ключам (включая имена без титулов).
  // Например, "князь Волков" → ключ "волков" совпадёт с "Алексей Волков" → ключ "волков".
  const overlap = draftKeys.filter((k) => candKeys.includes(k));
  if (overlap.length > 0) {
    const best = overlap.find((k) => k.length >= 5) ?? overlap[0]!;
    features.push(`key_overlap:${best}`);
    score = Math.max(score, 0.85);
  }

  // 5. Нечёткое совпадение Levenshtein на основном имени без титулов.
  const draftStripped = stripTitles(draftName);
  const candStripped = stripTitles(candName);
  if (draftStripped.length >= 4 && candStripped.length >= 4) {
    const sim = similarity(draftStripped, candStripped);
    if (sim >= 0.85) {
      features.push(`fuzzy:${sim.toFixed(2)}`);
      // Кэп ниже порога авто-слияния, чтобы fuzzy сам по себе не триггерил auto.
      score = Math.max(score, Math.min(sim * 0.95, 0.88));
    }
  }

  // 6. Подсказка модели — берём максимум структурного score и хинта,
  // но не выше 0.95 (модель не последняя инстанция, нужна верификация в UI).
  if (typeof llmHint === "number" && llmHint > 0) {
    features.push(`llm_hint:${llmHint.toFixed(2)}`);
    score = Math.max(score, Math.min(llmHint, 0.95));
  }

  return { score, features };
}

export class CollisionResolver {
  private readonly autoThreshold: number;
  private readonly reviewThreshold: number;

  constructor(
    private readonly kb: KnowledgeBase,
    opts: CollisionResolverOptions = {},
  ) {
    this.autoThreshold = opts.autoMergeThreshold ?? DEFAULT_AUTO;
    this.reviewThreshold = opts.reviewThreshold ?? DEFAULT_REVIEW;
  }

  async findCandidates(
    workId: string,
    draft: NameDraft,
    llmHint?: number,
  ): Promise<MergeCandidate[]> {
    const all = await this.kb.listCharacters(workId);
    const out: MergeCandidate[] = [];
    for (const c of all) {
      const result = scorePair(c, draft, llmHint);
      if (result.score >= this.reviewThreshold) {
        out.push({
          candidateId: c.id,
          candidateName: c.name,
          candidateAliases: c.aliases,
          score: result.score,
          features: result.features,
        });
      }
    }
    return out.sort((a, b) => b.score - a.score);
  }

  decide(candidates: readonly MergeCandidate[]): MergeDecision {
    const top = candidates[0];
    if (!top) return { action: "create_separate" };
    if (top.score >= this.autoThreshold) return { action: "auto_merge", candidate: top };
    if (top.score >= this.reviewThreshold) return { action: "manual_review", candidate: top };
    return { action: "create_separate" };
  }

  // Принимает план операций от ChapterAnalyzer, проходит по create_character,
  // подменяет авто-сливаемые на add_alias к существующему персонажу,
  // ставит средне-уверенные в очередь на ручную проверку.
  async planForOperations(
    workId: string,
    operations: readonly Operation[],
    llmHintByTempId: ReadonlyMap<string, number> = new Map(),
  ): Promise<CollisionPlan> {
    const intermediate: Operation[] = [];
    const autoMergeMap: Record<string, string> = {};
    const pendingReviews: PendingReview[] = [];

    for (const op of operations) {
      if (op.kind !== "create_character") {
        intermediate.push(op);
        continue;
      }
      const candidates = await this.findCandidates(
        workId,
        { name: op.name, aliases: op.aliases },
        llmHintByTempId.get(op.tempId),
      );
      const decision = this.decide(candidates);

      if (decision.action === "auto_merge" && decision.candidate) {
        const candidate = decision.candidate;
        const realId = candidate.candidateId;
        autoMergeMap[op.tempId] = realId;

        // Добавим как aliases те имена/псевдонимы, которых ещё нет у кандидата.
        const candidatesToAlias = [op.name, ...op.aliases].filter(
          (a) => !isRedundantAliasForName(candidate.candidateName, candidate.candidateAliases, a),
        );
        for (const newAlias of candidatesToAlias) {
          intermediate.push({
            kind: "add_alias",
            targetId: realId,
            alias: newAlias,
            evidence: op.evidence,
            confidence: op.confidence,
          });
        }
        continue;
      }

      // manual_review или create_separate: создаём карточку.
      intermediate.push(op);
      if (decision.action === "manual_review" && decision.candidate) {
        const review: PendingReview = {
          newCharacterTempId: op.tempId,
          candidateId: decision.candidate.candidateId,
          score: decision.candidate.score,
          features: decision.candidate.features,
        };
        const hint = llmHintByTempId.get(op.tempId);
        if (hint !== undefined) review.llmHint = hint;
        pendingReviews.push(review);
      }
    }

    // Прокинем autoMergeMap во все ссылки subsequent ops.
    const resolveRef = (ref: EntityRef): EntityRef => autoMergeMap[ref] ?? ref;
    const rewrittenOps: Operation[] = intermediate.map((op) => {
      switch (op.kind) {
        case "add_alias":
          return { ...op, targetId: resolveRef(op.targetId) };
        case "update_character":
          return { ...op, targetId: resolveRef(op.targetId) };
        case "create_chapter_summary":
          return {
            ...op,
            charactersPresent: op.charactersPresent.map(resolveRef),
            locationsPresent: op.locationsPresent.map(resolveRef),
            artifactsMentioned: op.artifactsMentioned.map(resolveRef),
          };
        default:
          return op;
      }
    });

    return { rewrittenOps, autoMergeMap, pendingReviews };
  }
}
