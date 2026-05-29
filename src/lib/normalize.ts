// Нормализация имён и ключей для индексации и базового сопоставления.
// Расширенное сравнение (Левенштейн, склонения) живёт в CollisionResolver (Фаза 5).
import { similarity } from "./levenshtein";

const RUSSIAN_TITLES = [
  "князь",
  "княгиня",
  "граф",
  "графиня",
  "барон",
  "баронесса",
  "лорд",
  "леди",
  "сэр",
  "мадам",
  "мисс",
  "мистер",
  "господин",
  "госпожа",
  "товарищ",
  "капитан",
  "майор",
  "полковник",
  "генерал",
];

export function normalizeAlias(input: string): string {
  return input
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

// \b в JS не работает с кириллицей, поэтому фильтруем токены по точному совпадению.
const TITLES_SET = new Set(RUSSIAN_TITLES);

export function stripTitles(normalized: string): string {
  return normalized
    .split(/\s+/)
    .filter((token) => token.length > 0 && !TITLES_SET.has(token))
    .join(" ");
}

// Все варианты ключей для одной сущности: само имя + псевдонимы,
// нормализованные и без титулов, плюс отдельные токены ≥ 4 символов
// (для матчинга по фамилии или имени-без-фамилии). Используется для multiEntry-индекса.
export function buildKeys(name: string, aliases: readonly string[]): string[] {
  const all = new Set<string>();
  for (const raw of [name, ...aliases]) {
    const norm = normalizeAlias(raw);
    if (norm.length > 1) all.add(norm);
    const stripped = stripTitles(norm);
    if (stripped.length > 1 && stripped !== norm) all.add(stripped);
    for (const token of stripped.split(/\s+/)) {
      if (token.length >= 4) all.add(token);
    }
  }
  return Array.from(all);
}

export function isRedundantAliasForName(
  name: string,
  existingAliases: readonly string[],
  alias: string,
  threshold = 0.95,
): boolean {
  const normalized = normalizeAlias(alias);
  if (!normalized) return true;

  const stripped = stripTitles(normalized);
  const aliasForms = Array.from(
    new Set([normalized, stripped].filter((x) => x.length > 1)),
  );
  const keys = buildKeys(name, existingAliases);

  for (const form of aliasForms) {
    if (keys.includes(form)) return true;
    if (keys.some((key) => key.length >= 4 && form.length >= 4 && similarity(form, key) >= threshold)) {
      return true;
    }
  }
  return false;
}
