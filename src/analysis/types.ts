// Сырой формат ответа модели — соответствует schemas/analysis-response.schema.json и листингу 2.1.
// FTv6: add_relation и create_event удалены, заменены на create_chapter_summary.

export type EntityType = "character" | "location" | "artifact";

export interface NewEntityResponse {
  type: EntityType;
  temp_id?: string;
  name: string;
  aliases?: string[];
  summary?: string;
  role?: string;
  evidence: string;
  confidence: number;
}

export type AnalysisOperationType =
  | "update_character"
  | "add_alias"
  | "create_chapter_summary";

export interface AnalysisOperationResponse {
  type: AnalysisOperationType;
  target_id?: string;
  field?: "summary" | "role" | "status";
  new_value?: string;
  alias?: string;
  // create_chapter_summary fields:
  summary?: string;
  characters_present?: string[];
  locations_present?: string[];
  artifacts_mentioned?: string[];
  key_events_oneline?: string[];
  evidence: string;
  confidence: number;
}

export type CollisionAction = "auto_merge" | "manual_review" | "create_separate";

export interface CollisionCandidateResponse {
  new_character: string;
  candidate: string;
  same_entity_probability: number;
  matched_features?: string[];
  recommended_action: CollisionAction;
}

export interface AnalysisResponse {
  chapter_id?: string;
  new_entities: NewEntityResponse[];
  operations: AnalysisOperationResponse[];
  collision_candidates: CollisionCandidateResponse[];
}
