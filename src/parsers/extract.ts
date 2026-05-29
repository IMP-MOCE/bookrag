// Утилиты, общие для всех адаптеров парсеров.

const ZERO_WIDTH = /[​-‏﻿‪-‮]/g;

// Нормализует пробелы внутри одной строки (без агрессивного схлопывания переносов).
export function normalizeInline(text: string): string {
  return text.replace(ZERO_WIDTH, "").replace(/[ \t]+/g, " ").trim();
}

// Извлекает параграфы из контейнера: предпочитаем теги <p>, иначе фолбэк по <br>/двойным переносам.
export function extractParagraphs(root: Element | null | undefined): string[] {
  if (!root) return [];

  // Удалить служебные блоки, которые типично попадают в reader-контейнеры.
  const NOISE_SELECTORS = [
    "script",
    "style",
    "noscript",
    "iframe",
    ".ads",
    ".advertisement",
    "[data-ad]",
    ".author-comment",
    ".reader-comment",
  ];
  const cleaned = root.cloneNode(true) as Element;
  for (const sel of NOISE_SELECTORS) {
    cleaned.querySelectorAll(sel).forEach((n) => n.remove());
  }

  const paraNodes = cleaned.querySelectorAll("p, blockquote, li, h2, h3, h4");
  const out: string[] = [];

  if (paraNodes.length > 0) {
    for (const node of paraNodes) {
      const text = normalizeInline(node.textContent ?? "");
      if (text.length > 0) out.push(text);
    }
  } else {
    // Фолбэк: разбиваем по <br><br> или двойным переносам в textContent.
    const html = cleaned.innerHTML.replace(/<br\s*\/?>(\s*<br\s*\/?>)+/gi, "\n\n");
    const tmp = cleaned.ownerDocument.createElement("div");
    tmp.innerHTML = html;
    const text = tmp.textContent ?? "";
    for (const chunk of text.split(/\n\s*\n+/)) {
      const normalized = normalizeInline(chunk);
      if (normalized.length > 0) out.push(normalized);
    }
  }

  return out;
}

export function joinParagraphs(paragraphs: readonly string[]): string {
  return paragraphs.join("\n\n");
}

// Эвристики извлечения номера главы.

const URL_NUMBER_PATTERNS: readonly RegExp[] = [
  /\/chapter[\/_-](\d+)/i,
  /\/глава[\/_-](\d+)/i,
  /\/part[\/_-](\d+)/i,
  /\/(\d+)\/?$/,
];

export function chapterNumberFromUrl(url: URL): number | null {
  for (const re of URL_NUMBER_PATTERNS) {
    const m = url.pathname.match(re);
    if (m && m[1]) return Number.parseInt(m[1], 10);
  }
  return null;
}

const TITLE_NUMBER_PATTERNS: readonly RegExp[] = [
  /(?:глава|часть|chapter|part|episode|book)\s*[№#]?\s*(\d+)/i,
  /^\s*(\d+)\s*[.:\-—]/,
  /^\s*(\d+)\b/,
];

export function chapterNumberFromTitle(title: string): number | null {
  for (const re of TITLE_NUMBER_PATTERNS) {
    const m = title.match(re);
    if (m && m[1]) return Number.parseInt(m[1], 10);
  }
  return null;
}

export function pickChapterNumber(opts: {
  url: URL;
  title: string;
  fallback?: number;
}): number {
  // Заголовок ("Глава 12 / Chapter 7 / Часть 3") предпочтительнее URL —
  // в URL у большинства платформ лежит opaque chapter id, а не порядковый номер.
  return (
    chapterNumberFromTitle(opts.title) ??
    chapterNumberFromUrl(opts.url) ??
    opts.fallback ??
    0
  );
}

// Безопасное чтение мета-тега.
export function getMeta(doc: Document, name: string): string | null {
  const byName = doc.querySelector(`meta[name="${name}"]`)?.getAttribute("content");
  const byProperty = doc.querySelector(`meta[property="${name}"]`)?.getAttribute("content");
  return byName ?? byProperty ?? null;
}

export function getCanonicalUrl(doc: Document, fallback: string): string {
  const link = doc.querySelector('link[rel="canonical"]')?.getAttribute("href");
  return link ?? fallback;
}
