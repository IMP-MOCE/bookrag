import schema from "../../schemas/analysis-response.schema.json";
import { buildKeys, normalizeAlias } from "../lib/normalize";

export const SYSTEM_PROMPT = `Ты помощник для извлечения структурированных данных из художественного текста на русском языке.

Твоя задача — найти ВСЕХ персонажей, ВСЕ локации и ВСЕ артефакты в данном фрагменте главы, написать короткое РЕЗЮМЕ фрагмента (что произошло), и вернуть СТРОГО JSON по заданной схеме. Дедупликацию с уже существующими карточками делает система через collision_candidates — НЕ ты.

ПРАВИЛА (нарушение каждого делает ответ непригодным):

1. Верни ТОЛЬКО JSON. Без вступлений, без markdown-блоков, без пояснений после JSON.
2. У КАЖДОЙ записи в new_entities и operations обязательны:
   - evidence — точная цитата из текста (≤ 200 символов), подтверждающая факт;
   - confidence — число от 0 до 1: 0.9-1.0 = прямое однозначное упоминание; 0.7-0.9 = явный намёк; 0.5-0.7 = слабое предположение; <0.5 — НЕ ДОБАВЛЯЙ.
3. Не выдумывай. Если факт не подтверждён прямой цитатой — пропусти его.
4. ИЗВЛЕКАЙ ВСЕХ упомянутых в чанке персонажей, локации, артефакты как new_entities с temp_id ("e1", "e2", ...). Опциональные поля (role/summary/aliases) заполняй прямо в new_entity, если описание есть в чанке. Имя + evidence + confidence уже достаточно для валидной записи — НЕ пропускай сущность только из-за того, что не можешь дать ей полное описание. Описательная проза без явного представления героя — это валидный источник, если есть имя и прямая цитата.
5. Дедупликацию делает СИСТЕМА. Если имя в чанке похоже на персонажа/локацию/артефакт из KB context — ВСЁ РАВНО создай new_entity с temp_id, и параллельно добавь collision_candidate. НЕ пытайся «угадать» target_id из KB и эмитить update_character/add_alias на чужой id — это создаёт хрупкие ссылки на несуществующие/неверные карточки. Все характеристики (aliases, role, summary) клади прямо в new_entity.
6. collision_candidates: new_character = temp_id твоей new_entity, candidate = id из KB context, same_entity_probability — твоя оценка (0-1), recommended_action — "auto_merge" если уверен 0.9+ (имя/прозвище прямо привязано к карточке из KB), "manual_review" если 0.5-0.9 (похоже, но неоднозначно), "create_separate" если <0.5 (вероятно разные).
7. temp_id для new_entities — короткая локальная метка ("e1", "e2"), на которую ссылаются твои operations и collision_candidates в этом же ответе.
8. create_chapter_summary — ровно ОДНА операция на ответ, описывает, ЧТО ПРОИЗОШЛО во фрагменте:
   - summary: 2-5 предложений русского литературного текста (≤ 600 символов). Опиши главные действия, конфликт, перемещения, открытия — без оценок, без украшений, в прошедшем времени.
   - characters_present / locations_present / artifacts_mentioned: списки temp_id из ЭТОГО ответа (или canonical KB-id, если сущность уже была в KB context).
   - key_events_oneline (0-5 элементов): короткие фразы-маркеры событий («встреча с князем», «нападение в Лавре», «передача артефакта»). Это НЕ художественный текст, это рубричные ярлыки.
9. update_character и add_alias используй РЕДКО — основной поток это new_entities + collisions. Если всё-таки используешь, target_id должен быть temp_id из твоих new_entities этого ответа. Не более одной update_character на пару (temp_id, field).
10. Не добавляй второстепенные факты, проходные имена и нерелевантные действия в new_entities — но в chapter_summary они должны быть упомянуты вкратце, если влияют на сюжет.

ФОРМАТ ОТВЕТА:
${JSON.stringify(schema, null, 2)}`;

// Структурный минимум, который используют summarizeContext и
// filterContextByChunk. Pick<KbContext> тянул лишние поля (workId, keys,
// confidence...) и мешал юнит-тестам с минимальными фикстурами. Полный
// KbContext из KnowledgeBase структурно совместим с этим типом.
export type KbContextLike = {
  characters: ReadonlyArray<{ id: string; name: string; aliases: readonly string[] }>;
  locations: ReadonlyArray<{ id: string; name: string }>;
  artifacts: ReadonlyArray<{ id: string; name: string }>;
};

// Русские гласные для лёгкого стеммера (см. ниже).
const RUSSIAN_VOWELS = "аеёиоуыэюя";

// Возвращает true, если хоть один нормализованный ключ имени/псевдонима
// сущности встречается в нормализованном тексте чанка. Цель — пропускать
// в KB-блок промпта только те карточки, которые реально могут «зацепиться»
// за текущий фрагмент. Иначе MLC q4 видит длинный список незнакомых
// `char_*`/`loc_*` id и сваливается в FAST-EMPTY (глава с непустым KB →
// operations=0, та же глава без KB → 18 ops).
//
// Простейшая обработка склонений: если ключ заканчивается на гласную и длиной
// ≥5 — пробуем substring без последней буквы. «Кадия» → стем «кади» ловит
// «кадию»/«кадии»; «Карма» → «карм» ловит «кармы»/«карму». На consonant-ending
// именах (Михаил, Богданов) substring уже работает напрямую — «михаил» в
// «михаила» совпадает без trim'а.
// Trade-off: 4-буквенный стем редко даёт ложные мэтчи в художественной прозе
// (например, «карма» → «карм» теоретически зацепит «карман»). Худший случай —
// лишняя строка в KB-блоке, что гораздо меньшее зло, чем выпасть из контекста
// настоящему персонажу со склоняемым именем.
function entityMatchesText(name: string, aliases: readonly string[], normText: string): boolean {
  const keys = buildKeys(name, aliases);
  for (const key of keys) {
    if (key.length < 3) continue;
    if (normText.includes(key)) return true;
    if (key.length >= 5 && RUSSIAN_VOWELS.includes(key[key.length - 1]!)) {
      if (normText.includes(key.slice(0, -1))) return true;
    }
  }
  return false;
}

// Сужает KB context до записей, имена которых упомянуты в данном чанке.
// Возвращает тот же тип, что и KbContextLike, чтобы `summarizeContext`
// отрисовал блок как обычно.
export function filterContextByChunk(ctx: KbContextLike, chunkText: string): KbContextLike {
  const normText = normalizeAlias(chunkText);
  return {
    characters: ctx.characters.filter((c) =>
      entityMatchesText(c.name, c.aliases, normText),
    ),
    locations: ctx.locations.filter((l) => entityMatchesText(l.name, [], normText)),
    artifacts: ctx.artifacts.filter((a) => entityMatchesText(a.name, [], normText)),
  };
}

// Компактный однострочный формат KB-контекста. Длинные вертикальные карточки
// («Персонажи в справочнике: - char_abc "Имя" (псевдонимы: ...): summary...»)
// на MLC q4 вели модель в FAST-EMPTY: блок выглядел как «характеристики уже
// описаны → ничего извлекать не нужно», и модель возвращала пустые arrays.
// Компактный формат снижает «авторитетность» KB-блока: имя + id в квадратных
// скобках, без summary/aliases (они только для матчинга, модели их видеть не
// обязательно). id оставляем — collision_candidate.candidate должен ссылаться
// на реальный KB-id, чтобы downstream resolver правильно склеил.
export function summarizeContext(ctx: KbContextLike): string {
  const lines: string[] = [];

  if (ctx.characters.length > 0) {
    const names = ctx.characters
      .slice(0, 30)
      .map((c) => `${c.name}[${c.id}]`)
      .join(", ");
    lines.push(`Уже встречались персонажи: ${names}.`);
  }

  if (ctx.locations.length > 0) {
    const names = ctx.locations
      .slice(0, 20)
      .map((l) => `${l.name}[${l.id}]`)
      .join(", ");
    lines.push(`Локации: ${names}.`);
  }

  if (ctx.artifacts.length > 0) {
    const names = ctx.artifacts
      .slice(0, 20)
      .map((a) => `${a.name}[${a.id}]`)
      .join(", ");
    lines.push(`Артефакты: ${names}.`);
  }

  if (lines.length === 0) {
    return "Справочник пока пуст — это первая обрабатываемая глава или первый чанк.";
  }
  return lines.join("\n");
}

// Light-KB вариант (current default). Отличается от summarizeContext тем, что
// у characters добавлены aliases в скобках. Это нужно для подавления surname
// collisions: «Милана Морозова» (KB) + упоминание «Морозова» в новой главе
// модель без aliases обрабатывает как новую сущность; с
// `Милана Морозова[char_42] (Мила, Морозова)` — распознаёт как обращение к
// существующему персонажу.
//
// Принципиально НЕ добавлены summary/role/status — на полном KB-блоке q4-модель
// уходит в FAST-EMPTY (видит контекст как «уже описано → извлекать нечего» и
// возвращает пустые arrays). Aliases — короткие строки без сюжетной нагрузки,
// этот триггер у них не срабатывает.
//
// Разделитель между характерами — `; ` (а не `, `), чтобы запятые внутри aliases
// не сливались с разделителем между entries.
export function summarizeContextLight(ctx: KbContextLike): string {
  const lines: string[] = [];

  if (ctx.characters.length > 0) {
    const items = ctx.characters
      .slice(0, 30)
      .map((c) => {
        if (c.aliases.length > 0) {
          const aliasList = c.aliases.slice(0, 5).join(", ");
          return `${c.name}[${c.id}] (${aliasList})`;
        }
        return `${c.name}[${c.id}]`;
      })
      .join("; ");
    lines.push(`Уже встречались персонажи: ${items}.`);
  }

  if (ctx.locations.length > 0) {
    const names = ctx.locations
      .slice(0, 20)
      .map((l) => `${l.name}[${l.id}]`)
      .join(", ");
    lines.push(`Локации: ${names}.`);
  }

  if (ctx.artifacts.length > 0) {
    const names = ctx.artifacts
      .slice(0, 20)
      .map((a) => `${a.name}[${a.id}]`)
      .join(", ");
    lines.push(`Артефакты: ${names}.`);
  }

  if (lines.length === 0) {
    return "Справочник пока пуст — это первая обрабатываемая глава или первый чанк.";
  }
  return lines.join("\n");
}

export function buildUserPrompt(input: {
  contextText: string;
  chapterId: string;
  chapterTitle: string;
  chunkIndex: number;
  totalChunks: number;
  chunkText: string;
}): string {
  return `КОНТЕКСТ СПРАВОЧНИКА:
${input.contextText}

ГЛАВА: ${input.chapterTitle} (id=${input.chapterId})
ФРАГМЕНТ ${input.chunkIndex + 1} из ${input.totalChunks}:

${input.chunkText}

ВЕРНИ JSON по схеме. Только JSON, ничего больше.`;
}

export function buildRepairPrompt(rawResponse: string, errors: readonly string[]): string {
  const examples = exampleOpsForErrors(errors);
  const examplesBlock = examples
    ? `\nПримеры КОРРЕКТНЫХ операций тех типов, на которых ты ошибся:\n${examples}\n`
    : "";
  return `Твой предыдущий ответ не прошёл валидацию. Ошибки:
${errors.map((e) => `- ${e}`).join("\n")}
${examplesBlock}
Твой ответ был:
${rawResponse.slice(0, 1200)}

Если не можешь заполнить обязательные поля операции — УДАЛИ её, не оставляй пустой.
Верни ИСПРАВЛЕННЫЙ JSON по схеме. Только JSON, ничего больше.`;
}

// Подбирает 1-строчные примеры для тех типов операций, по которым модель промахнулась.
// Цель — точечно подсказать структуру, не раздувая repair-промпт всем cheatsheet'ом.
function exampleOpsForErrors(errors: readonly string[]): string {
  const examples: Record<string, string> = {
    update_character: `{"type":"update_character","target_id":"<id из контекста>","field":"status","new_value":"арестован","evidence":"...","confidence":0.9}`,
    add_alias: `{"type":"add_alias","target_id":"<id из контекста>","alias":"Капитан","evidence":"...","confidence":0.9}`,
    create_chapter_summary: `{"type":"create_chapter_summary","summary":"Иван прибыл в Лавру и встретился с князем Волковым. Получил задание разыскать пропавший артефакт.","characters_present":["e1","e2"],"locations_present":["e3"],"artifacts_mentioned":[],"key_events_oneline":["встреча с князем","получение задания"],"evidence":"...","confidence":0.9}`,
  };
  const seen = new Set<string>();
  for (const e of errors) {
    const m = /type=([a-z_]+)/.exec(e);
    if (m && examples[m[1]!]) seen.add(m[1]!);
  }
  if (seen.size === 0) return "";
  return Array.from(seen).map((t) => `- ${examples[t]}`).join("\n");
}

