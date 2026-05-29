import { Readability } from "@mozilla/readability";
import {
  extractParagraphs,
  getCanonicalUrl,
  getMeta,
  joinParagraphs,
  normalizeInline,
  pickChapterNumber,
} from "../extract";
import type { ParsedChapter, SiteAdapter } from "../types";

// Универсальный fallback. Используется только если специфичные адаптеры не сработали.
export class GenericReadabilityAdapter implements SiteAdapter {
  readonly id = "generic-readability";
  readonly priority = 0;

  matches(): boolean {
    return true;
  }

  parse(doc: Document, url: URL): ParsedChapter | null {
    let article: ReturnType<Readability["parse"]> | null = null;
    try {
      const docClone = doc.cloneNode(true) as Document;
      article = new Readability(docClone).parse();
    } catch (err) {
      console.warn("[BookRAG] Readability failed:", err);
      return null;
    }
    if (!article) return null;

    // Readability возвращает HTML — превращаем в DOM, чтобы переиспользовать extractParagraphs.
    const tmp = doc.implementation.createHTMLDocument("");
    tmp.body.innerHTML = article.content ?? "";
    const paragraphs = extractParagraphs(tmp.body);
    if (paragraphs.length === 0 && article.textContent) {
      const fallback = article.textContent
        .split(/\n\s*\n+/)
        .map((s) => normalizeInline(s))
        .filter((s) => s.length > 0);
      if (fallback.length === 0) return null;
      paragraphs.push(...fallback);
    }
    if (paragraphs.length === 0) return null;

    const chapterTitle = normalizeInline(article.title ?? doc.title);
    const workTitle =
      normalizeInline(article.siteName ?? "") ||
      normalizeInline(getMeta(doc, "og:site_name") ?? "") ||
      url.hostname;

    return {
      adapterId: this.id,
      workTitle,
      workSiteUrl: getCanonicalUrl(doc, `${url.origin}${url.pathname}`),
      chapterTitle,
      chapterNumber: pickChapterNumber({ url, title: chapterTitle }),
      chapterUrl: url.toString(),
      text: joinParagraphs(paragraphs),
      paragraphs,
    };
  }
}
