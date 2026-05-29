// Регистрация обработчиков для всех endpoint'ов из messaging/contracts.ts.
// Файл компонует сервисы (KB, ChapterAnalyzer, CollisionResolver, OffscreenClient, AnalysisQueue)
// и связывает их с MessageRouter.

import { ChapterAnalyzer } from "../analysis/ChapterAnalyzer";
import type { AnalysisLLMClient } from "../analysis/ChapterAnalyzer";
import { KbReconciler, ReconcileFailedError } from "../analysis/KbReconciler";
import { CollisionResolver } from "../kb/CollisionResolver";
import { KnowledgeBase } from "../kb/KnowledgeBase";
import type { Chapter, Work } from "../kb/models/work";
import {
  PROFILES,
  getProfileById,
  isProfileId,
  resolveModel,
  type ProfileId,
} from "../llm/profiles";
import { resolveBackend } from "../llm/backends/resolveBackend";
import { clearDownloadedFlag, isModelDownloaded, markModelDownloaded } from "../llm/storage";
import { ERROR_CODES, type ProfileStateDto } from "../messaging/contracts";
import { AnalysisQueue, type ProcessorContext } from "./analysis-queue";
import { cleanupLegacyBrowserModelCaches } from "./legacy-model-cleanup";
import type { OffscreenClient } from "./offscreen-client";
import { broadcast, MessageRouter, RouterError } from "./router";

export const ACTIVE_PROFILE_KEY = "bookrag.activeProfile";

async function readActiveProfile(): Promise<ProfileId | null> {
  const v = await chrome.storage.local.get(ACTIVE_PROFILE_KEY);
  const value = v[ACTIVE_PROFILE_KEY];
  return isProfileId(value) ? value : null;
}

interface RegisterArgs {
  router: MessageRouter;
  kb: KnowledgeBase;
  offscreen: OffscreenClient;
  queue: AnalysisQueue;
}

export function registerHandlers(args: RegisterArgs): void {
  const { router, kb, offscreen, queue } = args;
  const downloadingNow = new Set<ProfileId>();

  // ---------- Models ----------

  const getActiveProfile = readActiveProfile;

  router.on("models/list", async () => {
    await cleanupLegacyBrowserModelCaches(offscreen);
    const active = await getActiveProfile();
    const out: ProfileStateDto[] = [];
    for (const profile of PROFILES) {
      const resolved = resolveModel(profile);
      const downloaded = await isModelDownloaded(resolved.modelId);
      const status = downloadingNow.has(profile.id)
        ? "downloading"
        : downloaded
          ? "ready"
          : "not_downloaded";
      out.push({
        id: profile.id,
        label: profile.label,
        description: profile.description,
        modelId: resolved.modelId,
        approxSizeGb: profile.approxSizeGb,
        approxVramGb: profile.approxVramGb,
        status,
        isActive: active === profile.id,
      });
    }
    return out;
  });

  router.on("models/diagnose", async () => {
    return offscreen.call("offscreen/diagnose", {});
  });

  router.on("models/download", async ({ profileId }) => {
    await cleanupLegacyBrowserModelCaches(offscreen);
    const profile = getProfileById(profileId);
    const resolved = resolveModel(profile);
    downloadingNow.add(profileId);
    try {
      await offscreen.call(
        "offscreen/loadModel",
        { modelId: resolved.modelId, contextWindowSize: resolved.contextWindowSize },
        30 * 60_000,
      );
      await markModelDownloaded(resolved.modelId);
    } finally {
      downloadingNow.delete(profileId);
    }
    return { ok: true } as const;
  });

  router.on("models/remove", async ({ profileId }) => {
    const profile = getProfileById(profileId);
    const resolved = resolveModel(profile);
    try {
      await offscreen.call("offscreen/unload", {});
    } catch {
      // если offscreen не запущен — уже хорошо.
    }
    try {
      await offscreen.call("offscreen/deleteModel", { modelId: resolved.modelId });
    } catch (err) {
      console.warn("[BookRAG] offscreen/deleteModel failed", err);
    }
    await clearDownloadedFlag(resolved.modelId);
    const active = await getActiveProfile();
    if (active === profileId) {
      await chrome.storage.local.remove(ACTIVE_PROFILE_KEY);
    }
    return { ok: true } as const;
  });

  router.on("models/setActive", async ({ profileId }) => {
    await chrome.storage.local.set({ [ACTIVE_PROFILE_KEY]: profileId });
    return { ok: true } as const;
  });

  // ---------- Анализ главы ----------

  router.on("chapters/analyze", async ({ parsed }) => {
    const snap = queue.enqueue(parsed);
    return { taskId: snap.taskId };
  });

  router.on("queue/snapshot", async () => queue.snapshot());

  router.on("queue/cancel", async ({ taskId }) => {
    const ok = queue.cancel(taskId);
    if (!ok) {
      throw new RouterError(ERROR_CODES.TASK_NOT_FOUND, `Task ${taskId} not found or finished`);
    }
    return { ok: true } as const;
  });

  // ---------- KB reads ----------

  router.on("kb/listWorks", async () => kb.listWorks());
  router.on("kb/listChapters", async ({ workId }) => kb.listChapters(workId));
  router.on("kb/listCharacters", async ({ workId }) => kb.listCharacters(workId));
  router.on("kb/getCharacter", async ({ id }) => (await kb.getCharacter(id)) ?? null);
  router.on("kb/listLocations", async ({ workId }) => kb.listLocations(workId));
  router.on("kb/listArtifacts", async ({ workId }) => kb.listArtifacts(workId));
  router.on("kb/listChapterSummaries", async ({ workId }) => kb.listChapterSummaries(workId));
  router.on("kb/listRuns", async ({ workId }) => {
    const all = await kb["db"].getAllFromIndex("analysis_runs", "by-work", workId);
    return all.sort((a, b) => b.startedAt - a.startedAt);
  });
  router.on("kb/searchByKey", async ({ workId, query }) => kb.searchByKey(workId, query));

  router.on("kb/updateCharacter", async ({ workId, characterId, patch }) => {
    const updated = await kb.updateCharacter(workId, characterId, patch);
    broadcast("broadcast/kbChanged", { workId, reason: "edit" });
    return updated;
  });

  router.on("kb/deleteCharacter", async ({ workId, characterId }) => {
    await kb.deleteCharacter(workId, characterId);
    broadcast("broadcast/kbChanged", { workId, reason: "delete" });
    return { ok: true } as const;
  });

  router.on("kb/deleteLocation", async ({ workId, locationId }) => {
    await kb.deleteLocation(workId, locationId);
    broadcast("broadcast/kbChanged", { workId, reason: "delete" });
    return { ok: true } as const;
  });

  router.on("kb/deleteArtifact", async ({ workId, artifactId }) => {
    await kb.deleteArtifact(workId, artifactId);
    broadcast("broadcast/kbChanged", { workId, reason: "delete" });
    return { ok: true } as const;
  });

  // ---------- Reviews ----------

  router.on("review/listPending", async ({ workId }) => kb.listPendingReviews(workId));

  router.on("review/resolve", async ({ reviewId, decision, note, mergeIntoCandidate }) => {
    const item = await kb["db"].get("review_items", reviewId);
    if (!item) {
      throw new RouterError("not_found", `Review ${reviewId} not found`);
    }
    if (decision === "merged") {
      const primaryId = mergeIntoCandidate ? item.candidateId : item.newCharacterId;
      const secondaryId = mergeIntoCandidate ? item.newCharacterId : item.candidateId;
      await kb.mergeCharacters({
        workId: item.workId,
        primaryId,
        secondaryId,
        reason: note ?? "manual review",
      });
      broadcast("broadcast/kbChanged", { workId: item.workId, reason: "merge" });
    }
    await kb.resolveReview(reviewId, { status: decision, ...(note ? { note } : {}) });
    return { ok: true } as const;
  });

  router.on("kb/mergeCharacters", async ({ workId, primaryId, secondaryId, reason }) => {
    await kb.mergeCharacters({ workId, primaryId, secondaryId, reason });
    broadcast("broadcast/kbChanged", { workId, reason: "merge" });
    return { ok: true } as const;
  });

  // Связи между персонажами не хранятся как отдельная сущность — частично
  // покрываются полем role в CharacterCard, частично — chapter_summary.keyEventsOneline.

  // ---------- UI ----------

  router.on("ui/openSidePanel", async (_payload, ctx) => {
    const tabId = ctx.sender?.tab?.id;
    const sidePanel = chrome.sidePanel as
      | { open?: (opts: { tabId?: number; windowId?: number }) => Promise<void> }
      | undefined;
    if (!sidePanel?.open) {
      throw new RouterError("not_supported", "chrome.sidePanel.open is unavailable");
    }
    if (typeof tabId === "number") {
      await sidePanel.open({ tabId });
    } else {
      // Без tabId сидепанель не откроется — fallback на windowId активного окна.
      const win = await chrome.windows.getCurrent();
      if (typeof win.id === "number") await sidePanel.open({ windowId: win.id });
    }
    return { ok: true } as const;
  });

  // ---------- Export / Import ----------

  router.on("kb/export", async ({ workId }) => {
    const json = await exportSnapshot(kb, workId);
    return { json };
  });

  router.on("kb/import", async ({ json }) => {
    const merged = await importSnapshot(kb, json);
    return { merged };
  });
}

// ---------- Сборка процессора для очереди ----------

export interface ProcessorDeps {
  kb: KnowledgeBase;
  offscreen: OffscreenClient;
}

export function makeQueueProcessor(deps: ProcessorDeps) {
  const collisionResolver = new CollisionResolver(deps.kb);

  return async function process(ctx: ProcessorContext): Promise<void> {
    const { task, signal, reportProgress, setChapterMeta } = ctx;
    if (signal.aborted) return;

    // 0. Гарантируем, что в offscreen загружена активная модель.
    // Offscreen-документ может быть эвиктнут Chrome'ом между сессиями, а сам факт
    // «активного» профиля в chrome.storage не означает, что вес лежит в WebGPU.
    // LocalLLMService.load идемпотентный: если та же модель уже в движке — no-op.
    const activeProfile = await readActiveProfile();
    if (!activeProfile) {
      throw new RouterError(
        ERROR_CODES.MODEL_NOT_LOADED,
        "Нет активного профиля модели. Откройте «Менеджер моделей», скачайте и активируйте модель.",
      );
    }
    const resolved = resolveModel(getProfileById(activeProfile));
    if (!(await isModelDownloaded(resolved.modelId))) {
      throw new RouterError(
        ERROR_CODES.MODEL_NOT_LOADED,
        `Модель профиля «${activeProfile}» ещё не скачана. Откройте «Менеджер моделей» и нажмите «Скачать».`,
      );
    }
    // Выбор бэкенда на старте анализа: сейчас всегда offscreen WebLLM,
    // позже здесь подключится локальный компаньон (см. resolveBackend).
    const backend = await resolveBackend({ offscreen: deps.offscreen });
    const llmAdapter: AnalysisLLMClient = {
      generate: (messages, opts) => backend.generate(messages, opts),
    };
    const analyzer = new ChapterAnalyzer(llmAdapter, deps.kb);

    reportProgress({ stage: "context", message: "Загружаем модель" });
    await backend.ensureModel(resolved.modelId, resolved.contextWindowSize);
    if (signal.aborted) return;

    // 1. Произведение и глава.
    reportProgress({ stage: "context", message: "Регистрируем главу" });
    const work = await ensureWork(deps.kb, {
      title: task.parsed.workTitle,
      siteUrl: task.parsed.workSiteUrl,
    });
    const chapter = await deps.kb.addChapter({
      workId: work.id,
      number: task.parsed.chapterNumber,
      title: task.parsed.chapterTitle,
      url: task.parsed.chapterUrl,
      text: task.parsed.text,
    });
    setChapterMeta({ workId: work.id, chapterId: chapter.id, chapterNumber: chapter.number });
    if (signal.aborted) return;

    // 2. Pass 1: extraction. ChapterAnalyzer работает с light-KB context (aliases-only),
    // полная сверка с уже известными карточками вынесена в KbReconciler (Pass 2).
    reportProgress({ stage: "chunk", message: "Анализ главы LLM" });
    const result = await analyzer.analyze({ chapter, paragraphs: task.parsed.paragraphs });
    if (signal.aborted) return;

    // 2.5. Pass 2: KB reconciliation. LLM решает per-entity «match с KB или new».
    // Skip-short-circuit'ы (no_drafts, no_kb, no_overlap) внутри reconcile().
    //
    // ВАЖНО: если Pass 2 не справился даже после repair-попыток — пробрасываем
    // RouterError("reconcile_failed"). Apply ДОЛЖЕН быть пропущен: иначе Pass 1
    // create_character/_location/_artifact попадут в KB без сверки и при второй
    // встрече той же сущности создадут дубль. Глава остаётся не обработанной,
    // пользователь видит ошибку и может перезапустить анализ.
    reportProgress({ stage: "reconcile", message: "Сверка с справочником" });
    const reconciler = new KbReconciler(llmAdapter, deps.kb);
    let reconciled;
    try {
      reconciled = await reconciler.reconcile({
        workId: work.id,
        operations: result.operations,
        collisionCandidates: result.collisionCandidates,
      });
    } catch (err) {
      if (err instanceof ReconcileFailedError) {
        throw new RouterError(
          ERROR_CODES.RECONCILE_FAILED,
          `Сверка с справочником не удалась после ${err.attempts} попыток. ` +
            `Глава не записана в справочник — повторите анализ. ` +
            `Технические ошибки: ${err.errors.slice(0, 3).join("; ")}`,
        );
      }
      throw err;
    }
    if (signal.aborted) return;
    if (reconciled.skipped) {
      console.info(`[BookRAG] reconcile: skipped (${reconciled.skipped})`);
    } else {
      console.info(
        `[BookRAG] reconcile: drafts=${reconciled.draftsSent} decisions=${reconciled.decisionsReceived} ` +
          `hints=${reconciled.llmHints.size}`,
      );
    }

    // 3. План коллизий (auto_merge / manual_review). Получает обогащённые
    // operations и llmHints из Pass 2 (или входные, если Pass 2 skipped).
    reportProgress({ stage: "validate", message: "Проверка коллизий" });
    const llmHints = new Map<string, number>(reconciled.llmHints);
    for (const cand of reconciled.collisionCandidates) {
      // converter уже привёл cand.new_character к нашему tempId (см. analysis/converter.ts).
      if (typeof cand.same_entity_probability === "number") {
        llmHints.set(cand.new_character, cand.same_entity_probability);
      }
    }
    const plan = await collisionResolver.planForOperations(work.id, reconciled.operations, llmHints);

    // 4. Применить операции.
    reportProgress({ stage: "apply", message: "Запись в справочник" });
    const apply = await deps.kb.applyOperations({
      workId: work.id,
      chapterId: chapter.id,
      chapterNumber: chapter.number,
      operations: plan.rewrittenOps,
    });

    // 5. Сохранить пендинги ревью (резолвим tempId через apply.tempIdMap).
    for (const review of plan.pendingReviews) {
      const realNewId = apply.tempIdMap[review.newCharacterTempId];
      if (!realNewId) continue;
      await deps.kb.enqueueReview({
        workId: work.id,
        chapterId: chapter.id,
        newCharacterId: realNewId,
        candidateId: review.candidateId,
        score: review.score,
        features: review.features,
        ...(review.llmHint !== undefined ? { llmHint: review.llmHint } : {}),
      });
    }

    broadcast("broadcast/kbChanged", { workId: work.id, reason: "analysis" });
  };
}

async function ensureWork(
  kb: KnowledgeBase,
  input: { title: string; siteUrl: string },
): Promise<Work> {
  const existing = (await kb.listWorks()).find((w) => w.siteUrl === input.siteUrl);
  if (existing) return existing;
  return kb.createWork(input);
}

// ---------- Экспорт/импорт ----------

// FTv6 (2026-05-26): events + relationships удалены из snapshot. Старые snapshot'ы
// с этими полями импортируются — они просто пропускаются (storeName проверяется).
interface SnapshotPayload {
  version: 1;
  exportedAt: number;
  works: Work[];
  chapters: Chapter[];
  characters: unknown[];
  locations: unknown[];
  artifacts: unknown[];
  chapter_summaries: unknown[];
  evidences: unknown[];
  reviews: unknown[];
  runs: unknown[];
}

async function exportSnapshot(
  kb: KnowledgeBase,
  workId?: string,
): Promise<string> {
  const db = kb["db"];
  const filterWork = <T extends { workId?: string }>(arr: T[]): T[] =>
    workId ? arr.filter((x) => x.workId === workId) : arr;
  const works = workId
    ? ([await db.get("works", workId)].filter((w): w is Work => Boolean(w)))
    : await db.getAll("works");
  const payload: SnapshotPayload = {
    version: 1,
    exportedAt: Date.now(),
    works,
    chapters: filterWork(await db.getAll("chapters")),
    characters: filterWork(await db.getAll("characters")),
    locations: filterWork(await db.getAll("locations")),
    artifacts: filterWork(await db.getAll("artifacts")),
    chapter_summaries: filterWork(await db.getAll("chapter_summaries")),
    evidences: filterWork(await db.getAll("evidences")),
    reviews: filterWork(await db.getAll("review_items")),
    runs: filterWork(await db.getAll("analysis_runs")),
  };
  return JSON.stringify(payload, null, 2);
}

async function importSnapshot(kb: KnowledgeBase, json: string): Promise<number> {
  const parsed = JSON.parse(json) as Partial<SnapshotPayload>;
  if (!parsed || parsed.version !== 1) {
    throw new RouterError(ERROR_CODES.INVALID_PAYLOAD, "Unsupported snapshot version");
  }
  const db = kb["db"];
  const stores: Array<keyof SnapshotPayload & string> = [
    "works",
    "chapters",
    "characters",
    "locations",
    "artifacts",
    "chapter_summaries",
    "evidences",
    "reviews",
    "runs",
  ];
  let merged = 0;
  for (const key of stores) {
    const items = parsed[key];
    if (!Array.isArray(items)) continue;
    const storeName = key === "reviews" ? "review_items" : key === "runs" ? "analysis_runs" : key;
    const tx = db.transaction(storeName as never, "readwrite");
    for (const item of items) {
      await tx.objectStore(storeName as never).put(item as never);
      merged++;
    }
    await tx.done;
  }
  return merged;
}
