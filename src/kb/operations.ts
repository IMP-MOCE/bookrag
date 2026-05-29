// Операции, которые ChapterAnalyzer формирует из ответа LLM, а KnowledgeBase
// применяет к IndexedDB. EntityRef может быть либо реальным id (созданным ранее),
// либо tempId вида "tmp:<n>" — для сущностей, рождённых в этом же батче через create_*.
//
// FTv6 (2026-05-26): удалены `add_relation` и `create_event`. Вместо event'ов
// вводится `create_chapter_summary` — одна summary на главу с participants и
// списком key_events_oneline. Relations покрываются полем `role` персонажа.

export type EntityRef = string;

export interface BaseOpFields {
  evidence: string;
  confidence: number;
}

export interface CreateCharacterOp extends BaseOpFields {
  kind: "create_character";
  tempId: string;
  name: string;
  aliases: string[];
  summary: string;
  role?: string;
}

export interface UpdateCharacterOp extends BaseOpFields {
  kind: "update_character";
  targetId: EntityRef;
  field: "summary" | "role" | "status";
  newValue: string;
}

export interface AddAliasOp extends BaseOpFields {
  kind: "add_alias";
  targetId: EntityRef;
  alias: string;
}

export interface CreateLocationOp extends BaseOpFields {
  kind: "create_location";
  tempId: string;
  name: string;
  summary: string;
}

export interface CreateArtifactOp extends BaseOpFields {
  kind: "create_artifact";
  tempId: string;
  name: string;
  summary: string;
}

// FTv6: новая операция вместо create_event. Одна на главу (multi-chunk главы
// аггрегируются в SummaryAggregator перед apply). characters_present /
// locations_present / artifacts_mentioned могут содержать как temp_id (если
// сущность создана в этом же ответе), так и canonical KB-id. tempIdMap в
// applyOperations резолвит первое.
export interface CreateChapterSummaryOp extends BaseOpFields {
  kind: "create_chapter_summary";
  summary: string;
  charactersPresent: EntityRef[];
  locationsPresent: EntityRef[];
  artifactsMentioned: EntityRef[];
  keyEventsOneline: string[];
}

export type Operation =
  | CreateCharacterOp
  | UpdateCharacterOp
  | AddAliasOp
  | CreateLocationOp
  | CreateArtifactOp
  | CreateChapterSummaryOp;

export function isTempRef(ref: EntityRef): boolean {
  return ref.startsWith("tmp:");
}

// Сортировка для безопасного порядка применения: сначала создания сущностей
// (чтобы tempId успели разрезолвиться), затем aliases/updates, и в конце
// chapter_summary — он ссылается на participants и должен видеть резолвнутые id.
const KIND_PRIORITY: Record<Operation["kind"], number> = {
  create_character: 0,
  create_location: 0,
  create_artifact: 0,
  add_alias: 1,
  update_character: 1,
  create_chapter_summary: 2,
};

export function sortOperations(ops: readonly Operation[]): Operation[] {
  return [...ops].sort((a, b) => KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind]);
}
