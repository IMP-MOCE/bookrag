// Плавающая кнопка «Анализировать главу» прямо на странице читалки — чтобы не
// открывать попап на каждой главе. Живёт в отдельном shadow-root (стили
// страницы не ломают вёрстку и наоборот). Сама парсит главу, гейтит запуск так
// же, как Popup.tsx (глава распознана + модель ready/active + нет активной
// задачи) и показывает прогресс через broadcast/queue.

import { call, subscribe } from "../messaging/client";
import type { QueueTaskSnapshot } from "../messaging/contracts";
import type { ParsedChapter } from "../parsers/types";

const HOST_ID = "bookrag-analyze-host";
const QUEUE_POLL_INTERVAL_MS = 1000;
const QUEUE_POLL_TIMEOUT_MS = 5000;

const STYLES = `
  :host { all: initial; }
  .wrap {
    position: fixed;
    right: 20px;
    bottom: 20px;
    z-index: 2147483646;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 6px;
    font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .btn {
    all: unset;
    box-sizing: border-box;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 10px 16px;
    border-radius: 22px;
    background: #0969da;
    color: #fff;
    font-weight: 600;
    box-shadow: 0 4px 14px rgba(9,105,218,0.35);
    user-select: none;
  }
  .btn:hover { background: #0860c9; }
  .btn[disabled] { background: #8c959f; cursor: default; box-shadow: none; }
  .status {
    max-width: 260px;
    padding: 6px 10px;
    border-radius: 8px;
    background: #fff;
    color: #1f2328;
    border: 1px solid #d0d7de;
    box-shadow: 0 4px 14px rgba(0,0,0,0.12);
  }
  .status[hidden] { display: none; }
  .status.err { color: #cf222e; border-color: #f1aeb5; }
  .status.ok { color: #1a7f37; border-color: #aceebb; }
  .status .hint { display: block; margin-top: 4px; color: #57606a; font-size: 11px; }
  @media (prefers-color-scheme: dark) {
    .status { background: #161b22; color: #e6edf3; border-color: #30363d; }
    .status .hint { color: #8d96a0; }
  }
`;

type Phase =
  | { kind: "idle" }
  | { kind: "parsing" }
  | { kind: "no-chapter" }
  | { kind: "no-model" }
  | { kind: "busy" } // уже есть активная задача в очереди
  | { kind: "queued"; taskId: string }
  | { kind: "running"; taskId: string; text: string }
  | { kind: "done" }
  | { kind: "error"; message: string };

export interface AnalyzeButtonController {
  destroy(): void;
}

export interface InstallAnalyzeButtonOptions {
  // Возвращает свежий разбор текущей страницы (или null, если это не глава).
  getParsed: () => ParsedChapter | null;
}

function progressText(p: QueueTaskSnapshot["progress"]): string {
  if (!p) return "Анализ…";
  if (p.totalChunks && typeof p.chunkIndex === "number") {
    const pct = Math.round(((p.chunkIndex + 1) / p.totalChunks) * 100);
    return `Анализ ${pct}% (${p.chunkIndex + 1}/${p.totalChunks})`;
  }
  const stage: Record<NonNullable<QueueTaskSnapshot["progress"]>["stage"], string> = {
    context: "Сбор контекста…",
    chunk: "Анализ фрагментов…",
    reconcile: "Сверка с справочником…",
    validate: "Проверка…",
    apply: "Применение…",
    done: "Готово",
  };
  return stage[p.stage] ?? "Анализ…";
}

export function installAnalyzeButton(
  opts: InstallAnalyzeButtonOptions,
): AnalyzeButtonController {
  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText = "all: initial;";
  const shadow = host.attachShadow({ mode: "open" });

  const styleEl = document.createElement("style");
  styleEl.textContent = STYLES;
  shadow.appendChild(styleEl);

  const wrap = document.createElement("div");
  wrap.className = "wrap";

  const status = document.createElement("div");
  status.className = "status";
  status.hidden = true;

  const btn = document.createElement("button");
  btn.className = "btn";
  btn.type = "button";

  wrap.appendChild(status);
  wrap.appendChild(btn);
  shadow.appendChild(wrap);
  document.documentElement.appendChild(host);

  let activeTaskId: string | null = null;
  let running = false; // защита от двойного клика, пока летит запрос
  let pollTimer: number | null = null;

  function render(phase: Phase): void {
    btn.textContent = phase.kind === "parsing" ? "📖 Подготовка…" : "📖 Анализировать главу";
    const disabled =
      phase.kind === "parsing" ||
      phase.kind === "busy" ||
      phase.kind === "queued" ||
      phase.kind === "running";
    btn.disabled = disabled;

    status.classList.remove("err", "ok");
    let html = "";
    switch (phase.kind) {
      case "idle":
      case "parsing":
        status.textContent = "";
        status.hidden = true;
        return;
      case "no-chapter":
        status.classList.add("err");
        html = "Глава не распознана. Обнови страницу.";
        break;
      case "no-model":
        status.classList.add("err");
        html =
          "Модель не загружена.<span class=\"hint\">Откройте попап BookRAG → «Менеджер моделей» и скачайте профиль.</span>";
        break;
      case "busy":
        html = "Уже выполняется другой анализ — дождитесь завершения.";
        break;
      case "queued":
        html = "Задача поставлена в очередь…";
        break;
      case "running":
        html = phase.text;
        break;
      case "done":
        status.classList.add("ok");
        html = "Анализ завершён ✓";
        break;
      case "error":
        status.classList.add("err");
        html = `Ошибка: ${escapeHtml(phase.message)}`;
        break;
    }
    status.innerHTML = html;
    status.hidden = false;
  }

  function escapeHtml(s: string): string {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  function applyQueueSnapshot(snap: QueueTaskSnapshot): void {
    if (!activeTaskId || snap.taskId !== activeTaskId) return;
    switch (snap.status) {
      case "queued":
        render({ kind: "queued", taskId: snap.taskId });
        break;
      case "running":
        render({ kind: "running", taskId: snap.taskId, text: progressText(snap.progress) });
        break;
      case "done":
        activeTaskId = null;
        stopPolling();
        render({ kind: "done" });
        break;
      case "error":
        activeTaskId = null;
        stopPolling();
        render({ kind: "error", message: snap.error ?? "анализ не удался" });
        break;
      case "cancelled":
        activeTaskId = null;
        stopPolling();
        render({ kind: "idle" });
        break;
    }
  }

  async function pollQueueSnapshot(): Promise<void> {
    try {
      const snaps = await call("queue/snapshot", {}, { timeoutMs: QUEUE_POLL_TIMEOUT_MS });
      if (activeTaskId) {
        const snap = snaps.find((s) => s.taskId === activeTaskId);
        if (snap) {
          applyQueueSnapshot(snap);
          return;
        }

        // Если конкретная задача уже пропала из retained snapshot, не держим
        // кнопку серой бесконечно. Без final snapshot не знаем done/error, поэтому
        // возвращаемся в idle.
        const stillBusy = snaps.some((s) => s.status === "queued" || s.status === "running");
        if (!stillBusy) {
          activeTaskId = null;
          stopPolling();
          render({ kind: "idle" });
        }
        return;
      }

      const busy = snaps.some((s) => s.status === "queued" || s.status === "running");
      if (busy) {
        render({ kind: "busy" });
      } else {
        stopPolling();
        render({ kind: "idle" });
      }
    } catch {
      // Broadcast может всё ещё прийти; сетевой/worker hiccup не должен сбрасывать
      // локальное состояние кнопки.
    }
  }

  function startPolling(): void {
    if (pollTimer !== null) return;
    pollTimer = window.setInterval(() => void pollQueueSnapshot(), QUEUE_POLL_INTERVAL_MS);
    void pollQueueSnapshot();
  }

  function stopPolling(): void {
    if (pollTimer === null) return;
    window.clearInterval(pollTimer);
    pollTimer = null;
  }

  // Прогресс задачи в реальном времени — тот же канал, что слушает попап.
  // Для content script дополнительно есть polling: runtime broadcast может быть
  // пропущен, а кнопка не должна зависать disabled до перезагрузки страницы.
  const unsubscribe = subscribe("broadcast/queue", applyQueueSnapshot);

  async function onClick(): Promise<void> {
    if (running || activeTaskId) return;
    running = true;
    try {
      render({ kind: "parsing" });
      const parsed = opts.getParsed();
      if (!parsed) {
        render({ kind: "no-chapter" });
        return;
      }

      // Гейтинг как в Popup.tsx: модель должна быть активной или ready.
      try {
        const profiles = await call("models/list", {});
        const hasModel = profiles.some((p) => p.isActive || p.status === "ready");
        if (!hasModel) {
          render({ kind: "no-model" });
          return;
        }
      } catch {
        render({ kind: "no-model" });
        return;
      }

      // Не плодим параллельные задачи: одна очередь на попап и кнопку.
      try {
        const snaps = await call("queue/snapshot", {});
        const busy = snaps.some((s) => s.status === "queued" || s.status === "running");
        if (busy) {
          render({ kind: "busy" });
          startPolling();
          return;
        }
      } catch {
        /* снапшот недоступен — не блокируем, бэкенд сам разрулит */
      }

      const { taskId } = await call("chapters/analyze", { parsed });
      activeTaskId = taskId;
      render({ kind: "queued", taskId });
      startPolling();
    } catch (err) {
      stopPolling();
      render({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      running = false;
    }
  }

  btn.addEventListener("click", () => void onClick());
  render({ kind: "idle" });

  return {
    destroy() {
      unsubscribe();
      stopPolling();
      host.remove();
    },
  };
}
