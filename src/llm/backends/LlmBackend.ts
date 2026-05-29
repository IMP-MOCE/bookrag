// Общий порт доступа к LLM. Анализатор (ChapterAnalyzer) и очередь не знают,
// где реально крутится модель — in-browser WebLLM (offscreen) или нативный
// компаньон по localhost. Обе реализации удовлетворяют этому интерфейсу;
// выбор делает resolveBackend(). generate() намеренно совпадает по сигнатуре
// с AnalysisLLMClient, чтобы адаптер был тривиальным passthrough.

export type LlmMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export interface LlmGenerateOptions {
  jsonSchema?: object;
  temperature?: number;
  maxTokens?: number;
}

export interface LlmBackend {
  // Дешёвая проверка доступности бэкенда. НЕ должна грузить модель в VRAM.
  health(): Promise<boolean>;

  // Идемпотентно гарантирует, что модель загружена и готова к generate().
  // Та же модель уже в движке → no-op.
  ensureModel(modelId: string, contextWindowSize?: number): Promise<void>;

  // Одна генерация. Возвращает сырой контент ассистента.
  generate(
    messages: ReadonlyArray<LlmMessage>,
    opts?: LlmGenerateOptions,
  ): Promise<string>;

  // Выгрузить модель из VRAM (best-effort; для offscreen может быть no-op).
  // Понадобится компаньону для управления VRAM; пайплайн анализа пока не вызывает.
  release(): Promise<void>;
}
