// HTTP-клиент к локальному компаньону BookRAG (см. companion/).
//
// Контракт демона зеркалит offscreen: /health, /load, /unload, /generate.
// При нынешнем v1 stream:false — генерация одноразовая (non-stream); SSE-
// проводка зарезервирована на потом, сейчас её добавление не требуется
// контрактом анализатора.

import type { LlmBackend, LlmGenerateOptions, LlmMessage } from "./LlmBackend";

// Таймауты. Полная аналогия с offscreen: дешёвая проверка ~300мс, загрузка/
// генерация — до получаса (на холодной модели первый запрос — это spawn
// llama-server + load в VRAM + warmup; см. companion M2/M3).
const HEALTH_TIMEOUT_MS = 300;
const LOAD_TIMEOUT_MS = 30 * 60_000;
const GENERATE_TIMEOUT_MS = 30 * 60_000;
const UNLOAD_TIMEOUT_MS = 30_000;

export interface CompanionBackendDeps {
  // Базовый URL без хвостового слэша (например, "http://127.0.0.1:8731").
  endpoint: string;
  // Инъекция fetch для тестов. По умолчанию — глобальный fetch.
  fetch?: typeof fetch;
}

interface HealthResponse {
  ok: boolean;
  modelReady?: boolean;
  modelId?: string | null;
  version?: string;
}

interface GenerateResponse {
  content: string;
}

export class CompanionBackend implements LlmBackend {
  private readonly endpoint: string;
  private readonly fetchFn: typeof fetch;

  constructor(deps: CompanionBackendDeps) {
    // Нормализация: убираем хвостовой слэш, чтобы не получить "//health".
    this.endpoint = deps.endpoint.replace(/\/+$/, "");
    this.fetchFn = deps.fetch ?? fetch;
  }

  // health — короткий пробник. Любой сбой (нет сети, таймаут, не 2xx,
  // парс-ошибка) → false. Никогда не бросает: вызывающий код решает
  // только по boolean'у, не должен ловить исключения.
  async health(): Promise<boolean> {
    try {
      const resp = await this.request("GET", "/health", undefined, HEALTH_TIMEOUT_MS);
      if (!resp.ok) return false;
      const body = (await resp.json()) as HealthResponse;
      return body.ok === true;
    } catch {
      return false;
    }
  }

  async ensureModel(modelId: string, contextWindowSize?: number): Promise<void> {
    const payload: { modelId: string; contextWindowSize?: number } = { modelId };
    if (typeof contextWindowSize === "number") payload.contextWindowSize = contextWindowSize;
    const resp = await this.request("POST", "/load", payload, LOAD_TIMEOUT_MS);
    if (!resp.ok) {
      throw new CompanionError(`/load failed: ${resp.status}`, resp.status);
    }
  }

  async generate(
    messages: ReadonlyArray<LlmMessage>,
    opts?: LlmGenerateOptions,
  ): Promise<string> {
    const payload: {
      messages: Array<{ role: LlmMessage["role"]; content: string }>;
      jsonSchema?: object;
      temperature?: number;
      maxTokens?: number;
      stream: false;
    } = {
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: false,
    };
    if (opts?.jsonSchema) payload.jsonSchema = opts.jsonSchema;
    if (typeof opts?.temperature === "number") payload.temperature = opts.temperature;
    if (typeof opts?.maxTokens === "number") payload.maxTokens = opts.maxTokens;

    const resp = await this.request("POST", "/generate", payload, GENERATE_TIMEOUT_MS);
    if (!resp.ok) {
      throw new CompanionError(`/generate failed: ${resp.status}`, resp.status);
    }
    const body = (await resp.json()) as GenerateResponse;
    if (typeof body.content !== "string") {
      throw new CompanionError(`/generate: ответ без поля content`, resp.status);
    }
    return body.content;
  }

  // release — best-effort: компаньон может уже выгрузить модель сам по
  // idle-таймауту. 503/404 не считаем ошибкой; молча проглатываем, как
  // OffscreenBackend.
  async release(): Promise<void> {
    try {
      await this.request("POST", "/unload", {}, UNLOAD_TIMEOUT_MS);
    } catch {
      // нет сети / нет компаньона — уже фактически выгружено.
    }
  }

  // request обёртывает fetch единым timeout-через-AbortController и
  // выставляет Content-Type для JSON-тела.
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

export class CompanionError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "CompanionError";
  }
}
