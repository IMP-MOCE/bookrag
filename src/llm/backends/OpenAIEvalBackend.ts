// Диагностический бэкенд для A/B-сравнения FT-моделей: ходит в локальный
// OpenAI-совместимый HTTP-сервер (eval/scripts/serve_openai_transformers.py),
// который раскатывает merged HF-чекпоинт через transformers. Те же веса и тот же
// промпт, что и у MLC q4f16_1 в проде — но без xgrammar, без WebGPU-квантизации
// и с эталонным `<think>\n` префиксом из HF jinja apply_chat_template.
//
// Не для прода. Включается явно: chrome.storage.local["bookrag.inferenceBackend"]
// = "openai-eval", endpoint в "bookrag.openaiEvalEndpoint" (по умолчанию
// http://127.0.0.1:8000). resolveBackend() прозрачно маршрутизирует в обход
// компаньона и offscreen WebLLM.

import type { LlmBackend, LlmGenerateOptions, LlmMessage } from "./LlmBackend";

// Таймауты согласованы с CompanionBackend — холодный generate на CPU/iGPU
// может занимать минуты, не хочется убить запрос на полпути.
const HEALTH_TIMEOUT_MS = 500;
const GENERATE_TIMEOUT_MS = 30 * 60_000;

export interface OpenAIEvalBackendDeps {
  endpoint: string;
  // Имя model_id, который сервер опубликовал в /v1/models и который мы
  // подставляем в payload `/v1/chat/completions`. Должен совпадать с
  // активным профилем расширения (например, bookrag-qwen4b-ftv6-merged-q4f16_1),
  // иначе ChapterAnalyzer не сможет интерпретировать ответ как родной для
  // профиля. Сервер запускается с `--model-id <тот же id>`.
  modelId?: string;
  fetch?: typeof fetch;
}

interface ModelsListResponse {
  data?: Array<{ id: string }>;
}

interface ChatCompletionResponse {
  choices?: Array<{
    index?: number;
    message?: { role?: string; content?: string | null };
    finish_reason?: string | null;
  }>;
  error?: { message?: string; type?: string };
}

export class OpenAIEvalBackend implements LlmBackend {
  private readonly endpoint: string;
  private readonly fetchFn: typeof fetch;
  private readonly overrideModelId: string | undefined;
  // Последний model_id, для которого мы убедились, что сервер его знает.
  // ensureModel() — no-op после первого успешного сопоставления.
  private verifiedModelId: string | null = null;

  constructor(deps: OpenAIEvalBackendDeps) {
    this.endpoint = deps.endpoint.replace(/\/+$/, "");
    // In Chrome workers, native fetch is brand-checked. Calling it later as
    // `this.fetchFn(...)` would otherwise bind `this` to the backend instance
    // and fail with "Illegal invocation".
    this.fetchFn = (deps.fetch ?? globalThis.fetch).bind(globalThis);
    this.overrideModelId = deps.modelId;
  }

  // /v1/models есть у любого OpenAI-совместимого сервера; короткий пробник
  // достаточен — реальная готовность модели проверяется ensureModel().
  async health(): Promise<boolean> {
    try {
      const resp = await this.request("GET", "/v1/models", undefined, HEALTH_TIMEOUT_MS);
      return resp.ok;
    } catch {
      return false;
    }
  }

  // Eval-сервер грузит ровно одну модель при старте, отдельного /load нет.
  // Здесь только сверяем, что заявленный модельный id совпадает с тем, что
  // у сервера в /v1/models, и кешируем результат.
  async ensureModel(modelId: string, _contextWindowSize?: number): Promise<void> {
    const targetId = this.overrideModelId ?? modelId;
    if (this.verifiedModelId === targetId) return;
    const resp = await this.request("GET", "/v1/models", undefined, HEALTH_TIMEOUT_MS);
    if (!resp.ok) {
      throw new OpenAIEvalError(`/v1/models -> ${resp.status} ${resp.statusText}`, resp.status);
    }
    const body = (await resp.json()) as ModelsListResponse;
    const ids = (body.data ?? []).map((m) => m.id);
    if (!ids.includes(targetId)) {
      throw new OpenAIEvalError(
        `сервер ${this.endpoint} не публикует model_id "${targetId}". Доступно: [${ids.join(", ")}]. ` +
          `Перезапустите serve_openai_transformers.py с --model-id ${targetId}.`,
        404,
      );
    }
    this.verifiedModelId = targetId;
  }

  async generate(
    messages: ReadonlyArray<LlmMessage>,
    opts?: LlmGenerateOptions,
  ): Promise<string> {
    if (!this.verifiedModelId) {
      throw new OpenAIEvalError("ensureModel ещё не вызван — нет проверенного model_id", 0);
    }
    // jsonSchema умышленно НЕ кладём в response_format: eval-сервер игнорирует
    // структурированное декодирование, а MLC-путь в проде тоже его не
    // применяет (см. LocalLLMService._doGenerate, `void opts.jsonSchema`).
    // Схема всё равно зашита в system-prompt, и parser в анализаторе срежет
    // <think>-префикс.
    const body: Record<string, unknown> = {
      model: this.verifiedModelId,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: opts?.temperature ?? 0.1,
      max_tokens: opts?.maxTokens ?? 3072,
      stream: false,
    };

    const resp = await this.request("POST", "/v1/chat/completions", body, GENERATE_TIMEOUT_MS);
    const json = (await resp.json().catch(() => ({}))) as ChatCompletionResponse;
    if (!resp.ok || json.error) {
      const msg = json.error?.message ?? `${resp.status} ${resp.statusText}`;
      throw new OpenAIEvalError(`/v1/chat/completions failed: ${msg}`, resp.status);
    }
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new OpenAIEvalError("ответ без choices[0].message.content", resp.status);
    }
    return content;
  }

  // /unload в OpenAI-протоколе нет; eval-сервер всё равно держит одну модель
  // на всё время процесса. No-op — как и у OffscreenBackend.
  async release(): Promise<void> {
    this.verifiedModelId = null;
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const init: RequestInit = { method, signal: ctrl.signal };
      if (body !== undefined) {
        init.headers = { "Content-Type": "application/json" };
        init.body = JSON.stringify(body);
      }
      return await this.fetchFn(this.endpoint + path, init);
    } finally {
      clearTimeout(timer);
    }
  }
}

export class OpenAIEvalError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "OpenAIEvalError";
  }
}
