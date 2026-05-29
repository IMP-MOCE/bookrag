// Контракты сообщений между UI / content script / background service worker / offscreen-документом.
// Это discriminated union поверх chrome.runtime.sendMessage — типы сообщений соответствуют табл. 2.5
// из отчёта (UI <-> background "endpoints"), плюс отдельный канал для offscreen <-> background.

import type { ParsedChapter } from "../parsers/types";
import type { ProfileId } from "../llm/profiles";
import type { CharacterCard } from "../kb/models/character";
import type { ChapterSummary } from "../kb/models/event";
import type { Artifact, Location } from "../kb/models/location";
import type { CollisionReviewItem, ReviewStatus } from "../kb/models/review";
import type { AnalysisRun, Chapter, Work } from "../kb/models/work";

// ---------- Транспортный слой ----------

export interface Envelope<T extends string = string, P = unknown> {
  bookrag: true;
  id: string;
  type: T;
  payload: P;
}

export type Response<D> =
  | { ok: true; data: D }
  | { ok: false; code: string; message: string };

export const ERROR_CODES = {
  UNKNOWN_TYPE: "unknown_type",
  INVALID_PAYLOAD: "invalid_payload",
  MODEL_NOT_LOADED: "model_not_loaded",
  WEBGPU_UNAVAILABLE: "webgpu_unavailable",
  QUEUE_BUSY: "queue_busy",
  TASK_NOT_FOUND: "task_not_found",
  HANDLER_THREW: "handler_threw",
  OFFSCREEN_TIMEOUT: "offscreen_timeout",
  // Pass 2 (KbReconciler) после repair'ов так и не вернул валидный JSON. Apply
  // принудительно отменён, чтобы Pass 1 ops не создали дубли в KB. UI должен
  // показать сообщение «Сверка с справочником не удалась, повторите анализ».
  RECONCILE_FAILED: "reconcile_failed",
} as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

// ---------- Стрим-события (broadcast от background к подписчикам) ----------

export interface QueueTaskProgress {
  // "reconcile" — Pass 2 (KbReconciler), сверка с KB через LLM. Идёт после
  // "chunk" (Pass 1 extraction) и до "validate" (детерминированный merge).
  stage: "context" | "chunk" | "reconcile" | "validate" | "apply" | "done";
  chunkIndex?: number;
  totalChunks?: number;
  message?: string;
}

export interface QueueTaskSnapshot {
  taskId: string;
  workId: string;
  chapterId: string;
  chapterNumber: number;
  status: "queued" | "running" | "done" | "error" | "cancelled";
  enqueuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  progress?: QueueTaskProgress;
  error?: string;
}

export interface ModelProgressReport {
  profileId: ProfileId;
  text?: string;
  progress?: number;
  timeElapsed?: number;
}

// ---------- DTO для UI ----------

export interface ProfileStateDto {
  id: ProfileId;
  label: string;
  description: string;
  modelId: string;
  approxSizeGb: number;
  approxVramGb: number;
  status: "not_downloaded" | "downloading" | "ready" | "error";
  isActive: boolean;
  errorMessage?: string;
}

export interface DiagnosticsDto {
  webgpuAvailable: boolean;
  webgpuAdapterName?: string;
  webgpuVendor?: string;
  maxBufferSizeMb?: number;
  deviceMemoryGb?: number;
  hardwareConcurrency: number;
  userAgent: string;
}

export interface CharacterEditPatchDto {
  name?: string;
  aliases?: string[];
  summary?: string;
  role?: string;
  status?: string;
  confidence?: number;
}

// ---------- Описание endpoint'ов: payload запроса и payload ответа ----------

export interface Endpoints {
  // ---- Модели ----
  "models/list": { request: Record<string, never>; response: ProfileStateDto[] };
  "models/diagnose": { request: Record<string, never>; response: DiagnosticsDto };
  "models/download": { request: { profileId: ProfileId }; response: { ok: true } };
  "models/remove": { request: { profileId: ProfileId }; response: { ok: true } };
  "models/setActive": { request: { profileId: ProfileId }; response: { ok: true } };

  // ---- Главы и анализ ----
  "chapters/analyze": {
    request: { parsed: ParsedChapter };
    response: { taskId: string };
  };
  "queue/snapshot": { request: Record<string, never>; response: QueueTaskSnapshot[] };
  "queue/cancel": { request: { taskId: string }; response: { ok: true } };

  // ---- Справочник ----
  "kb/listWorks": { request: Record<string, never>; response: Work[] };
  "kb/listChapters": { request: { workId: string }; response: Chapter[] };
  "kb/listCharacters": { request: { workId: string }; response: CharacterCard[] };
  "kb/getCharacter": { request: { id: string }; response: CharacterCard | null };
  "kb/listLocations": { request: { workId: string }; response: Location[] };
  "kb/listArtifacts": { request: { workId: string }; response: Artifact[] };
  "kb/listChapterSummaries": { request: { workId: string }; response: ChapterSummary[] };
  "kb/listRuns": { request: { workId: string }; response: AnalysisRun[] };
  "kb/searchByKey": {
    request: { workId: string; query: string };
    response: { characters: CharacterCard[]; locations: Location[]; artifacts: Artifact[] };
  };
  "kb/updateCharacter": {
    request: { workId: string; characterId: string; patch: CharacterEditPatchDto };
    response: CharacterCard;
  };
  "kb/deleteCharacter": {
    request: { workId: string; characterId: string };
    response: { ok: true };
  };
  "kb/deleteLocation": {
    request: { workId: string; locationId: string };
    response: { ok: true };
  };
  "kb/deleteArtifact": {
    request: { workId: string; artifactId: string };
    response: { ok: true };
  };

  // ---- Очередь ручной проверки коллизий ----
  "review/listPending": { request: { workId: string }; response: CollisionReviewItem[] };
  "review/resolve": {
    request: {
      reviewId: string;
      decision: Exclude<ReviewStatus, "pending">;
      note?: string;
      // Если decision === "merged" — нужно знать, какая карточка остаётся primary.
      mergeIntoCandidate?: boolean;
    };
    response: { ok: true };
  };

  // ---- Слияние / связи ----
  "kb/mergeCharacters": {
    request: { workId: string; primaryId: string; secondaryId: string; reason: string };
    response: { ok: true };
  };
  // FTv6: kb/listRelationships удалён — relations больше не хранятся как сущность.

  // ---- UI ----
  "ui/openSidePanel": {
    request: { workId?: string; entityId?: string };
    response: { ok: true };
  };

  // ---- Content script ----
  // Обрабатывается не SW, а content script текущей вкладки (вызывается через
  // chrome.tabs.sendMessage). Запрос: распарсить активную страницу и вернуть результат.
  "content/parse": {
    request: Record<string, never>;
    response: { parsed: ParsedChapter | null; adapterIds: string[] };
  };

  // ---- Экспорт / импорт ----
  "kb/export": {
    request: { workId?: string };
    response: { json: string };
  };
  "kb/import": {
    request: { json: string };
    response: { merged: number };
  };
}

export type MessageType = keyof Endpoints;
export type RequestOf<T extends MessageType> = Endpoints[T]["request"];
export type ResponseOf<T extends MessageType> = Endpoints[T]["response"];

// ---------- Broadcast-канал ----------

export interface Broadcasts {
  "broadcast/queue": QueueTaskSnapshot;
  "broadcast/queueAll": QueueTaskSnapshot[];
  "broadcast/modelProgress": ModelProgressReport;
  "broadcast/kbChanged": { workId: string; reason: "analysis" | "merge" | "edit" | "delete" | "import" };
}

export type BroadcastType = keyof Broadcasts;
export type BroadcastPayload<T extends BroadcastType> = Broadcasts[T];

// ---------- Канал offscreen <-> background ----------

export interface OffscreenEndpoints {
  "offscreen/loadModel": {
    request: { modelId: string; contextWindowSize?: number };
    response: { loaded: true; modelId: string };
  };
  "offscreen/unload": { request: Record<string, never>; response: { unloaded: true } };
  "offscreen/deleteModel": {
    request: { modelId: string };
    response: { deleted: true };
  };
  "offscreen/generate": {
    request: {
      messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
      jsonSchema?: object;
      temperature?: number;
      maxTokens?: number;
    };
    response: { content: string };
  };
  "offscreen/diagnose": {
    request: Record<string, never>;
    response: DiagnosticsDto;
  };
  "offscreen/ping": { request: Record<string, never>; response: { pong: true } };
}

export type OffscreenMessageType = keyof OffscreenEndpoints;
export type OffscreenRequestOf<T extends OffscreenMessageType> = OffscreenEndpoints[T]["request"];
export type OffscreenResponseOf<T extends OffscreenMessageType> = OffscreenEndpoints[T]["response"];

// Односторонние сигналы offscreen → background. Не вписываются в request/response,
// потому что offscreen-документ просто шлёт их по факту (прогресс, готовность).
export interface OffscreenSignals {
  "offscreen/ready": Record<string, never>;
  "offscreen/loadProgress": {
    modelId: string;
    text?: string;
    progress?: number;
    timeElapsed?: number;
  };
}
export type OffscreenSignalType = keyof OffscreenSignals;

// ---------- Утилиты ----------

export function isEnvelope(value: unknown): value is Envelope {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { bookrag?: unknown }).bookrag === true &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

export function makeEnvelope<T extends string, P>(type: T, payload: P): Envelope<T, P> {
  return {
    bookrag: true,
    id: typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `env-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type,
    payload,
  };
}
