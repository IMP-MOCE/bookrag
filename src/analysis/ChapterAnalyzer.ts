import schema from "../../schemas/analysis-response.schema.json";
import type { KnowledgeBase } from "../kb/KnowledgeBase";
import type { Chapter } from "../kb/models/work";
import type { Operation } from "../kb/operations";
import { chunkParagraphs, joinChunk, DEFAULT_CHUNK_OPTIONS, type ChunkOptions } from "./chunker";
import { convertResponse } from "./converter";
import { JsonSchemaValidator } from "./JsonSchemaValidator";
import { aggregateChapterSummaries } from "./SummaryAggregator";
import {
  buildRepairPrompt,
  buildUserPrompt,
  filterContextByChunk,
  summarizeContext,
  summarizeContextLight,
  SYSTEM_PROMPT,
} from "./prompts";
import type { CollisionCandidateResponse } from "./types";

// Минимальный контракт LLM-клиента, чтобы не цеплять WebLLM в анализаторе и в тестах.
export interface AnalysisLLMClient {
  generate(
    messages: ReadonlyArray<{ role: "system" | "user" | "assistant"; content: string }>,
    opts?: { jsonSchema?: object; temperature?: number; maxTokens?: number },
  ): Promise<string>;
}

export interface AnalyzeInput {
  chapter: Chapter;
  paragraphs: readonly string[];
}

export interface ChunkErrorInfo {
  chunkIndex: number;
  errors: string[];
  rawResponse: string;
}

export interface AnalysisResult {
  chapterId: string;
  workId: string;
  operations: Operation[];
  collisionCandidates: CollisionCandidateResponse[];
  chunkErrors: ChunkErrorInfo[];
  rawResponses: string[];
  /** Кол-во operations, отброшенных конвертером (не разрешились в KB id и т.п.). */
  droppedOperations: number;
  /** Сколько operations молча выкинул sanitize валидатора (модельные мусорные ops). */
  droppedSanitizeOperations: number;
  /** Сколько new_entities молча выкинул sanitize валидатора (пустые placeholder / wrong type). */
  droppedSanitizeEntities: number;
}

// Какой KB-блок класть в Pass 1 prompt:
//   - "empty": KB-блок принудительно пуст. Гарантированно без FAST-EMPTY-риска,
//     но извлечение слепое — на surname collisions модель создаёт дубль.
//   - "light" (default): компактный список `Имя[id] (aliases...)` без summary/role/status.
//     Подавляет surname collisions, не триггерит FAST-EMPTY.
//   - "full": compact summarizeContext (имена + id без aliases). Известно-рисковый
//     режим в q4 — оставлен для A/B сравнения.
export type KbContextMode = "empty" | "light" | "full";

export interface AnalyzerOptions {
  chunkOptions?: ChunkOptions;
  // Сколько раз повторить запрос с repair-промптом при невалидном JSON.
  maxRepairAttempts?: number;
  // Default "light". Переключение в "full" требует, чтобы в KnowledgeBase уже
  // были данные (иначе блок будет пуст и эффективно эквивалентен "empty").
  kbContextMode?: KbContextMode;
}

export class ChapterAnalyzer {
  private readonly chunkOptions: ChunkOptions;
  private readonly maxRepairAttempts: number;
  private readonly kbContextMode: KbContextMode;

  constructor(
    private readonly llm: AnalysisLLMClient,
    private readonly kb: KnowledgeBase,
    private readonly validator: JsonSchemaValidator = new JsonSchemaValidator(),
    opts: AnalyzerOptions = {},
  ) {
    this.chunkOptions = opts.chunkOptions ?? DEFAULT_CHUNK_OPTIONS;
    // 2 попытки: первая — обобщённая («ошибки: missing target_id»), вторая —
    // с примером корректной операции для конкретного type'а из buildRepairPrompt.
    // operations остаются самым хрупким блоком, одной попытки часто не хватает.
    this.maxRepairAttempts = opts.maxRepairAttempts ?? 2;
    this.kbContextMode = opts.kbContextMode ?? "light";
  }

  async analyze(input: AnalyzeInput): Promise<AnalysisResult> {
    const { paragraphs } = input;
    // kbContextMode="light" (default): вытягиваем aliases-only список из KB,
    // фильтруем под текущий chunk, рендерим через summarizeContextLight. Цель —
    // подавить surname collisions, не триггеря FAST-EMPTY (модель видит полный
    // KB-блок с summary/role/status и возвращает пустые arrays).
    let effectiveChunkOpts = this.chunkOptions;
    try {
      const overrides = await chrome.storage.local.get(["bookrag.chunkMaxChars"]);
      const overrideMax = overrides["bookrag.chunkMaxChars"];
      if (typeof overrideMax === "number" && overrideMax >= 500 && overrideMax <= 8000) {
        effectiveChunkOpts = { ...this.chunkOptions, maxChars: overrideMax };
        console.info(`[BookRAG] chunk-size override: ${overrideMax} (default ${this.chunkOptions.maxChars})`);
      }
    } catch {
      /* chrome недоступен — оставляем дефолты */
    }
    const chunks = chunkParagraphs(paragraphs, effectiveChunkOpts);

    // Заготовка KB-контекста: пуст для "empty", полный для "light"/"full". Pre-fetch
    // делается ОДИН раз на главу, дальше per-chunk фильтрация через
    // filterContextByChunk — она дешёвая, идёт по уже загруженным записям.
    let chapterKbCtx: Awaited<ReturnType<KnowledgeBase["buildContextForAnalysis"]>> | null = null;
    if (this.kbContextMode !== "empty") {
      const wholeChapterText = paragraphs.join("\n");
      chapterKbCtx = await this.kb.buildContextForAnalysis(input.chapter.workId, wholeChapterText);
      console.info(
        `[BookRAG] kbContextMode=${this.kbContextMode}: подгружено из KB ` +
          `chars=${chapterKbCtx.characters.length} ` +
          `locs=${chapterKbCtx.locations.length} ` +
          `arts=${chapterKbCtx.artifacts.length}`,
      );
    } else {
      // backward-compat: kb сохранён в this.kb, но в empty-mode не используется.
      void this.kb;
    }
    const emptyContextText = summarizeContext({
      characters: [],
      locations: [],
      artifacts: [],
    });

    const allOperations: Operation[] = [];
    const allCollisions: CollisionCandidateResponse[] = [];
    const chunkErrors: ChunkErrorInfo[] = [];
    const rawResponses: string[] = [];
    let droppedTotal = 0;
    let droppedSanitizeOps = 0;
    let droppedSanitizeEntities = 0;
    let counter = 1;

    for (let i = 0; i < chunks.length; i++) {
      const chunkText = joinChunk(chunks[i]!);
      let contextText = emptyContextText;
      if (chapterKbCtx !== null) {
        const filtered = filterContextByChunk(chapterKbCtx, chunkText);
        contextText =
          this.kbContextMode === "light"
            ? summarizeContextLight(filtered)
            : summarizeContext(filtered);
      }
      const userPrompt = buildUserPrompt({
        contextText,
        chapterId: input.chapter.id,
        chapterTitle: input.chapter.title,
        chunkIndex: i,
        totalChunks: chunks.length,
        chunkText,
      });

      const messages = [
        { role: "system" as const, content: SYSTEM_PROMPT },
        { role: "user" as const, content: userPrompt },
      ];

      console.info(
        `[BookRAG] chunk ${i + 1}/${chunks.length} (${chunkText.length} chars) → LLM`,
      );
      // Полный текст чанка в консоль offscreen-документа. Нужен для диагностики
      // "молчания" модели: иногда на один и тот же чанк она выдаёт операции, а
      // на следующий — пустые массивы. Без видимого input невозможно понять, чем
      // именно отличаются "плохие" чанки (граница диалога/проза, доля прямой
      // речи, имена-заглушки и т.п.). console.group сворачивает блок, чтобы лог
      // оставался читаемым на длинных главах.
      console.groupCollapsed(`[BookRAG] chunk ${i + 1}/${chunks.length} text (${chunkText.length} chars)`);
      console.info(chunkText);
      console.groupEnd();
      let raw = await this.llm.generate(messages, { jsonSchema: schema });
      rawResponses.push(raw);
      let validation = this.validator.parseAndValidate(raw);

      let attempts = 0;
      while (!validation.ok && attempts < this.maxRepairAttempts) {
        attempts++;
        console.warn(
          `[BookRAG] chunk ${i + 1}: невалидный JSON (попытка repair ${attempts}/` +
            `${this.maxRepairAttempts}). Ошибки: ${validation.errors.join("; ")}`,
        );
        const repairMessages = [
          ...messages,
          { role: "assistant" as const, content: raw },
          { role: "user" as const, content: buildRepairPrompt(raw, validation.errors) },
        ];
        raw = await this.llm.generate(repairMessages, { jsonSchema: schema });
        rawResponses.push(raw);
        validation = this.validator.parseAndValidate(raw);
      }

      if (!validation.ok) {
        console.error(
          `[BookRAG] chunk ${i + 1}: НЕ удалось получить валидный ответ после repair. ` +
            `Ошибки: ${validation.errors.join("; ")}\nСырой ответ:\n${raw}`,
        );
        chunkErrors.push({ chunkIndex: i, errors: validation.errors, rawResponse: raw });
        continue;
      }

      droppedSanitizeOps += validation.dropped.operations;
      droppedSanitizeEntities += validation.dropped.newEntities;
      if (validation.dropped.operations > 0 || validation.dropped.newEntities > 0) {
        console.info(
          `[BookRAG] chunk ${i + 1}: sanitize отбросил ` +
            `entities=${validation.dropped.newEntities} ops=${validation.dropped.operations}`,
        );
      }

      const converted = convertResponse(validation.data, {
        tempIdPrefix: `tmp:${input.chapter.id}`,
        startCounter: counter,
      });
      allOperations.push(...converted.operations);
      allCollisions.push(...converted.collisionCandidates);
      droppedTotal += converted.dropped;
      counter = converted.endCounter;
    }

    // FTv6: склеиваем create_chapter_summary из разных чанков в одну операцию.
    // Без этого applyOperations на главе из 3 чанков пытался бы записать 3
    // summary в by-work-chapter-number unique index — последний победил бы,
    // первые две пропали. Aggregator делает union participants + concat текст.
    const aggregatedOps = aggregateChapterSummaries(allOperations);

    console.info(
      `[BookRAG] анализ главы завершён: chunks=${chunks.length} ` +
        `operations=${aggregatedOps.length} collisions=${allCollisions.length} ` +
        `dropped=${droppedTotal} sanitizeEntities=${droppedSanitizeEntities} ` +
        `sanitizeOps=${droppedSanitizeOps} chunkErrors=${chunkErrors.length}`,
    );

    return {
      chapterId: input.chapter.id,
      workId: input.chapter.workId,
      operations: aggregatedOps,
      collisionCandidates: allCollisions,
      chunkErrors,
      rawResponses,
      droppedOperations: droppedTotal,
      droppedSanitizeOperations: droppedSanitizeOps,
      droppedSanitizeEntities: droppedSanitizeEntities,
    };
  }
}
