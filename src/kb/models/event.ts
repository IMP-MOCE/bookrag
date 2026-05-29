// FTv6 (2026-05-26): create_event/BookEvent удалены из системы. Файл оставлен
// под FactEvidence + EvidenceTargetType, которые продолжают существовать для
// character/location/artifact/chapter_summary.

export type EvidenceTargetType =
  | "character"
  | "location"
  | "artifact"
  | "chapter_summary";

export interface FactEvidence {
  id: string;
  workId: string;
  chapterId: string;
  targetType: EvidenceTargetType;
  targetId: string;
  snippet: string;
  confidence: number;
  createdAt: number;
}

// FTv6: новая сущность вместо BookEvent. Одна на главу (мульти-чанковые главы
// аггрегируются в SummaryAggregator на этапе analyze).
export interface ChapterSummary {
  id: string;
  workId: string;
  chapterId: string;
  chapterNumber: number;
  summary: string;
  charactersPresent: string[]; // только canonical KB-id (после applyOperations)
  locationsPresent: string[];
  artifactsMentioned: string[];
  keyEventsOneline: string[];
  confidence: number;
  createdAt: number;
}
