export type ReviewStatus = "pending" | "merged" | "kept_separate";

export interface CollisionReviewItem {
  id: string;
  workId: string;
  chapterId: string;
  newCharacterId: string; // уже созданная карточка-кандидат на слияние
  candidateId: string; // существующая карточка, на которую похожа новая
  score: number;
  features: string[];
  llmHint?: number;
  status: ReviewStatus;
  createdAt: number;
  resolvedAt?: number;
  resolutionNote?: string;
}
