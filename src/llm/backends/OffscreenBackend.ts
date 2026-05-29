// In-browser бэкенд: WebLLM в offscreen-документе. Тонкая обёртка над
// OffscreenClient — переносит сюда as-is логику, которая раньше жила инлайн
// в makeQueueProcessor (генерация) и в процессоре очереди (загрузка модели).
// Поведение не меняется.

import type { OffscreenClient } from "../../background/offscreen-client";
import type { LlmBackend, LlmGenerateOptions, LlmMessage } from "./LlmBackend";

// На слабом железе один чанк декодится единицы токенов/сек (наблюдалось ~103с
// на 277 токенов). Дефолтный таймаут offscreen-вызова 120с убивал генерацию
// на полуслове, а offscreen-документ при этом продолжал считать — следующий
// чанк вставал в мьютекс за «осиротевшим» вызовом. Даём генерации тот же
// запас, что и загрузке модели.
const GENERATE_TIMEOUT_MS = 30 * 60_000;
const LOAD_TIMEOUT_MS = 30 * 60_000;

export class OffscreenBackend implements LlmBackend {
  constructor(private readonly offscreen: OffscreenClient) {}

  // Offscreen WebLLM — всегда присутствующий in-browser фоллбэк. Готовность
  // конкретной модели обеспечивает ensureModel(); здесь не создаём offscreen-
  // документ ради пустого пинга.
  async health(): Promise<boolean> {
    return true;
  }

  async ensureModel(modelId: string, contextWindowSize?: number): Promise<void> {
    const payload: Parameters<typeof this.offscreen.call<"offscreen/loadModel">>[1] = {
      modelId,
    };
    if (typeof contextWindowSize === "number") {
      payload.contextWindowSize = contextWindowSize;
    }
    await this.offscreen.call("offscreen/loadModel", payload, LOAD_TIMEOUT_MS);
  }

  async generate(
    messages: ReadonlyArray<LlmMessage>,
    opts?: LlmGenerateOptions,
  ): Promise<string> {
    const reqPayload: Parameters<typeof this.offscreen.call<"offscreen/generate">>[1] = {
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    };
    if (opts?.jsonSchema) reqPayload.jsonSchema = opts.jsonSchema;
    if (typeof opts?.temperature === "number") reqPayload.temperature = opts.temperature;
    if (typeof opts?.maxTokens === "number") reqPayload.maxTokens = opts.maxTokens;
    const result = await this.offscreen.call(
      "offscreen/generate",
      reqPayload,
      GENERATE_TIMEOUT_MS,
    );
    return result.content;
  }

  // WebLLM держит вес в WebGPU offscreen-документа; явная выгрузка есть, но
  // пайплайн анализа её не вызывает (поведение как раньше). Метод нужен для
  // единообразия порта и будущего управления VRAM компаньоном.
  async release(): Promise<void> {
    try {
      await this.offscreen.call("offscreen/unload", {});
    } catch {
      // offscreen не запущен / модель не загружена — уже выгружено.
    }
  }
}
