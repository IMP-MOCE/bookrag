// Очередь задач анализа главы. Обрабатывает по одной задаче за раз: пока крутится модель,
// ставить вторую главу параллельно нет смысла (одна WebGPU-сессия). Сама очередь не знает,
// откуда берётся текст и куда пишутся операции — это инжектируется через `processor`.

import type { ParsedChapter } from "../parsers/types";
import type { QueueTaskProgress, QueueTaskSnapshot } from "../messaging/contracts";

export interface QueueTask {
  id: string;
  workId: string;
  chapterId: string; // populated после createWork/addChapter, до этого — пусто.
  chapterNumber: number;
  parsed: ParsedChapter;
  enqueuedAt: number;
}

export interface ProcessorContext {
  task: QueueTask;
  signal: AbortSignal;
  reportProgress: (p: QueueTaskProgress) => void;
  // Процессор может уточнить chapterId после addChapter — чтобы snapshot отдавал реальный id.
  setChapterMeta: (meta: { chapterId: string; workId: string; chapterNumber: number }) => void;
}

export type QueueProcessor = (ctx: ProcessorContext) => Promise<void>;

interface InternalState {
  task: QueueTask;
  status: "queued" | "running" | "done" | "error" | "cancelled";
  progress?: QueueTaskProgress;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
  abort: AbortController;
}

export interface QueueOptions {
  processor: QueueProcessor;
  onUpdate?: (snapshot: QueueTaskSnapshot) => void;
  onIdle?: () => void;
  // Сколько последних завершённых задач хранить в snapshot для UI.
  retainCompleted?: number;
}

const DEFAULT_RETAIN = 10;

export class AnalysisQueue {
  private readonly processor: QueueProcessor;
  private readonly onUpdate: (snapshot: QueueTaskSnapshot) => void;
  private readonly onIdle: () => void;
  private readonly retain: number;
  private readonly states = new Map<string, InternalState>();
  private readonly order: string[] = [];
  private running = false;

  constructor(opts: QueueOptions) {
    this.processor = opts.processor;
    this.onUpdate = opts.onUpdate ?? (() => undefined);
    this.onIdle = opts.onIdle ?? (() => undefined);
    this.retain = opts.retainCompleted ?? DEFAULT_RETAIN;
  }

  enqueue(parsed: ParsedChapter): QueueTaskSnapshot {
    const id = `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const task: QueueTask = {
      id,
      workId: "",
      chapterId: "",
      chapterNumber: parsed.chapterNumber,
      parsed,
      enqueuedAt: Date.now(),
    };
    const state: InternalState = {
      task,
      status: "queued",
      abort: new AbortController(),
    };
    this.states.set(id, state);
    this.order.push(id);
    this.emit(state);
    // Запускаем pump в следующем микротаске, чтобы вызывающий успел получить
    // snapshot со статусом "queued" до того, как processor его обновит.
    queueMicrotask(() => void this.pump());
    return this.toSnapshot(state);
  }

  cancel(taskId: string): boolean {
    const state = this.states.get(taskId);
    if (!state) return false;
    if (state.status === "done" || state.status === "error" || state.status === "cancelled") {
      return false;
    }
    state.abort.abort();
    if (state.status === "queued") {
      state.status = "cancelled";
      state.finishedAt = Date.now();
      this.emit(state);
    }
    // Если задача уже running — финальный статус выставит сам процессор по AbortSignal.
    return true;
  }

  snapshot(): QueueTaskSnapshot[] {
    return this.order.map((id) => this.toSnapshot(this.states.get(id)!));
  }

  hasActiveWork(): boolean {
    return this.running || this.order.some((id) => this.states.get(id)?.status === "queued");
  }

  private toSnapshot(state: InternalState): QueueTaskSnapshot {
    const snap: QueueTaskSnapshot = {
      taskId: state.task.id,
      workId: state.task.workId,
      chapterId: state.task.chapterId,
      chapterNumber: state.task.chapterNumber,
      status: state.status,
      enqueuedAt: state.task.enqueuedAt,
    };
    if (state.startedAt !== undefined) snap.startedAt = state.startedAt;
    if (state.finishedAt !== undefined) snap.finishedAt = state.finishedAt;
    if (state.progress) snap.progress = state.progress;
    if (state.error) snap.error = state.error;
    return snap;
  }

  private emit(state: InternalState): void {
    try {
      this.onUpdate(this.toSnapshot(state));
    } catch (err) {
      console.warn("[BookRAG] queue onUpdate threw", err);
    }
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (true) {
        const next = this.order
          .map((id) => this.states.get(id))
          .find((s): s is InternalState => Boolean(s) && s!.status === "queued");
        if (!next) break;
        await this.runOne(next);
      }
    } finally {
      this.running = false;
      this.trimRetained();
      try {
        this.onIdle();
      } catch (err) {
        console.warn("[BookRAG] queue onIdle threw", err);
      }
    }
  }

  private async runOne(state: InternalState): Promise<void> {
    state.status = "running";
    state.startedAt = Date.now();
    this.emit(state);
    try {
      await this.processor({
        task: state.task,
        signal: state.abort.signal,
        reportProgress: (p) => {
          state.progress = p;
          this.emit(state);
        },
        setChapterMeta: (meta) => {
          state.task.workId = meta.workId;
          state.task.chapterId = meta.chapterId;
          state.task.chapterNumber = meta.chapterNumber;
        },
      });
      if (state.abort.signal.aborted) {
        state.status = "cancelled";
      } else {
        state.status = "done";
        state.progress = { stage: "done" };
      }
    } catch (err) {
      if (state.abort.signal.aborted) {
        state.status = "cancelled";
      } else {
        state.status = "error";
        state.error = err instanceof Error ? err.message : String(err);
      }
    } finally {
      state.finishedAt = Date.now();
      this.emit(state);
    }
  }

  private trimRetained(): void {
    const completedIds = this.order.filter((id) => {
      const s = this.states.get(id);
      return s && (s.status === "done" || s.status === "error" || s.status === "cancelled");
    });
    if (completedIds.length <= this.retain) return;
    const dropCount = completedIds.length - this.retain;
    const toDrop = completedIds.slice(0, dropCount);
    for (const id of toDrop) {
      this.states.delete(id);
      const idx = this.order.indexOf(id);
      if (idx >= 0) this.order.splice(idx, 1);
    }
  }
}
