import { useCallback, useEffect, useMemo, useState } from "react";
import { call, MessagingError, subscribe } from "@/messaging/client";
import type { CharacterCard } from "@/kb/models/character";
import type { ChapterSummary } from "@/kb/models/event";
import type { Artifact, Location } from "@/kb/models/location";
import type { CollisionReviewItem, ReviewStatus } from "@/kb/models/review";
import type { Chapter, Work } from "@/kb/models/work";

// FTv6 (2026-05-26): tabs «События» и «Связи» удалены. Вместо событий — «Главы»
// показывает chapter_summary (модель пишет recap по каждой главе). Relations
// удалены полностью — частично покрываются полем role и chapter_summary.
type Tab = "characters" | "locations" | "summaries" | "chapters" | "reviews";

const TAB_LABELS: Record<Tab, string> = {
  characters: "Персонажи",
  locations: "Локации",
  summaries: "Резюме",
  chapters: "Главы",
  reviews: "Спорные",
};

type CharacterDraftField = "name" | "aliasesText" | "summary" | "role" | "status" | "confidence";

interface CharacterDraft {
  name: string;
  aliasesText: string;
  summary: string;
  role: string;
  status: string;
  confidence: string;
}

function characterToDraft(character: CharacterCard): CharacterDraft {
  return {
    name: character.name,
    aliasesText: character.aliases.join("\n"),
    summary: character.summary,
    role: character.role ?? "",
    status: character.status ?? "",
    confidence: character.confidence.toFixed(2),
  };
}

function parseAliases(text: string): string[] {
  return text
    .split(/\r?\n|,/)
    .map((alias) => alias.trim())
    .filter(Boolean);
}

function getErrorMessage(err: unknown): string {
  return err instanceof MessagingError || err instanceof Error ? err.message : String(err);
}

export function Sidepanel() {
  const [works, setWorks] = useState<Work[]>([]);
  const [selectedWork, setSelectedWork] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("characters");
  const [selectedCharacter, setSelectedCharacter] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const refreshWorks = useCallback(async () => {
    try {
      const list = await call("kb/listWorks", {});
      setWorks(list);
      if (list.length > 0 && !selectedWork) setSelectedWork(list[0]!.id);
    } catch (err) {
      console.warn("[BookRAG] kb/listWorks failed", err);
    }
  }, [selectedWork]);

  useEffect(() => {
    void refreshWorks();
  }, [refreshWorks]);

  // При обновлении KB сбрасываем счётчик — все вкладки перечитают данные.
  useEffect(() => {
    return subscribe("broadcast/kbChanged", (payload) => {
      if (selectedWork && payload.workId !== selectedWork) return;
      setReloadKey((k) => k + 1);
    });
  }, [selectedWork]);

  const work = works.find((w) => w.id === selectedWork) ?? null;

  return (
    <div className="sidepanel-page">
      <header className="sidepanel-header">
        <div className="sidepanel-brand">
          <span className="sidepanel-mark" aria-hidden="true">BR</span>
          <h1>Справочник</h1>
        </div>
      </header>
      <WorkPicker works={works} selectedId={selectedWork} onSelect={setSelectedWork} />
      {!work ? (
        <div className="sidepanel-empty">Анализируйте главу, чтобы появилось произведение.</div>
      ) : (
        <>
          <div className="tabs sidepanel-tabs">
            {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
              <button
                key={t}
                className={t === tab ? "active" : ""}
                onClick={() => {
                  setTab(t);
                  setSelectedCharacter(null);
                }}
              >
                {TAB_LABELS[t]}
              </button>
            ))}
          </div>

          <TabContent
            workId={work.id}
            tab={tab}
            reloadKey={reloadKey}
            selectedCharacter={selectedCharacter}
            onSelectCharacter={setSelectedCharacter}
          />
        </>
      )}
    </div>
  );
}

function WorkPicker({
  works,
  selectedId,
  onSelect,
}: {
  works: Work[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (works.length === 0) return null;
  if (works.length === 1) {
    return (
      <div className="sidepanel-work-card">
        <strong>{works[0]!.title}</strong>
      </div>
    );
  }
  return (
    <select
      className="bookrag-select"
      value={selectedId ?? ""}
      onChange={(e) => onSelect(e.target.value)}
    >
      {works.map((w) => (
        <option key={w.id} value={w.id}>
          {w.title}
        </option>
      ))}
    </select>
  );
}

function TabContent({
  workId,
  tab,
  reloadKey,
  selectedCharacter,
  onSelectCharacter,
}: {
  workId: string;
  tab: Tab;
  reloadKey: number;
  selectedCharacter: string | null;
  onSelectCharacter: (id: string | null) => void;
}) {
  switch (tab) {
    case "characters":
      return (
        <CharactersTab
          workId={workId}
          reloadKey={reloadKey}
          selectedId={selectedCharacter}
          onSelect={onSelectCharacter}
        />
      );
    case "chapters":
      return <ChaptersTab workId={workId} reloadKey={reloadKey} />;
    case "locations":
      return <LocationsTab workId={workId} reloadKey={reloadKey} />;
    case "summaries":
      return <ChapterSummariesTab workId={workId} reloadKey={reloadKey} />;
    case "reviews":
      return <ReviewsTab workId={workId} reloadKey={reloadKey} />;
  }
}

// ---------------- Characters ----------------

function CharactersTab({
  workId,
  reloadKey,
  selectedId,
  onSelect,
}: {
  workId: string;
  reloadKey: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [chars, setChars] = useState<CharacterCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await call("kb/listCharacters", { workId });
      // v4: сортировка по appearanceCount DESC, затем имя ASC. Самые
      // «активные» персонажи всплывают наверх.
      setChars(
        list.sort(
          (a, b) =>
            b.appearanceCount - a.appearanceCount ||
            a.name.localeCompare(b.name, "ru"),
        ),
      );
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [workId]);

  useEffect(() => {
    void reload();
  }, [reload, reloadKey]);

  const selected = chars.find((c) => c.id === selectedId) ?? null;

  if (loading) return <p className="muted">Загрузка...</p>;
  if (error) return <div className="error">{error}</div>;
  if (chars.length === 0) return <p className="muted">Персонажей пока нет.</p>;

  if (selected) {
    return (
      <CharacterDetails
        character={selected}
        allCharacters={chars}
        workId={workId}
        onBack={() => onSelect(null)}
        onSelect={(id) => onSelect(id)}
        onChanged={reload}
      />
    );
  }

  return (
    <ul className="list">
      {chars.map((c) => (
        <li key={c.id} onClick={() => onSelect(c.id)}>
          <div>
            <strong>{c.name}</strong>{" "}
            {c.role && <span className="muted" style={{ fontSize: 11 }}>· {c.role}</span>}
          </div>
          <div className="muted" style={{ fontSize: 11 }}>
            {c.appearanceCount}× · последняя гл. {c.lastUpdatedChapter}
          </div>
          {c.aliases.length > 0 && (
            <div className="muted" style={{ fontSize: 11 }}>
              {c.aliases.slice(0, 4).join(", ")}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function CharacterDetails({
  character,
  allCharacters,
  workId,
  onBack,
  onSelect,
  onChanged,
}: {
  character: CharacterCard;
  allCharacters: CharacterCard[];
  workId: string;
  onBack: () => void;
  onSelect: (id: string) => void;
  onChanged: () => Promise<void> | void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<CharacterDraft>(() => characterToDraft(character));
  const [busy, setBusy] = useState<"save" | "delete" | "merge" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mergeTargetId, setMergeTargetId] = useState("");

  useEffect(() => {
    setEditing(false);
    setDraft(characterToDraft(character));
    setBusy(null);
    setError(null);
  }, [character.id]);

  useEffect(() => {
    if (!editing) setDraft(characterToDraft(character));
  }, [character, editing]);

  const mergeCandidates = useMemo(
    () => allCharacters.filter((c) => c.id !== character.id),
    [allCharacters, character.id],
  );
  const selectedMergeTarget = mergeCandidates.find((c) => c.id === mergeTargetId) ?? null;

  useEffect(() => {
    setMergeTargetId((current) =>
      current && mergeCandidates.some((c) => c.id === current)
        ? current
        : mergeCandidates[0]?.id ?? "",
    );
  }, [mergeCandidates]);

  const updateDraft = useCallback((field: CharacterDraftField, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
  }, []);

  const save = useCallback(async () => {
    const name = draft.name.trim();
    const confidence = Number(draft.confidence.replace(",", "."));
    if (!name) {
      setError("Имя не должно быть пустым.");
      return;
    }
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      setError("Уверенность должна быть числом от 0 до 1.");
      return;
    }

    setBusy("save");
    setError(null);
    try {
      const updated = await call("kb/updateCharacter", {
        workId,
        characterId: character.id,
        patch: {
          name,
          aliases: parseAliases(draft.aliasesText),
          summary: draft.summary.trim(),
          role: draft.role.trim(),
          status: draft.status.trim(),
          confidence,
        },
      });
      setDraft(characterToDraft(updated));
      setEditing(false);
      await onChanged();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(null);
    }
  }, [character.id, draft, onChanged, workId]);

  const remove = useCallback(async () => {
    if (!window.confirm(`Удалить персонажа «${character.name}» из справочника?`)) return;
    setBusy("delete");
    setError(null);
    try {
      await call("kb/deleteCharacter", { workId, characterId: character.id });
      onBack();
      await onChanged();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(null);
    }
  }, [character.id, character.name, onBack, onChanged, workId]);

  const mergeIntoCurrent = useCallback(async () => {
    if (!selectedMergeTarget) return;
    if (!window.confirm(`Слить «${selectedMergeTarget.name}» в «${character.name}»?`)) return;
    setBusy("merge");
    setError(null);
    try {
      await call("kb/mergeCharacters", {
        workId,
        primaryId: character.id,
        secondaryId: selectedMergeTarget.id,
        reason: "manual sidepanel merge",
      });
      await onChanged();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(null);
    }
  }, [character.id, character.name, onChanged, selectedMergeTarget, workId]);

  const mergeCurrentIntoTarget = useCallback(async () => {
    if (!selectedMergeTarget) return;
    if (!window.confirm(`Слить «${character.name}» в «${selectedMergeTarget.name}»?`)) return;
    setBusy("merge");
    setError(null);
    try {
      await call("kb/mergeCharacters", {
        workId,
        primaryId: selectedMergeTarget.id,
        secondaryId: character.id,
        reason: "manual sidepanel merge",
      });
      onSelect(selectedMergeTarget.id);
      await onChanged();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(null);
    }
  }, [character.id, character.name, onChanged, onSelect, selectedMergeTarget, workId]);

  return (
    <div className="stack">
      <button
        className="secondary compact-button"
        onClick={onBack}
      >
        ← Назад к списку
      </button>
      {error && <div className="error">{error}</div>}
      {editing ? (
        <CharacterEditForm
          draft={draft}
          disabled={busy !== null}
          onChange={updateDraft}
          onCancel={() => {
            setDraft(characterToDraft(character));
            setEditing(false);
            setError(null);
          }}
          onSave={save}
        />
      ) : (
        <CharacterSummaryCard
          character={character}
          disabled={busy !== null}
          onEdit={() => setEditing(true)}
          onDelete={remove}
        />
      )}

      <CharacterMergePanel
        candidates={mergeCandidates}
        selectedId={mergeTargetId}
        disabled={busy !== null}
        onSelect={setMergeTargetId}
        onMergeIntoCurrent={mergeIntoCurrent}
        onMergeCurrentIntoTarget={mergeCurrentIntoTarget}
      />

      {character.history.length > 0 && (
        <div className="card stack">
          <strong>История</strong>
          <ul className="list" style={{ marginTop: 4 }}>
            {character.history.slice(-10).map((h, i) => (
              <li key={`${h.at}-${i}`} style={{ cursor: "default" }}>
                <div style={{ fontSize: 12 }}>
                  <strong>{h.operation}</strong>
                  {h.field && <> · {h.field}</>}
                  {h.value && <> · {h.value}</>}
                </div>
                <div className="muted" style={{ fontSize: 11 }}>
                  {new Date(h.at).toLocaleString("ru-RU")}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function CharacterSummaryCard({
  character,
  disabled,
  onEdit,
  onDelete,
}: {
  character: CharacterCard;
  disabled: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="card stack">
      <div className="row" style={{ alignItems: "flex-start", justifyContent: "space-between" }}>
        <div>
          <strong style={{ fontSize: 16 }}>{character.name}</strong>
          {character.role && <div className="muted">{character.role}</div>}
          {character.status && <div className="muted">{character.status}</div>}
        </div>
        <div className="row" style={{ flexWrap: "wrap", justifyContent: "flex-end" }}>
          <button className="secondary" disabled={disabled} onClick={onEdit}>
            Редактировать
          </button>
          <button
            className="secondary danger-button"
            disabled={disabled}
            onClick={onDelete}
          >
            Удалить
          </button>
        </div>
      </div>
      {character.summary && <p style={{ margin: 0 }}>{character.summary}</p>}
      {character.aliases.length > 0 && (
        <div>
          <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>Псевдонимы</div>
          <div className="row" style={{ flexWrap: "wrap" }}>
            {character.aliases.map((a) => (
              <span key={a} className="badge">{a}</span>
            ))}
          </div>
        </div>
      )}
      <div className="muted" style={{ fontSize: 11 }}>
        Появлений: {character.appearanceCount} · главы {character.firstSeenChapter}–
        {character.lastUpdatedChapter} · уверенность {character.confidence.toFixed(2)}
      </div>
    </div>
  );
}

function CharacterEditForm({
  draft,
  disabled,
  onChange,
  onCancel,
  onSave,
}: {
  draft: CharacterDraft;
  disabled: boolean;
  onChange: (field: CharacterDraftField, value: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div className="card stack">
      <label className="stack" style={{ gap: 4 }}>
        <span className="muted" style={{ fontSize: 11 }}>Имя</span>
        <input
          type="text"
          value={draft.name}
          disabled={disabled}
          onChange={(e) => onChange("name", e.target.value)}
          style={{ width: "100%" }}
        />
      </label>
      <label className="stack" style={{ gap: 4 }}>
        <span className="muted" style={{ fontSize: 11 }}>Псевдонимы</span>
        <textarea
          rows={3}
          value={draft.aliasesText}
          disabled={disabled}
          onChange={(e) => onChange("aliasesText", e.target.value)}
          style={{ width: "100%" }}
        />
      </label>
      <div className="row" style={{ alignItems: "stretch", flexWrap: "wrap" }}>
        <label className="stack" style={{ flex: "1 1 130px", gap: 4, minWidth: 0 }}>
          <span className="muted" style={{ fontSize: 11 }}>Роль</span>
          <input
            type="text"
            value={draft.role}
            disabled={disabled}
            onChange={(e) => onChange("role", e.target.value)}
            style={{ width: "100%" }}
          />
        </label>
        <label className="stack" style={{ flex: "1 1 130px", gap: 4, minWidth: 0 }}>
          <span className="muted" style={{ fontSize: 11 }}>Статус</span>
          <input
            type="text"
            value={draft.status}
            disabled={disabled}
            onChange={(e) => onChange("status", e.target.value)}
            style={{ width: "100%" }}
          />
        </label>
      </div>
      <label className="stack" style={{ gap: 4 }}>
        <span className="muted" style={{ fontSize: 11 }}>Описание</span>
        <textarea
          rows={5}
          value={draft.summary}
          disabled={disabled}
          onChange={(e) => onChange("summary", e.target.value)}
          style={{ width: "100%" }}
        />
      </label>
      <label className="stack" style={{ gap: 4, maxWidth: 180 }}>
        <span className="muted" style={{ fontSize: 11 }}>Уверенность</span>
        <input
          type="number"
          min="0"
          max="1"
          step="0.01"
          value={draft.confidence}
          disabled={disabled}
          onChange={(e) => onChange("confidence", e.target.value)}
          style={{ width: "100%" }}
        />
      </label>
      <div className="row" style={{ justifyContent: "flex-end", flexWrap: "wrap" }}>
        <button className="secondary" disabled={disabled} onClick={onCancel}>
          Отмена
        </button>
        <button disabled={disabled} onClick={onSave}>
          Сохранить
        </button>
      </div>
    </div>
  );
}

function CharacterMergePanel({
  candidates,
  selectedId,
  disabled,
  onSelect,
  onMergeIntoCurrent,
  onMergeCurrentIntoTarget,
}: {
  candidates: CharacterCard[];
  selectedId: string;
  disabled: boolean;
  onSelect: (id: string) => void;
  onMergeIntoCurrent: () => void;
  onMergeCurrentIntoTarget: () => void;
}) {
  if (candidates.length === 0) return null;
  return (
    <div className="card stack">
      <strong>Слияние</strong>
      <select
        className="bookrag-select"
        value={selectedId}
        disabled={disabled}
        onChange={(e) => onSelect(e.target.value)}
      >
        {candidates.map((candidate) => (
          <option key={candidate.id} value={candidate.id}>
            {candidate.name}
          </option>
        ))}
      </select>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <button disabled={disabled || !selectedId} onClick={onMergeIntoCurrent}>
          Слить выбранного в текущего
        </button>
        <button
          className="secondary"
          disabled={disabled || !selectedId}
          onClick={onMergeCurrentIntoTarget}
        >
          Слить текущего в выбранного
        </button>
      </div>
    </div>
  );
}

// ---------------- Other tabs ----------------

function ChaptersTab({ workId, reloadKey }: { workId: string; reloadKey: number }) {
  const [items, setItems] = useState<Chapter[]>([]);
  useEffect(() => {
    void call("kb/listChapters", { workId })
      .then((list) => setItems(list.sort((a, b) => a.number - b.number)))
      .catch(() => setItems([]));
  }, [workId, reloadKey]);
  if (items.length === 0) return <p className="muted">Глав пока нет.</p>;
  return (
    <ul className="list">
      {items.map((c) => (
        <li key={c.id} style={{ cursor: "default" }}>
          <strong>Глава {c.number || "?"}</strong> · {c.title}
        </li>
      ))}
    </ul>
  );
}

function LocationsTab({ workId, reloadKey }: { workId: string; reloadKey: number }) {
  const [items, setItems] = useState<Location[]>([]);
  const [arts, setArts] = useState<Artifact[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // v4: сортировка обоих списков по appearanceCount DESC, затем имя ASC.
  const byAppearances = <T extends { appearanceCount: number; name: string }>(list: T[]): T[] =>
    [...list].sort(
      (a, b) =>
        b.appearanceCount - a.appearanceCount || a.name.localeCompare(b.name, "ru"),
    );

  useEffect(() => {
    setError(null);
    void call("kb/listLocations", { workId })
      .then((list) => setItems(byAppearances(list)))
      .catch(() => setItems([]));
    void call("kb/listArtifacts", { workId })
      .then((list) => setArts(byAppearances(list)))
      .catch(() => setArts([]));
  }, [workId, reloadKey]);

  const removeLocation = async (id: string, name: string) => {
    if (!window.confirm(`Удалить локацию «${name}»?`)) return;
    setBusy(id);
    setError(null);
    try {
      await call("kb/deleteLocation", { workId, locationId: id });
      // reloadKey подъедет через broadcast/kbChanged.
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const removeArtifact = async (id: string, name: string) => {
    if (!window.confirm(`Удалить артефакт «${name}»?`)) return;
    setBusy(id);
    setError(null);
    try {
      await call("kb/deleteArtifact", { workId, artifactId: id });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="stack">
      {error && <div className="error">{error}</div>}
      <strong>Локации ({items.length})</strong>
      {items.length === 0 ? (
        <p className="muted">Пусто.</p>
      ) : (
        <ul className="list">
          {items.map((l) => (
            <li key={l.id} style={{ cursor: "default" }}>
              <div
                className="row"
                style={{ alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}
              >
                <div style={{ minWidth: 0, flex: "1 1 auto" }}>
                  <strong>{l.name}</strong>
                  <div className="muted" style={{ fontSize: 11 }}>
                    {l.appearanceCount}× · последняя гл. {l.lastUpdatedChapter}
                  </div>
                  {l.summary && (
                    <div className="muted" style={{ fontSize: 11 }}>{l.summary}</div>
                  )}
                </div>
                <button
                  className="secondary danger-button compact-button"
                  disabled={busy === l.id}
                  onClick={() => removeLocation(l.id, l.name)}
                >
                  Удалить
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <strong>Артефакты ({arts.length})</strong>
      {arts.length === 0 ? (
        <p className="muted">Пусто.</p>
      ) : (
        <ul className="list">
          {arts.map((a) => (
            <li key={a.id} style={{ cursor: "default" }}>
              <div
                className="row"
                style={{ alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}
              >
                <div style={{ minWidth: 0, flex: "1 1 auto" }}>
                  <strong>{a.name}</strong>
                  <div className="muted" style={{ fontSize: 11 }}>
                    {a.appearanceCount}× · последняя гл. {a.lastUpdatedChapter}
                  </div>
                  {a.summary && (
                    <div className="muted" style={{ fontSize: 11 }}>{a.summary}</div>
                  )}
                </div>
                <button
                  className="secondary danger-button compact-button"
                  disabled={busy === a.id}
                  onClick={() => removeArtifact(a.id, a.name)}
                >
                  Удалить
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// FTv6: вместо EventsTab + RelationshipsTab — одна вкладка с chapter_summary
// на главу. Модель пишет recap главы (3-6 предложений) + список присутствующих
// персонажей и одностраничные key_events_oneline.
function ChapterSummariesTab({ workId, reloadKey }: { workId: string; reloadKey: number }) {
  const [items, setItems] = useState<ChapterSummary[]>([]);
  const [chars, setChars] = useState<CharacterCard[]>([]);
  const [locs, setLocs] = useState<Location[]>([]);
  useEffect(() => {
    void Promise.all([
      call("kb/listChapterSummaries", { workId }),
      call("kb/listCharacters", { workId }),
      call("kb/listLocations", { workId }),
    ])
      .then(([summaries, c, l]) => {
        setItems(summaries);
        setChars(c);
        setLocs(l);
      })
      .catch(() => {
        setItems([]);
        setChars([]);
        setLocs([]);
      });
  }, [workId, reloadKey]);
  const charNames = useMemo(() => new Map(chars.map((c) => [c.id, c.name])), [chars]);
  const locNames = useMemo(() => new Map(locs.map((l) => [l.id, l.name])), [locs]);
  if (items.length === 0) return <p className="muted">Резюме глав пока нет.</p>;
  return (
    <ul className="list">
      {items.map((s) => (
        <li key={s.id} style={{ cursor: "default" }}>
          <div>
            <strong>Глава {s.chapterNumber}</strong>
          </div>
          <p style={{ margin: "4px 0" }}>{s.summary}</p>
          {s.charactersPresent.length > 0 && (
            <div className="muted" style={{ fontSize: 11 }}>
              Персонажи:{" "}
              {s.charactersPresent.map((id) => charNames.get(id) ?? id).join(", ")}
            </div>
          )}
          {s.locationsPresent.length > 0 && (
            <div className="muted" style={{ fontSize: 11 }}>
              Локации:{" "}
              {s.locationsPresent.map((id) => locNames.get(id) ?? id).join(", ")}
            </div>
          )}
          {s.keyEventsOneline.length > 0 && (
            <ul style={{ margin: "4px 0 0 16px", padding: 0, fontSize: 12 }}>
              {s.keyEventsOneline.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

// ---------------- Reviews ----------------

function ReviewsTab({ workId, reloadKey }: { workId: string; reloadKey: number }) {
  const [items, setItems] = useState<CollisionReviewItem[]>([]);
  const [chars, setChars] = useState<CharacterCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [list, allChars] = await Promise.all([
        call("review/listPending", { workId }),
        call("kb/listCharacters", { workId }),
      ]);
      setItems(list);
      setChars(allChars);
    } catch (err) {
      const message = err instanceof MessagingError || err instanceof Error
        ? err.message
        : String(err);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [workId]);

  useEffect(() => {
    void reload();
  }, [reload, reloadKey]);

  const namesById = useMemo(() => new Map(chars.map((c) => [c.id, c])), [chars]);

  const resolve = useCallback(
    async (
      reviewId: string,
      decision: Exclude<ReviewStatus, "pending">,
      mergeIntoCandidate?: boolean,
    ) => {
      setBusy(reviewId);
      setError(null);
      try {
        await call("review/resolve", {
          reviewId,
          decision,
          ...(typeof mergeIntoCandidate === "boolean" ? { mergeIntoCandidate } : {}),
        });
        await reload();
      } catch (err) {
        const message = err instanceof MessagingError || err instanceof Error
          ? err.message
          : String(err);
        setError(message);
      } finally {
        setBusy(null);
      }
    },
    [reload],
  );

  if (loading) return <p className="muted">Загрузка...</p>;
  if (error) return <div className="error">{error}</div>;
  if (items.length === 0) return <p className="muted">Спорных совпадений нет.</p>;

  return (
    <div className="stack">
      {items.map((item) => {
        const left = namesById.get(item.newCharacterId);
        const right = namesById.get(item.candidateId);
        return (
          <div key={item.id} className="card stack">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span className="badge warn">score {item.score.toFixed(2)}</span>
              <span className="muted" style={{ fontSize: 11 }}>
                {new Date(item.createdAt).toLocaleString("ru-RU")}
              </span>
            </div>
            <div>
              Новый: <strong>{left?.name ?? "(удалён)"}</strong>
            </div>
            <div>
              Кандидат: <strong>{right?.name ?? "(удалён)"}</strong>
            </div>
            {item.features.length > 0 && (
              <div className="muted" style={{ fontSize: 11 }}>
                {item.features.join(", ")}
              </div>
            )}
            <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
              <button disabled={busy === item.id} onClick={() => resolve(item.id, "merged", true)}>
                Слить в кандидата
              </button>
              <button disabled={busy === item.id} onClick={() => resolve(item.id, "merged", false)}>
                Слить в нового
              </button>
              <button
                className="secondary"
                disabled={busy === item.id}
                onClick={() => resolve(item.id, "kept_separate")}
              >
                Оставить раздельно
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
