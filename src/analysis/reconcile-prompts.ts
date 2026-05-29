// Промпты для Pass 2 (KbReconciler). Намеренно ОТДЕЛЕНЫ от prompts.ts:
// extraction-промпт содержит правила вида «извлекай ВСЕХ», которые на этапе
// сверки бессмысленны. Отдельный модуль гарантирует, что bias, выученный
// во время SFT, не сработает в reconciliation-фазе.

import schema from "../../schemas/reconcile-response.schema.json";

// Лимит кандидатов на одну сущность. Больше — перегружает prompt и теряет
// фокус; меньше — рискуем не показать настоящий матч.
export const MAX_CANDIDATES_PER_DRAFT = 5;

export const RECONCILE_SYSTEM_PROMPT = `Ты сверяешь свежеизвлечённые сущности с уже известными карточками справочника.

Для КАЖДОЙ временной сущности (с temp_id из NEW ENTITIES ниже) реши одно из:
  - "match" — это уже существующая карточка из KB CANDIDATES (укажи candidate_id)
  - "new" — это действительно новая сущность, ничего из KB не подходит

Дополнительно, если decision="match" И в чанке есть фактически новая информация о персонаже
(не дубль того, что уже в его карточке), верни transferable_facts с обновлёнными полями
(summary/role/status). Если новых фактов нет — поле transferable_facts опусти.

ВАЖНО:
- temp_id и kind должны совпадать с тем, что было в NEW ENTITIES (не выдумывай новые).
- candidate_id обязателен ТОЛЬКО при decision="match" — берётся из списка KB CANDIDATES
  ровно как там написан (например "char_abc123"), без префиксов/изменений.
- probability — твоя оценка уверенности: 0.95+ для очевидного совпадения; 0.7-0.9 для похожих,
  но не точных; <0.5 склоняйся к "new".
- transferable_facts применяется только к characters.

ФОРМАТ ОТВЕТА:
${JSON.stringify(schema, null, 2)}`;

export interface ReconcileDraft {
  tempId: string;
  kind: "character" | "location" | "artifact";
  name: string;
  aliases: readonly string[];
  evidence: string;
}

export interface ReconcileCandidate {
  id: string;
  name: string;
  // Для characters: aliases для подсказки. Для loc/art: пусто.
  aliases: readonly string[];
}

// Строит user prompt в формате, который не пересекается со словарём
// extraction-промпта (никаких «Персонажи в справочнике», «уже встречались» —
// каждый из этих фраз триггерил bias).
export function buildReconcileUserPrompt(
  drafts: readonly ReconcileDraft[],
  candidatesByDraft: ReadonlyMap<string, readonly ReconcileCandidate[]>,
): string {
  const draftLines = drafts.map((d) => {
    const aliasPart = d.aliases.length > 0 ? ` (aliases: ${d.aliases.slice(0, 4).join(", ")})` : "";
    const evidenceClip = d.evidence.length > 120 ? d.evidence.slice(0, 119) + "…" : d.evidence;
    return `- ${d.tempId} ${d.kind} "${escapeQuotes(d.name)}"${aliasPart} — "${escapeQuotes(evidenceClip)}"`;
  });

  const candLines = drafts.map((d) => {
    const cands = candidatesByDraft.get(d.tempId) ?? [];
    if (cands.length === 0) {
      return `- ${d.tempId}: (нет кандидатов — почти наверняка new)`;
    }
    const formatted = cands.slice(0, MAX_CANDIDATES_PER_DRAFT).map((c) => {
      const al = c.aliases.length > 0 ? ` (${c.aliases.slice(0, 3).join(", ")})` : "";
      return `${c.id} "${escapeQuotes(c.name)}"${al}`;
    });
    return `- ${d.tempId}: ${formatted.join("; ")}`;
  });

  return (
    `NEW ENTITIES:\n${draftLines.join("\n")}\n\n` +
    `KB CANDIDATES:\n${candLines.join("\n")}\n\n` +
    `Верни JSON по схеме. Только JSON, ничего больше.`
  );
}

// Двойные кавычки и переводы строк могут сломать JSON-парсинг ответа модели,
// если она цитирует evidence/name дословно. Экранируем обе формы.
function escapeQuotes(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
}

// Repair prompt для Pass 2. Зеркало `buildRepairPrompt` из prompts.ts, но без
// извлекательных подсказок (они актуальны только для Pass 1). Цель — указать
// модели, что её предыдущий ответ не прошёл validate-reconcile.js, и попросить
// вернуть ИСПРАВЛЕННЫЙ JSON. Без этого reconcile уходит в hard-fail
// (см. KbReconciler.ReconcileFailedError), а это блокирует apply главы → данные
// не пишутся в KB. Поэтому repair — обязательный шаг, а не «nice to have».
export function buildReconcileRepairPrompt(
  rawResponse: string,
  errors: readonly string[],
): string {
  return `Твой предыдущий ответ не прошёл валидацию reconcile-схемы. Ошибки:
${errors.map((e) => `- ${e}`).join("\n")}

Напоминание о структуре:
- {"decisions": [{"temp_id":"...","kind":"character|location|artifact","decision":"match|new","probability":0.0-1.0, ...}]}
- temp_id и kind должны совпадать с теми, что были в NEW ENTITIES (не выдумывай новые).
- candidate_id обязателен ТОЛЬКО при decision="match" и должен дословно совпадать с одним из id в KB CANDIDATES.
- transferable_facts — только для characters и только при decision="match", и только если в evidence есть РЕАЛЬНО новый факт.

Твой предыдущий ответ был:
${rawResponse.slice(0, 1200)}

Верни ИСПРАВЛЕННЫЙ JSON по схеме. Только JSON, ничего больше.`;
}
