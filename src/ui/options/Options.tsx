import { useCallback, useEffect, useRef, useState } from "react";
import { call, MessagingError } from "@/messaging/client";
import type { Work } from "@/kb/models/work";

const KEY_ANALYZE_BUTTON = "bookrag.analyzeButtonEnabled";
const KEY_CONFIDENCE = "bookrag.confidenceThreshold";

export function Options() {
  const [analyzeButton, setAnalyzeButton] = useState(true);
  const [threshold, setThreshold] = useState(0.5);
  const [works, setWorks] = useState<Work[]>([]);
  const [exportWorkId, setExportWorkId] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void chrome.storage.local
      .get([KEY_ANALYZE_BUTTON, KEY_CONFIDENCE])
      .then((vals) => {
        if (typeof vals[KEY_ANALYZE_BUTTON] === "boolean")
          setAnalyzeButton(vals[KEY_ANALYZE_BUTTON]);
        if (typeof vals[KEY_CONFIDENCE] === "number") setThreshold(vals[KEY_CONFIDENCE]);
      });
    void call("kb/listWorks", {}).then(setWorks).catch(() => setWorks([]));
  }, []);

  const onAnalyzeButtonChange = useCallback(async (next: boolean) => {
    setAnalyzeButton(next);
    await chrome.storage.local.set({ [KEY_ANALYZE_BUTTON]: next });
  }, []);

  const onThresholdChange = useCallback(async (next: number) => {
    setThreshold(next);
    await chrome.storage.local.set({ [KEY_CONFIDENCE]: next });
  }, []);

  const onExport = useCallback(async () => {
    setBusy("export");
    setError(null);
    setInfo(null);
    try {
      const payload = exportWorkId
        ? { workId: exportWorkId }
        : ({} as { workId?: string });
      const { json } = await call("kb/export", payload);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      const name = exportWorkId
        ? `bookrag-${stamp}-${exportWorkId}.json`
        : `bookrag-${stamp}-all.json`;
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      setInfo(`Экспорт сохранён: ${name}`);
    } catch (err) {
      setError(toMessage(err));
    } finally {
      setBusy(null);
    }
  }, [exportWorkId]);

  const onImportFile = useCallback(async (file: File) => {
    setBusy("import");
    setError(null);
    setInfo(null);
    try {
      const text = await file.text();
      const { merged } = await call("kb/import", { json: text });
      setInfo(`Импорт завершён, обновлено записей: ${merged}`);
      const updated = await call("kb/listWorks", {});
      setWorks(updated);
    } catch (err) {
      setError(toMessage(err));
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }, []);

  return (
    <div style={{ padding: 24, maxWidth: 720, margin: "0 auto" }} className="stack">
      <h1 style={{ margin: 0 }}>Настройки</h1>

      <section className="card stack">
        <strong>Кнопка анализа на странице</strong>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={analyzeButton}
            onChange={(e) => void onAnalyzeButtonChange(e.target.checked)}
          />
          <span>Показывать кнопку «Анализировать главу» прямо на странице читалки</span>
        </label>
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>
          Позволяет запускать анализ без открытия попапа. Применяется при следующей загрузке
          страницы.
        </p>
      </section>

      <section className="card stack">
        <strong>Порог уверенности</strong>
        <div className="row">
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={threshold}
            onChange={(e) => void onThresholdChange(Number.parseFloat(e.target.value))}
            style={{ flex: 1 }}
          />
          <span style={{ minWidth: 48, textAlign: "right" }}>{threshold.toFixed(2)}</span>
        </div>
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>
          Минимальная уверенность модели, при которой факты применяются автоматически. Ниже
          порога — попадает в очередь ручной проверки.
        </p>
      </section>

      <section className="card stack">
        <strong>Экспорт справочника</strong>
        <div className="row">
          <select
            value={exportWorkId}
            onChange={(e) => setExportWorkId(e.target.value)}
            style={{ flex: 1, padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "transparent", color: "var(--fg)" }}
          >
            <option value="">Все произведения</option>
            {works.map((w) => (
              <option key={w.id} value={w.id}>{w.title}</option>
            ))}
          </select>
          <button onClick={onExport} disabled={busy !== null}>
            {busy === "export" ? "Готовим..." : "Скачать JSON"}
          </button>
        </div>
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>
          Сохраняется как обычный JSON-файл. Можно открыть, прочитать, перенести на другой
          компьютер.
        </p>
      </section>

      <section className="card stack">
        <strong>Импорт справочника</strong>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onImportFile(f);
          }}
        />
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>
          Существующие записи перезаписываются по id (put), новые добавляются. Несовпадающие версии
          будут отклонены с ошибкой.
        </p>
      </section>

      {info && <div className="badge ok" style={{ alignSelf: "flex-start" }}>{info}</div>}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

function toMessage(err: unknown): string {
  if (err instanceof MessagingError || err instanceof Error) return err.message;
  return String(err);
}
