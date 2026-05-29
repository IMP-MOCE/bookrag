// Настройки выбора LLM-бэкенда (storage.local).
//
// Ключи именованы в едином пространстве `bookrag.*` (как `bookrag.activeProfile`).
// Не объявлены в Endpoints — это пользовательские настройки, а не RPC.

export const INFERENCE_BACKEND_KEY = "bookrag.inferenceBackend";
export const COMPANION_ENDPOINT_KEY = "bookrag.companionEndpoint";
export const OPENAI_EVAL_ENDPOINT_KEY = "bookrag.openaiEvalEndpoint";

// "openai-eval" — диагностический режим: ходим в локальный OpenAI-совместимый
// сервер (eval/scripts/serve_openai_transformers.py). Не для прода; включается
// вручную из chrome.storage.local для A/B-сравнения MLC q4 vs HF transformers.
export type InferenceBackendPreference = "auto" | "browser" | "openai-eval";

export const DEFAULT_INFERENCE_BACKEND: InferenceBackendPreference = "auto";
export const DEFAULT_COMPANION_ENDPOINT = "http://127.0.0.1:8731";
export const DEFAULT_OPENAI_EVAL_ENDPOINT = "http://127.0.0.1:8000";

export interface BackendSettings {
  inferenceBackend: InferenceBackendPreference;
  companionEndpoint: string;
  openaiEvalEndpoint: string;
}

// readBackendSettings возвращает текущие настройки из chrome.storage.local,
// с дефолтами для пустых/неизвестных значений. Безопасно вызывать из SW.
export async function readBackendSettings(): Promise<BackendSettings> {
  const v = await chrome.storage.local.get([
    INFERENCE_BACKEND_KEY,
    COMPANION_ENDPOINT_KEY,
    OPENAI_EVAL_ENDPOINT_KEY,
  ]);
  const pref = v[INFERENCE_BACKEND_KEY];
  const ep = v[COMPANION_ENDPOINT_KEY];
  const evalEp = v[OPENAI_EVAL_ENDPOINT_KEY];
  return {
    inferenceBackend:
      pref === "browser" || pref === "auto" || pref === "openai-eval"
        ? pref
        : DEFAULT_INFERENCE_BACKEND,
    companionEndpoint: typeof ep === "string" && ep.length > 0 ? ep : DEFAULT_COMPANION_ENDPOINT,
    openaiEvalEndpoint:
      typeof evalEp === "string" && evalEp.length > 0 ? evalEp : DEFAULT_OPENAI_EVAL_ENDPOINT,
  };
}
