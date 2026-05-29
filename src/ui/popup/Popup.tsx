import { useCallback, useEffect, useState } from "react";
import { call, MessagingError, subscribe } from "@/messaging/client";
import type { ProfileStateDto, QueueTaskSnapshot } from "@/messaging/contracts";
import { parseActiveTab } from "@/ui/shared/hooks";
import type { ParsedChapter } from "@/parsers/types";

const POPUP_STYLE: React.CSSProperties = { width: 360, padding: 16 };

type AnalyzeStatus =
  | { kind: "idle" }
  | { kind: "parsing" }
  | { kind: "no-chapter" }
  | { kind: "no-model" }
  | { kind: "queued"; taskId: string }
  | { kind: "error"; message: string };

export function Popup() {
  const [parsed, setParsed] = useState<ParsedChapter | null>(null);
  const [profiles, setProfiles] = useState<ProfileStateDto[]>([]);
  const [activeTask, setActiveTask] = useState<QueueTaskSnapshot | null>(null);
  const [status, setStatus] = useState<AnalyzeStatus>({ kind: "idle" });

  const refreshProfiles = useCallback(async () => {
    try {
      const list = await call("models/list", {});
      setProfiles(list);
    } catch {
      setProfiles([]);
    }
  }, []);

  const refreshQueue = useCallback(async () => {
    try {
      const snap = await call("queue/snapshot", {});
      setActiveTask(latestActive(snap));
    } catch {
      setActiveTask(null);
    }
  }, []);

  useEffect(() => {
    void parseActiveTab().then(setParsed);
    void refreshProfiles();
    void refreshQueue();
  }, [refreshProfiles, refreshQueue]);

  // Подписка на обновления очереди — чтобы прогресс ехал в реальном времени.
  useEffect(() => {
    return subscribe("broadcast/queue", (snap) => {
      setActiveTask((prev) => {
        if (!prev) return snap;
        if (prev.taskId === snap.taskId) return snap;
        // Новая задача важнее старой завершившейся.
        if (prev.status === "done" || prev.status === "error" || prev.status === "cancelled") {
          return snap;
        }
        return prev;
      });
    });
  }, []);

  const active = profiles.find((p) => p.isActive);
  const ready = profiles.find((p) => p.status === "ready");

  const analyze = useCallback(async () => {
    setStatus({ kind: "parsing" });
    const fresh = parsed ?? (await parseActiveTab());
    if (!fresh) {
      setStatus({ kind: "no-chapter" });
      return;
    }
    if (!active && !ready) {
      setStatus({ kind: "no-model" });
      return;
    }
    try {
      const { taskId } = await call("chapters/analyze", { parsed: fresh });
      setStatus({ kind: "queued", taskId });
      await refreshQueue();
    } catch (err) {
      const message = err instanceof MessagingError || err instanceof Error
        ? err.message
        : String(err);
      setStatus({ kind: "error", message });
    }
  }, [parsed, active, ready, refreshQueue]);

  const cancel = useCallback(async () => {
    if (!activeTask) return;
    try {
      await call("queue/cancel", { taskId: activeTask.taskId });
      await refreshQueue();
    } catch {
      /* noop */
    }
  }, [activeTask, refreshQueue]);

  const openSidePanel = useCallback(async () => {
    try {
      await call("ui/openSidePanel", {});
      window.close();
    } catch {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.windowId !== undefined) {
        await chrome.sidePanel.open({ windowId: tab.windowId });
        window.close();
      }
    }
  }, []);

  const openModels = useCallback(() => {
    void chrome.tabs.create({ url: chrome.runtime.getURL("src/ui/models/index.html") });
  }, []);

  const openOptions = useCallback(() => {
    void chrome.runtime.openOptionsPage();
  }, []);

  return (
    <div style={POPUP_STYLE} className="stack">
      <h1 style={{ margin: 0, fontSize: 16 }}>BookRAG</h1>

      <ChapterBlock parsed={parsed} />
      <ModelBlock profiles={profiles} />
      <QueueBlock task={activeTask} onCancel={cancel} />

      <button
        onClick={analyze}
        disabled={
          !parsed ||
          status.kind === "parsing" ||
          (activeTask?.status === "queued" || activeTask?.status === "running")
        }
      >
        {status.kind === "parsing" ? "Подготовка..." : "Анализировать главу"}
      </button>
      <StatusLine status={status} />

      <button className="secondary" onClick={openSidePanel}>
        Открыть справочник
      </button>
      <button className="secondary" onClick={openModels}>
        Менеджер моделей
      </button>
      <button className="secondary" onClick={openOptions}>
        Настройки
      </button>
    </div>
  );
}

function ChapterBlock({ parsed }: { parsed: ParsedChapter | null }) {
  if (!parsed) {
    return (
      <div className="card">
        <div className="muted">
          Не удалось определить главу на этой странице. Откройте читалку Author.Today, Ficbook или
          Royal Road, либо обычную статью с текстом.
        </div>
      </div>
    );
  }
  return (
    <div className="card stack" style={{ gap: 4 }}>
      <strong>{parsed.workTitle}</strong>
      <div>
        <span className="badge info">Глава {parsed.chapterNumber || "?"}</span>{" "}
        {parsed.chapterTitle}
      </div>
      <div className="muted" style={{ fontSize: 11 }}>
        {parsed.paragraphs.length} абз., {parsed.text.length.toLocaleString("ru-RU")} символов · {parsed.adapterId}
      </div>
    </div>
  );
}

function ModelBlock({ profiles }: { profiles: ProfileStateDto[] }) {
  const active = profiles.find((p) => p.isActive);
  const ready = profiles.filter((p) => p.status === "ready");
  if (profiles.length === 0) {
    return <div className="muted" style={{ fontSize: 12 }}>Состояние моделей загружается…</div>;
  }
  if (!active && ready.length === 0) {
    return (
      <div className="card">
        <div className="error">
          Модель не загружена. Откройте «Менеджер моделей» и скачайте профиль.
        </div>
      </div>
    );
  }
  return (
    <div className="row" style={{ fontSize: 12 }}>
      <span className="muted">Модель:</span>
      <strong>{(active ?? ready[0])!.label}</strong>
      {active ? (
        <span className="badge ok">активна</span>
      ) : (
        <span className="badge warn">неактивна</span>
      )}
    </div>
  );
}

function QueueBlock({
  task,
  onCancel,
}: {
  task: QueueTaskSnapshot | null;
  onCancel: () => void;
}) {
  if (!task) return null;
  if (task.status === "done") {
    return <div className="badge ok">Анализ завершён</div>;
  }
  if (task.status === "error") {
    return (
      <div className="card stack" style={{ gap: 4 }}>
        <span className="badge err">Ошибка</span>
        <div className="error">{task.error}</div>
      </div>
    );
  }
  if (task.status === "cancelled") {
    return <div className="badge warn">Отменено</div>;
  }
  return (
    <div className="card stack" style={{ gap: 8 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="badge info">{task.status}</span>
        <button className="secondary" onClick={onCancel} style={{ padding: "2px 8px", fontSize: 12 }}>
          Отменить
        </button>
      </div>
      {task.progress && (
        <div className="muted" style={{ fontSize: 12 }}>
          Этап: <strong>{task.progress.stage}</strong>
          {task.progress.message ? ` · ${task.progress.message}` : ""}
          {task.progress.totalChunks
            ? ` (фрагмент ${(task.progress.chunkIndex ?? 0) + 1}/${task.progress.totalChunks})`
            : ""}
        </div>
      )}
    </div>
  );
}

function StatusLine({ status }: { status: AnalyzeStatus }) {
  switch (status.kind) {
    case "idle":
    case "parsing":
      return null;
    case "no-chapter":
      return <div className="error">Глава не распознана. Обнови страницу или открой читалку.</div>;
    case "no-model":
      return <div className="error">Сначала загрузите модель в «Менеджере моделей».</div>;
    case "queued":
      return <div className="muted" style={{ fontSize: 12 }}>Задача поставлена в очередь.</div>;
    case "error":
      return <div className="error">{status.message}</div>;
  }
}

function latestActive(snaps: readonly QueueTaskSnapshot[]): QueueTaskSnapshot | null {
  // Берём текущую running, иначе queued, иначе самую свежую завершённую.
  const running = snaps.find((s) => s.status === "running");
  if (running) return running;
  const queued = snaps.find((s) => s.status === "queued");
  if (queued) return queued;
  const sorted = [...snaps].sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
  return sorted[0] ?? null;
}
