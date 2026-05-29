import {
  CreateMLCEngine,
  type AppConfig,
  type ChatOptions,
  type InitProgressReport,
  type MLCEngine,
} from "@mlc-ai/web-llm";
import type { ChatCompletionMessageParam } from "@mlc-ai/web-llm/lib/openai_api_protocols/chat_completion";
import { logAdapterReport } from "./webgpu";

const HF_BASE_2B =
  "https://huggingface.co/IMP-MOCE/bookrag-qwen2b-ftv5-merged-q4f16_1-MLC/resolve/main";
const HF_BASE_4B =
  "https://huggingface.co/IMP-MOCE/bookrag-qwen4b-ftv6-merged-q4f16_1-MLC/resolve/main";

export const CUSTOM_APP_CONFIG: AppConfig = {
  model_list: [
    {
      model: HF_BASE_2B,
      model_id: "bookrag-qwen2b-ftv5-merged-q4f16_1",
      model_lib: `${HF_BASE_2B}/bookrag-qwen2b-ftv5-merged-q4f16_1-webgpu.wasm`,
    },
    {
      model: HF_BASE_4B,
      model_id: "bookrag-qwen4b-ftv6-merged-q4f16_1",
      model_lib: `${HF_BASE_4B}/bookrag-qwen4b-ftv6-merged-q4f16_1-webgpu.wasm`,
    },
  ],
};

export type ProgressListener = (report: InitProgressReport) => void;

// Все диагностические настройки читаются из chrome.storage.local БЕЗ кеширования.
// Раньше пробовали кешировать на уровне модуля + storage.onChanged для
// инвалидации — кеш переживал свой собственный listener (race: первый
// get() кешировал null до того, как user.set() успевал сработать), и
// настройки тихо не подхватывались. Storage-read стоит микросекунды
// по сравнению с секундным LLM-вызовом — экономить здесь нечего.
const LLM_DEBUG_KEY = "bookrag.debugLLM";
const SAMPLING_PROFILE_KEY = "bookrag.samplingProfile";
const TEMPERATURE_KEY = "bookrag.temperature";

async function isLlmDebug(): Promise<boolean> {
  try {
    const v = await chrome.storage.local.get(LLM_DEBUG_KEY);
    return v[LLM_DEBUG_KEY] !== false; // дефолт — включено
  } catch {
    return true;
  }
}

// Sampling-профиль. Переключаемый через chrome.storage.local["bookrag.samplingProfile"].
//   "cli-match" (DEFAULT) — top_p=1.0, freq_pen=0, pres_pen=0. Зеркалит то, чем
//                 гоняем CLI/eval через transformers+jinja. A/B на repro.txt
//                 (5 чанков): 10 operations vs 1 в режиме with-penalties.
//   "with-penalties" — top_p=0.9, freq_pen=0.4, pres_pen=0.3. Старый prod-default;
//                 добавлялся для разрыва циклов на длинных summary, но
//                 провоцировал массовый FAST-EMPTY. Оставлен опцией на случай
//                 регресса в виде циклов (тогда переключить и проверить).
type SamplingProfile = "cli-match" | "with-penalties";
async function getSamplingProfile(): Promise<SamplingProfile> {
  try {
    const v = await chrome.storage.local.get(SAMPLING_PROFILE_KEY);
    const raw = v[SAMPLING_PROFILE_KEY];
    // Поддерживаем legacy-значение "default" из старой A/B-сессии.
    return raw === "with-penalties" || raw === "default" ? "with-penalties" : "cli-match";
  } catch {
    return "cli-match";
  }
}

interface SamplingParams {
  topP: number;
  frequencyPenalty: number;
  presencePenalty: number;
}

function paramsForProfile(profile: SamplingProfile): SamplingParams {
  if (profile === "with-penalties") {
    return { topP: 0.9, frequencyPenalty: 0.4, presencePenalty: 0.3 };
  }
  return { topP: 1.0, frequencyPenalty: 0, presencePenalty: 0 };
}

// Override temperature через chrome.storage.local["bookrag.temperature"].
// Используется для диагностики стохастичности FAST-EMPTY в MLC: temp=0
// форсит greedy argmax, убирая sampling-шум. Если при temp=0 один и тот же
// чанк стабильно даёт одно и то же — стохастика была в sampling. Если всё
// ещё «то normal, то FAST-EMPTY» при одинаковом input — проблема глубже,
// в numerical noise WebGPU q4f16_1 (не-детерминированный shader reduction).
async function getTemperatureOverride(): Promise<number | null> {
  try {
    const v = await chrome.storage.local.get(TEMPERATURE_KEY);
    const raw = v[TEMPERATURE_KEY];
    if (typeof raw === "number" && raw >= 0 && raw <= 2) {
      return raw;
    }
    return null;
  } catch {
    return null;
  }
}

export interface LoadOptions {
  // Перебивает context_window_size из prebuiltAppConfig. Web-llm у Qwen3.5
  // прописывает 4096 в low-resource overrides — для RAG этого мало.
  contextWindowSize?: number;
}

export interface GenerateOptions {
  systemPrompt?: string;
  jsonSchema?: object;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  signal?: AbortSignal;
  // По умолчанию thinking ВКЛЮЧЁН. Это не приглашение модели «думать» —
  // FT-модели учились эмитить JSON сразу после префикса `<think>\n` (дефолт jinja
  // chat_template из training/eval). С `enable_thinking=false` web-llm
  // (llm_chat.ts:prefillStep) ФОРСИТ `<think>\n\n</think>\n\n` как первые
  // сгенерированные токены, что не совпадает с training-префиксом и сбивает
  // FT-сигнал — модель отдаёт минимально валидный JSON (пустые массивы).
  // С `true` уважается `role_empty_sep: "\n<think>\n"` из mlc-chat-config.json
  // — префикс точно совпадает с обучением.
  enableThinking?: boolean;
}

function isGpuDisposedError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes("gpubuffer") || msg.includes("mapasync") || msg.includes("gpu device was lost");
}

// Тонкая обёртка над WebLLM. Сама не знает про профили — оперирует model_id.
// Управление профилями и сохранение активного — в background/handlers.ts.
export class LocalLLMService {
  private engine: MLCEngine | null = null;
  private currentModelId: string | null = null;
  // Запоминаем последние опции загрузки для recovery при GPU disposed.
  private lastLoadOpts: LoadOptions = {};

  // Единый промис-цепочечный мьютекс. MLCEngine переиспользует GPU-буферы и не
  // потокобезопасен: две перекрывающиеся WebGPU-операции (load/unload поверх
  // generate, либо очередной generate) размапливают буфер, пока mapAsync другой
  // ещё не разрешён → "Buffer was unmapped before mapping was resolved".
  // Все операции движка проходят строго последовательно через runExclusive.
  private opChain: Promise<unknown> = Promise.resolve();

  // Ставит fn в хвост цепочки. Ошибка одной операции не должна рвать цепочку —
  // следующая всё равно стартует (но свой результат/ошибку получает её вызывающий).
  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.opChain.then(fn, fn);
    this.opChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  isReady(modelId: string): boolean {
    return this.engine !== null && this.currentModelId === modelId;
  }

  getCurrentModelId(): string | null {
    return this.currentModelId;
  }

  load(
    modelId: string,
    onProgress?: ProgressListener,
    opts: LoadOptions = {},
  ): Promise<void> {
    return this.runExclusive(() => this._doLoad(modelId, onProgress, opts));
  }

  unload(): Promise<void> {
    return this.runExclusive(() => this._doUnload());
  }

  generate(
    messages: readonly ChatCompletionMessageParam[],
    opts: GenerateOptions = {},
  ): Promise<string> {
    return this.runExclusive(() => this._doGenerate(messages, opts, false));
  }

  private async _doLoad(
    modelId: string,
    onProgress?: ProgressListener,
    opts: LoadOptions = {},
  ): Promise<void> {
    this.lastLoadOpts = opts;
    // Идемпотентность уже внутри критической секции: параллельные loadModel для
    // той же модели не пересоздают движок.
    if (this.isReady(modelId)) return;
    if (this.engine) await this._doUnload();

    const config = {
      ...(onProgress
        ? { initProgressCallback: (r: InitProgressReport) => onProgress(r) }
        : {}),
      appConfig: CUSTOM_APP_CONFIG,
    };
    const chatOpts: ChatOptions | undefined =
      typeof opts.contextWindowSize === "number"
        ? { context_window_size: opts.contextWindowSize }
        : undefined;
    if (await isLlmDebug()) {
      console.info(
        `[BookRAG LLM] загрузка ${modelId} | context_window_size=` +
          `${opts.contextWindowSize ?? "(prebuilt default)"}`,
      );
      await logAdapterReport(`перед загрузкой ${modelId}`);
    }
    this.engine = await CreateMLCEngine(modelId, config, chatOpts);
    this.currentModelId = modelId;
    await this._warmup();
  }

  // Первый реальный generate платит компиляцию всех WGSL-пайплайнов (cold
  // shader compilation) — это уходит в воспринимаемую задержку первого ответа.
  // Прогоняем 1 токен сразу после загрузки, в той же критической секции, чтобы
  // компиляция случилась здесь, а не на критическом пути пользовательского
  // запроса. Ошибка warmup не должна срывать загрузку.
  private async _warmup(): Promise<void> {
    if (!this.engine) return;
    const t0 = performance.now();
    try {
      await this.engine.chat.completions.create({
        messages: [{ role: "user", content: "ok" }],
        max_tokens: 1,
        temperature: 0,
        stream: false,
      });
      if (await isLlmDebug()) {
        console.info(
          `[BookRAG LLM] warmup ${this.currentModelId ?? "?"} за ` +
            `${Math.round(performance.now() - t0)}ms (компиляция WGSL прогрета)`,
        );
      }
    } catch (err) {
      console.warn("[BookRAG] warmup generate failed (не критично):", err);
    }
  }

  // Незалоченный — вызывается как из публичного unload(), так и из _doLoad()
  // при смене модели (повторный захват мьютекса = self-deadlock).
  private async _doUnload(): Promise<void> {
    if (!this.engine) return;
    try {
      await this.engine.unload();
    } catch (err) {
      console.warn("[BookRAG] engine.unload failed:", err);
    }
    this.engine = null;
    this.currentModelId = null;
  }

  private async _doGenerate(
    messages: readonly ChatCompletionMessageParam[],
    opts: GenerateOptions = {},
    gpuRetry = false,
  ): Promise<string> {
    if (!this.engine) throw new Error("LocalLLMService: model is not loaded");
    const recoveryModelId = this.currentModelId!;

    const fullMessages: ChatCompletionMessageParam[] = opts.systemPrompt
      ? [{ role: "system", content: opts.systemPrompt }, ...messages]
      : [...messages];

    // Профиль sampling берётся из chrome.storage.local (с фоллбеком на default).
    // Явные opts.* всегда перебивают профиль.
    const profile = await getSamplingProfile();
    const profileParams = paramsForProfile(profile);
    const tempOverride = await getTemperatureOverride();
    const params: Parameters<typeof this.engine.chat.completions.create>[0] = {
      messages: fullMessages,
      temperature: opts.temperature ?? tempOverride ?? 0.1,
      top_p: opts.topP ?? profileParams.topP,
      // 3072 = ~512 на «думанье» + room под JSON с operations на длинных чанках.
      // Раньше было 2048; с включённым thinking может не хватить.
      max_tokens: opts.maxTokens ?? 3072,
      // Дефолтный профиль "cli-match" обнуляет penalties — А/B показала, что
      // freq=0.4/pres=0.3 давили модель в ранний </think> и роняли operations
      // 10× (1 op vs 10 ops на тех же 5 чанках). Если когда-нибудь снова
      // увидим петли на длинных summary — переключаемся на "with-penalties"
      // через chrome.storage.local.
      frequency_penalty: opts.frequencyPenalty ?? profileParams.frequencyPenalty,
      presence_penalty: opts.presencePenalty ?? profileParams.presencePenalty,
      stream: false,
      extra_body: { enable_thinking: opts.enableThinking ?? true },
    };
    // ВАЖНО: response_format/jsonSchema НЕ передаём в web-llm. xgrammar guided
    // decoding под пермиссивной analysis-response.schema.json (operations[] без
    // minItems, в AnalysisOperation required только type/evidence/confidence)
    // форсит модель в минимально-валидный путь — пустые массивы. Eval-сервер
    // (eval/scripts/serve_openai_transformers.py) jsonSchema игнорирует, поэтому
    // eval работает (78 composite на 4B), а MLC в проде отдавал empty arrays.
    // SYSTEM_PROMPT уже включает текст схемы — модель знает формат и эмитит
    // <think>...</think> → JSON по своей training-разметке. JsonSchemaValidator.
    // tryRepair вырезает <think>-префикс (slice от первой { до последней }),
    // repair-цикл в ChapterAnalyzer (maxRepairAttempts=2) ловит редкие сбои.
    // Если/когда перепишем схему на strict oneOf per type — можно вернуть.
    void opts.jsonSchema;

    const debug = await isLlmDebug();
    const t0 = performance.now();
    if (debug) {
      const promptChars = fullMessages.reduce(
        (n, m) => n + (typeof m.content === "string" ? m.content.length : 0),
        0,
      );
      console.info(
        `[BookRAG LLM] → ${this.currentModelId ?? "?"} | msgs=${fullMessages.length} ` +
          `promptChars=${promptChars} maxTokens=${params.max_tokens} ` +
          `temp=${params.temperature} top_p=${params.top_p} ` +
          `freq=${params.frequency_penalty} pres=${params.presence_penalty} ` +
          `profile=${profile} schema=${opts.jsonSchema ? "yes" : "no"}`,
      );
    }

    let result: Awaited<ReturnType<typeof this.engine.chat.completions.create>>;
    try {
      result = await this.engine.chat.completions.create(params);
    } catch (err) {
      if (!gpuRetry && isGpuDisposedError(err)) {
        console.warn("[BookRAG LLM] GPU disposed — перезагружаем движок и повторяем чанк", err);
        this.engine = null;
        this.currentModelId = null;
        await this._doLoad(recoveryModelId, undefined, this.lastLoadOpts);
        return this._doGenerate(messages, opts, true);
      }
      throw err;
    }
    if ("choices" in result) {
      const choice = result.choices[0];
      const content = choice?.message?.content;
      // web-llm в reasoning-режиме (mlc-chat-config.json conv_template.role_empty_sep
      // = "\n<think>\n") разделяет вывод модели: всё между <think>...</think> →
      // `reasoning_content`, всё после </think> → `content`. Без явного чтения
      // reasoning_content мы не видим, думала ли модель что-то перед JSON. Это
      // критично для диагностики FAST-EMPTY: модель могла эмитить пустой
      // <think></think> (≈3 токена) → пустой JSON, а могла нормально думать,
      // но `</think>` встал в нежелательное место.
      const reasoningContent = (choice?.message as { reasoning_content?: unknown } | undefined)?.reasoning_content;
      const reasoningStr = typeof reasoningContent === "string" ? reasoningContent : "";
      if (debug) {
        const ms = Math.round(performance.now() - t0);
        const usage = result.usage
          ? `tokens(in/out)=${result.usage.prompt_tokens}/${result.usage.completion_tokens}`
          : "tokens=?";
        // web-llm кладёт реальную скорость движка в usage.extra — это и есть
        // главный индикатор: prefill_tokens_per_s / decode_tokens_per_s.
        const extra = (result.usage as { extra?: Record<string, number> } | undefined)?.extra;
        const speed = extra
          ? `prefill=${extra.prefill_tokens_per_s?.toFixed(1)}t/s ` +
            `decode=${extra.decode_tokens_per_s?.toFixed(1)}t/s`
          : "speed=?(нет usage.extra)";
        // Диагностика FAST-EMPTY: модель эмитит ≤ 12 токенов с пустыми массивами.
        // Признаки и причины:
        //   - reasoningChars=0 → модель сразу закрыла <think></think> без раздумий;
        //   - reasoningChars > 0, но parsedShape пустой → модель думала, но потом
        //     решила, что извлекать нечего;
        //   - parse failed → web-llm вернула не-JSON в content (например, продолжение
        //     reasoning без закрытия </think>).
        const contentStr = typeof content === "string" ? content : "";
        // Сырые маркеры <think>/</think> в .content почти всегда отсутствуют — это
        // нормально, web-llm в reasoning-режиме их вырезает. Логируем для случаев,
        // когда reasoning-режим вдруг отвалится и маркеры всплывут в content.
        const hasStrayThink = /<\/?think>/i.test(contentStr);
        let parsedShape: string | null = null;
        try {
          const firstBrace = contentStr.indexOf("{");
          const lastBrace = contentStr.lastIndexOf("}");
          if (firstBrace !== -1 && lastBrace > firstBrace) {
            const obj = JSON.parse(contentStr.slice(firstBrace, lastBrace + 1)) as Record<string, unknown>;
            const ne = Array.isArray(obj.new_entities) ? obj.new_entities.length : -1;
            const ops = Array.isArray(obj.operations) ? obj.operations.length : -1;
            const cc = Array.isArray(obj.collision_candidates) ? obj.collision_candidates.length : -1;
            parsedShape = `ne=${ne} ops=${ops} cc=${cc}`;
          }
        } catch {
          parsedShape = "(parse failed)";
        }
        const allEmpty = parsedShape === "ne=0 ops=0 cc=0";
        // FAST-EMPTY = модель не думала И выдала пустой JSON. Если reasoningStr
        // непустой, но JSON пустой — модель думала и осознанно решила не
        // извлекать (другая категория сбоя, NORMAL-empty).
        const fastEmpty = allEmpty && reasoningStr.length === 0;
        const reasoningFlag = `reasoning=${reasoningStr.length}c`;
        const pathFlag = fastEmpty
          ? "path=FAST-EMPTY"
          : allEmpty
            ? "path=normal-empty(thought,decided-no-extract)"
            : "path=normal";
        const strayFlag = hasStrayThink ? " STRAY-think-markers!" : "";
        console.info(
          `[BookRAG LLM] ← ${ms}ms | finish=${choice?.finish_reason ?? "?"} ` +
            `${usage} ${speed} contentChars=${contentStr.length} ` +
            `${reasoningFlag} ${pathFlag}${parsedShape ? " " + parsedShape : ""}${strayFlag}`,
        );
        if (reasoningStr.length > 0) {
          console.groupCollapsed(`[BookRAG LLM] reasoning_content (${reasoningStr.length} chars)`);
          console.info(reasoningStr);
          console.groupEnd();
        }
        console.info("[BookRAG LLM] raw response:\n" + (content ?? "<no content>"));
        if (typeof content !== "string" || content.trim() === "") {
          console.warn(
            `[BookRAG LLM] ПУСТОЙ вывод. finish_reason=${choice?.finish_reason ?? "?"}` +
              (choice?.finish_reason === "length"
                ? " — упёрлись в max_tokens (увеличьте лимит или уменьшите чанк)."
                : ""),
          );
        } else if (fastEmpty) {
          console.warn(
            `[BookRAG LLM] FAST-EMPTY path: модель закрыла <think></think> без раздумий и ` +
              `выдала пустые массивы (${result.usage?.completion_tokens ?? "?"} токенов всего). ` +
              `Тот же чанк через transformers+HF jinja даёт операции — значит дело не в данных, ` +
              `а в sampling-параметрах MLC (top_p=${params.top_p}, freq_pen=${params.frequency_penalty}, ` +
              `pres_pen=${params.presence_penalty}). Попробуй обнулить freq/pres penalty или ` +
              `поднять top_p до 1.0.`,
          );
        }
      }
      if (typeof content !== "string") throw new Error("LLM returned no content");
      return content;
    }
    throw new Error("LLM returned unexpected streaming response");
  }
}
