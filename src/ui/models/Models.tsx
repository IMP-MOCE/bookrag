import { useCallback, useEffect, useMemo, useState } from "react";
import { call, MessagingError, subscribe } from "@/messaging/client";
import type {
  DiagnosticsDto,
  ProfileStateDto,
} from "@/messaging/contracts";
import type { ProfileId } from "@/llm/profiles";

interface ProgressView {
  text: string;
  pct: number;
}

interface BenchmarkMetric {
  label: string;
  candidate: string;
  baseline: string;
  delta: string;
  tone?: "good" | "warn";
}

interface ProfileBenchmark {
  title: string;
  dataset: string;
  date: string;
  cases: string;
  summary: BenchmarkMetric[];
  details: BenchmarkMetric[];
}

const PROFILE_DISPLAY_ORDER: Record<ProfileId, number> = {
  balanced: 0,
  light: 1,
};

const PROFILE_BENCHMARKS: Record<ProfileId, ProfileBenchmark> = {
  balanced: {
    title: "4B FTv6 против FTv5",
    dataset: "dataset_ftv6_bench",
    date: "27.05.2026",
    cases: "99 кейсов",
    summary: [
      { label: "FTv6 full", candidate: "78.29", baseline: "71.99", delta: "+6.30", tone: "good" },
      { label: "Schema-valid", candidate: "100%", baseline: "100%", delta: "0 п.п.", tone: "good" },
      { label: "Operations F1", candidate: "0.298", baseline: "0.233", delta: "+0.065", tone: "good" },
      { label: "Pass 2 composite", candidate: "89.53", baseline: "84.61", delta: "+4.92", tone: "good" },
    ],
    details: [
      { label: "Extraction F1", candidate: "0.796", baseline: "0.826", delta: "-0.030", tone: "warn" },
      { label: "Refusal recall", candidate: "100%", baseline: "80%", delta: "+20 п.п.", tone: "good" },
      { label: "Transferable F1", candidate: "0.593", baseline: "0.051", delta: "+0.542", tone: "good" },
      { label: "False merge rate", candidate: "6.90%", baseline: "0%", delta: "+6.90 п.п.", tone: "warn" },
      { label: "Latency p95", candidate: "44.5 с", baseline: "42.7 с", delta: "+1.8 с", tone: "warn" },
    ],
  },
  light: {
    title: "2B FTv5 против base",
    dataset: "dataset_ftv5_bench",
    date: "25.05.2026",
    cases: "100 кейсов",
    summary: [
      { label: "FTv5 isolated", candidate: "67.80", baseline: "48.33", delta: "+19.47", tone: "good" },
      { label: "Schema-valid", candidate: "99%", baseline: "59%", delta: "+40 п.п.", tone: "good" },
      { label: "Extraction F1", candidate: "0.810", baseline: "0.362", delta: "+0.448", tone: "good" },
      { label: "Pass 2 composite", candidate: "77.97", baseline: "60.89", delta: "+17.08", tone: "good" },
    ],
    details: [
      { label: "Pass 2 decision acc", candidate: "0.898", baseline: "0.678", delta: "+0.220", tone: "good" },
      { label: "Candidate ID acc", candidate: "0.928", baseline: "0.967", delta: "-0.040", tone: "warn" },
      { label: "False merge rate", candidate: "20.69%", baseline: "100%", delta: "-79.31 п.п.", tone: "good" },
      { label: "Refusal recall", candidate: "80%", baseline: "0%", delta: "+80 п.п.", tone: "good" },
      { label: "Latency p95", candidate: "55.7 с", baseline: "10.2 с", delta: "+45.5 с", tone: "warn" },
    ],
  },
};

const PROFILE_META: Record<ProfileId, {
  eyebrow: string;
  title: string;
  accent: string;
  note: string;
  chips: string[];
}> = {
  light: {
    eyebrow: "Быстрый FTv5",
    title: "2B FTv5",
    accent: "light",
    note: "Дообученный лёгкий профиль FTv5 для слабых устройств, smoke-проверок и сценариев, где важнее скорость старта.",
    chips: ["Qwen3.5 2B", "FTv5", "экономный"],
  },
  balanced: {
    eyebrow: "Основной профиль",
    title: "4B FTv6",
    accent: "balanced",
    note: "Основной FTv6-профиль для извлечения сущностей, сводок главы, операций справочника и Pass 2 сверки с KB.",
    chips: ["Qwen3.5 4B", "FTv6", "BookRAG"],
  },
};

export function Models() {
  const [diag, setDiag] = useState<DiagnosticsDto | null>(null);
  const [diagError, setDiagError] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<ProfileStateDto[]>([]);
  const [progress, setProgress] = useState<Record<string, ProgressView>>({});
  const [busy, setBusy] = useState<ProfileId | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const displayProfiles = useMemo(
    () => [...profiles].sort((a, b) => PROFILE_DISPLAY_ORDER[a.id] - PROFILE_DISPLAY_ORDER[b.id]),
    [profiles],
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      setProfiles(await call("models/list", {}));
    } catch (err) {
      console.warn("[BookRAG] models/list failed", err);
    } finally {
      setRefreshing(false);
    }
  }, []);

  const runDiagnose = useCallback(async () => {
    try {
      setDiag(await call("models/diagnose", {}));
      setDiagError(null);
    } catch (err) {
      const message = err instanceof MessagingError || err instanceof Error
        ? err.message
        : String(err);
      setDiagError(message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    return subscribe("broadcast/modelProgress", (report) => {
      setProgress((p) => ({
        ...p,
        [report.profileId]: {
          text: report.text ?? "Загрузка…",
          pct: Math.round((report.progress ?? 0) * 100),
        },
      }));
    });
  }, []);

  const onDownload = useCallback(
    async (id: ProfileId) => {
      setBusy(id);
      setProgress((p) => ({ ...p, [id]: { text: "Запуск...", pct: 0 } }));
      try {
        await call("models/download", { profileId: id }, { timeoutMs: 30 * 60_000 });
        setProgress((p) => ({ ...p, [id]: { text: "Готово", pct: 100 } }));
      } catch (err) {
        const message = err instanceof MessagingError || err instanceof Error
          ? err.message
          : String(err);
        setProgress((p) => ({ ...p, [id]: { text: `Ошибка: ${message}`, pct: 0 } }));
      } finally {
        setBusy(null);
        await refresh();
      }
    },
    [refresh],
  );

  const onRemove = useCallback(
    async (id: ProfileId) => {
      setBusy(id);
      try {
        await call("models/remove", { profileId: id });
        setProgress((p) => {
          const copy = { ...p };
          delete copy[id];
          return copy;
        });
      } finally {
        setBusy(null);
        await refresh();
      }
    },
    [refresh],
  );

  const onActivate = useCallback(
    async (id: ProfileId) => {
      await call("models/setActive", { profileId: id });
      await refresh();
    },
    [refresh],
  );

  return (
    <main className="models-page">
      <header className="models-hero">
        <div>
          <p className="models-kicker">Локальные веса WebGPU</p>
          <h1>Менеджер моделей</h1>
          <p>
            Веса хранятся в Cache Storage браузера, не входят в пакет расширения и скачиваются
            после установки. Лёгкий 2B остаётся на FTv5 для скорости, основной 4B использует
            FTv6 для качества.
          </p>
        </div>
        <div className="models-hero-meter" aria-label="Состояние профилей">
          <span>{profiles.filter((p) => p.status === "ready").length}/{profiles.length || 2}</span>
          <small>готово</small>
        </div>
      </header>

      <DiagnosticsBlock diag={diag} error={diagError} onRun={runDiagnose} />

      <section className="models-section">
        <div className="models-section-head">
          <div>
            <p className="models-kicker">Профили</p>
            <h2>Две локальные конфигурации</h2>
          </div>
          {refreshing ? <span className="models-refresh">обновление...</span> : null}
        </div>
      {profiles.length === 0 ? (
          <div className="models-empty">Загрузка профилей...</div>
      ) : (
          <div className="models-grid">
          {displayProfiles.map((state) => {
            const p = progress[state.id];
            return (
              <ProfileCard
                key={state.id}
                state={state}
                busy={busy === state.id}
                {...(p ? { progress: p } : {})}
                onDownload={onDownload}
                onRemove={onRemove}
                onActivate={onActivate}
              />
            );
          })}
          </div>
      )}
      </section>
    </main>
  );
}

function DiagnosticsBlock({
  diag,
  error,
  onRun,
}: {
  diag: DiagnosticsDto | null;
  error: string | null;
  onRun: () => void;
}) {
  return (
    <section className="models-diagnostics">
      <div className="models-diagnostics-top">
        <div>
          <p className="models-kicker">Устройство</p>
          <strong>Диагностика WebGPU</strong>
        </div>
        <button className="secondary models-compact-button" onClick={onRun}>
          {diag ? "Перепроверить" : "Запустить"}
        </button>
      </div>
      {error ? (
        <div className="error">{error}</div>
      ) : !diag ? (
        <div className="models-diagnostics-note">
          Диагностика поднимает offscreen-документ и проверяет WebGPU. Запустите вручную.
        </div>
      ) : (
        <div className="models-diagnostics-grid">
          <Row label="WebGPU">
            {diag.webgpuAvailable ? (
              <span className="models-good">поддерживается</span>
            ) : (
              <span className="models-bad">не обнаружен — анализ невозможен</span>
            )}
          </Row>
          {diag.webgpuAdapterName && <Row label="GPU-адаптер">{diag.webgpuAdapterName}</Row>}
          {diag.webgpuVendor && <Row label="Производитель">{diag.webgpuVendor}</Row>}
          {diag.maxBufferSizeMb && <Row label="Max buffer size">{diag.maxBufferSizeMb} МБ</Row>}
          {diag.deviceMemoryGb && <Row label="Память устройства">{diag.deviceMemoryGb} ГБ</Row>}
          <Row label="CPU потоков">{diag.hardwareConcurrency || "—"}</Row>
        </div>
      )}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="models-spec-row">
      <span>{label}</span>
      <strong>{children}</strong>
    </div>
  );
}

interface ProfileCardProps {
  state: ProfileStateDto;
  busy: boolean;
  progress?: ProgressView;
  onDownload: (id: ProfileId) => void;
  onRemove: (id: ProfileId) => void;
  onActivate: (id: ProfileId) => void;
}

function ProfileCard({
  state,
  busy,
  progress,
  onDownload,
  onRemove,
  onActivate,
}: ProfileCardProps) {
  const { id, label, description, modelId, approxSizeGb, approxVramGb, status, isActive } = state;
  const meta = PROFILE_META[id];
  const sizeText = useMemo(
    () => `~${approxSizeGb} ГБ на диске, ~${approxVramGb} ГБ VRAM`,
    [approxSizeGb, approxVramGb],
  );
  const isBalanced = id === "balanced";

  return (
    <article className={`models-card models-card-${meta.accent}${isActive ? " is-active" : ""}`}>
      <div className="models-card-top">
        <div className="models-model-mark" aria-hidden="true">
          {isBalanced ? "4B" : "2B"}
        </div>
        <StatusBadge status={status} isActive={isActive} />
      </div>

      <div className="models-card-heading">
        <p className="models-kicker">{meta.eyebrow}</p>
        <h3>{meta.title}</h3>
        <p>{meta.note}</p>
      </div>

      <div className="models-chips" aria-label={`${label}: ключевые свойства`}>
        {meta.chips.map((chip) => (
          <span key={chip}>{chip}</span>
        ))}
      </div>

      <div className="models-specs">
        <Row label="Профиль">{label}</Row>
        <Row label="Память">{sizeText}</Row>
        <Row label="model_id">
          <code>{modelId}</code>
        </Row>
      </div>

      <p className="models-description">{description}</p>

      <BenchmarkBlock benchmark={PROFILE_BENCHMARKS[id]} />

      {progress && (
        <div className="models-progress">
          <div>
            <span>{progress.text}</span>
            <strong>{progress.pct}%</strong>
          </div>
          <div className="progressbar">
            <div style={{ width: `${progress.pct}%` }} />
          </div>
        </div>
      )}

      <div className="models-actions">
        {status === "ready" ? (
          <>
            <button
              className={isActive ? "secondary" : ""}
              onClick={() => onActivate(id)}
              disabled={busy || isActive}
            >
              {isActive ? "Активна" : "Сделать активной"}
            </button>
            <button className="secondary" onClick={() => onRemove(id)} disabled={busy}>
              Удалить
            </button>
          </>
        ) : (
          <button onClick={() => onDownload(id)} disabled={busy}>
            {status === "downloading"
              ? "Загрузка..."
              : status === "error"
                ? "Повторить загрузку"
                : "Загрузить"}
          </button>
        )}
      </div>

      {state.errorMessage && <div className="error">{state.errorMessage}</div>}
    </article>
  );
}

function BenchmarkBlock({ benchmark }: { benchmark: ProfileBenchmark }) {
  return (
    <section className="models-benchmark" aria-label={benchmark.title}>
      <div className="models-benchmark-head">
        <div>
          <p className="models-kicker">Benchmark</p>
          <strong>{benchmark.title}</strong>
        </div>
        <span>{benchmark.dataset} · {benchmark.cases} · {benchmark.date}</span>
      </div>
      <div className="models-metrics">
        {benchmark.summary.map((metric) => (
          <Metric key={metric.label} metric={metric} />
        ))}
      </div>
      <details className="models-benchmark-details">
        <summary>Подробности сравнения</summary>
        <div className="models-detail-metrics">
          {benchmark.details.map((metric) => (
            <Metric key={metric.label} metric={metric} compact />
          ))}
        </div>
      </details>
    </section>
  );
}

function Metric({ metric, compact = false }: { metric: BenchmarkMetric; compact?: boolean }) {
  return (
    <div className={compact ? "models-metric is-compact" : "models-metric"}>
      <span>{metric.label}</span>
      <strong>{metric.candidate}</strong>
      <small>baseline {metric.baseline}</small>
      <em className={metric.tone === "warn" ? "is-warn" : ""}>{metric.delta}</em>
    </div>
  );
}

function StatusBadge({
  status,
  isActive,
}: {
  status: ProfileStateDto["status"];
  isActive: boolean;
}) {
  const map: Record<ProfileStateDto["status"], { text: string; cls: string }> = {
    not_downloaded: { text: "не загружена", cls: "" },
    downloading: { text: "загрузка", cls: "info" },
    ready: { text: isActive ? "активна" : "готова", cls: "ok" },
    error: { text: "ошибка", cls: "err" },
  };
  const v = map[status];
  return <span className={`badge ${v.cls}`}>{v.text}</span>;
}
