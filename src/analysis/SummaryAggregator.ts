// Склейка create_chapter_summary из нескольких чанков в одну операцию на главу.
// На входе: операции после Pass 1 (могут содержать несколько create_chapter_summary,
// по одной на чанк). На выходе: те же операции, но все create_chapter_summary
// схлопнуты в одну.
//
// Зачем: на длинной главе ChapterAnalyzer обходит чанки независимо. Каждый чанк
// возвращает свой recap, но KB должен видеть ОДНУ summary на главу
// (KnowledgeBase.applyOperations использует index by-work-chapter-number с
// unique=true для chapter_summaries). Альтернатива «последний перезаписывает»
// потеряла бы summary первых чанков; правильный путь — конкатенация + union
// participants + dedup key_events_oneline.

import type { CreateChapterSummaryOp, Operation } from "../kb/operations";
import { normalizeAlias } from "../lib/normalize";

// Лимит на длину агрегированного summary. Длиннее всё равно режется в UI;
// держим запас под 800 chars для «previously on…» в Pass 1 будущих глав.
const SUMMARY_SOFT_CAP = 800;
const SUMMARY_HARD_CAP = 1200;

export function aggregateChapterSummaries(ops: readonly Operation[]): Operation[] {
  const summaries: CreateChapterSummaryOp[] = [];
  const others: Operation[] = [];
  for (const op of ops) {
    if (op.kind === "create_chapter_summary") {
      summaries.push(op);
    } else {
      others.push(op);
    }
  }

  if (summaries.length === 0) return [...others];
  if (summaries.length === 1) return [...others, summaries[0]!];

  const merged = mergeSummaries(summaries);
  return [...others, merged];
}

function mergeSummaries(parts: readonly CreateChapterSummaryOp[]): CreateChapterSummaryOp {
  // Текст: конкат через перевод строки + soft cap. Если общее превышает hard cap —
  // оставляем первые SUMMARY_SOFT_CAP chars + многоточие. Это сохраняет начало
  // главы (где обычно главный сюжетный двигатель) и не валит UI на огромных входах.
  const joined = parts.map((p) => p.summary.trim()).filter((s) => s !== "").join("\n\n");
  const summary =
    joined.length <= SUMMARY_HARD_CAP
      ? joined
      : joined.slice(0, SUMMARY_SOFT_CAP).replace(/\s+\S*$/, "") + "…";

  const charactersPresent = unionRefs(parts.map((p) => p.charactersPresent));
  const locationsPresent = unionRefs(parts.map((p) => p.locationsPresent));
  const artifactsMentioned = unionRefs(parts.map((p) => p.artifactsMentioned));
  const keyEventsOneline = dedupeKeyEvents(parts.flatMap((p) => p.keyEventsOneline));

  // Confidence — среднее. Evidence — первый непустой (он обычно описывает
  // главный эпизод главы). Если первый пуст, ищем следующий.
  const evidence = parts.find((p) => p.evidence.trim() !== "")?.evidence ?? parts[0]!.evidence;
  const confidence =
    parts.reduce((sum, p) => sum + p.confidence, 0) / parts.length;

  return {
    kind: "create_chapter_summary",
    summary,
    charactersPresent,
    locationsPresent,
    artifactsMentioned,
    keyEventsOneline,
    evidence,
    confidence,
  };
}

function unionRefs(lists: ReadonlyArray<readonly string[]>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const ref of list) {
      if (!ref || seen.has(ref)) continue;
      seen.add(ref);
      out.push(ref);
    }
  }
  return out;
}

function dedupeKeyEvents(events: readonly string[]): string[] {
  // Дедуп по normalized тексту — модель может писать «встреча с князем» и
  // «Встреча с князем Волковым» в разных чанках, оставляем первый вариант.
  // normalizeAlias уже делает lowercase + strip punctuation, для коротких
  // bullet'ов этого достаточно.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ev of events) {
    const trimmed = ev.trim();
    if (!trimmed) continue;
    const key = normalizeAlias(trimmed);
    if (key.length < 2) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}
