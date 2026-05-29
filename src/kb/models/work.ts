export type ModelProfile = "light" | "balanced";

export type AnalysisStatus = "queued" | "running" | "done" | "error";

export interface Work {
  id: string;
  title: string;
  siteUrl: string;
  createdAt: number;
}

export interface Chapter {
  id: string;
  workId: string;
  number: number;
  title: string;
  url: string;
  contentHash: string;
  createdAt: number;
}

export interface AnalysisRun {
  id: string;
  workId: string;
  chapterId: string;
  modelProfile: ModelProfile;
  status: AnalysisStatus;
  startedAt: number;
  finishedAt?: number;
  error?: string;
}
