// Профили моделей. Не импортируем @mlc-ai/web-llm — этот пакет тянет 6 МБ кода и
// падает при загрузке в MV3 service worker (нет window/document). model_id
// фиксируем в `fallbackModelId`; web-llm всё равно резолвит его внутри себя
// при загрузке в offscreen-документе.

export const PROFILE_IDS = ["light", "balanced"] as const;
export type ProfileId = (typeof PROFILE_IDS)[number];

export interface ModelProfile {
  id: ProfileId;
  label: string;
  description: string;
  // Канонический model_id из prebuiltAppConfig, который реально грузит web-llm.
  fallbackModelId: string;
  approxSizeGb: number;
  approxVramGb: number;
  // Перебивает context_window_size, прибитый в prebuiltAppConfig (у Qwen3.5 — 4096,
  // мало для RAG-промптов; родной контекст модели — 32k+). Подбирается под VRAM:
  // KV-кэш растёт линейно с этой величиной.
  contextWindowSize: number;
}

export const PROFILES: readonly ModelProfile[] = [
  {
    id: "light",
    label: "Лёгкий",
    description: "Qwen3.5 2B FTv5 (Q4) — быстрый, для слабых устройств и проверки сценариев.",
    fallbackModelId: "bookrag-qwen2b-ftv5-merged-q4f16_1",
    approxSizeGb: 1.3,
    approxVramGb: 2.2,
    contextWindowSize: 16384,
  },
  {
    id: "balanced",
    label: "Сбалансированный",
    description: "Qwen3.5 4B FTv6 (Q4) — основной профиль для извлечения сущностей и операций.",
    fallbackModelId: "bookrag-qwen4b-ftv6-merged-q4f16_1",
    approxSizeGb: 2.5,
    approxVramGb: 3.9,
    // 6144 хватает урезанному промпту + repair-эху; 12288 раздувал KV-кэш и
    // давил общую память iGPU (780M), просаживая decode.
    contextWindowSize: 6144,
  },
] as const;

export function isProfileId(value: unknown): value is ProfileId {
  return typeof value === "string" && (PROFILE_IDS as readonly string[]).includes(value);
}

export function getProfileById(id: ProfileId): ModelProfile {
  const profile = PROFILES.find((p) => p.id === id);
  if (!profile) throw new Error(`Unknown profile: ${id}`);
  return profile;
}

export interface ResolvedModel {
  modelId: string;
  vramRequiredMb?: number;
  lowResource: boolean;
  contextWindowSize: number;
}

export function resolveModel(profile: ModelProfile): ResolvedModel {
  return {
    modelId: profile.fallbackModelId,
    lowResource: false,
    contextWindowSize: profile.contextWindowSize,
  };
}
