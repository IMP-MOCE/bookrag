import {
  extractParagraphs,
  joinParagraphs,
  normalizeInline,
  pickChapterNumber,
} from "../extract";
import type { ParsedChapter, SiteAdapter } from "../types";

// URL вида:
//   https://author.today/reader/<workId>
//   https://author.today/reader/<workId>/chapter/<chapterId>
const WORK_ID_RE = /\/reader\/(\d+)/;

export class AuthorTodayAdapter implements SiteAdapter {
  readonly id = "author-today";
  readonly priority = 100;

  matches(url: URL): boolean {
    return (
      (url.hostname === "author.today" || url.hostname.endsWith(".author.today")) &&
      url.pathname.includes("/reader/")
    );
  }

  chapterRoot(doc: Document): Element | null {
    return (
      doc.querySelector("#text-container .reader-text") ??
      doc.querySelector(".reader-text") ??
      doc.querySelector("#text-container")
    );
  }

  parse(doc: Document, url: URL): ParsedChapter | null {
    const root = this.chapterRoot(doc);
    if (!root) return null;

    const paragraphs = extractParagraphs(root);
    if (paragraphs.length === 0) return null;

    const workTitle = this.findWorkTitle(doc);
    const chapterTitle = this.findChapterTitle(doc);
    const workId = url.pathname.match(WORK_ID_RE)?.[1];
    const workSiteUrl = workId
      ? `${url.origin}/work/${workId}`
      : `${url.origin}${url.pathname}`;

    const result: ParsedChapter = {
      adapterId: this.id,
      workTitle,
      workSiteUrl,
      chapterTitle,
      chapterNumber: pickChapterNumber({ url, title: chapterTitle }),
      chapterUrl: url.toString(),
      text: joinParagraphs(paragraphs),
      paragraphs,
    };
    if (workId) result.workSiteId = `author-today:${workId}`;
    return result;
  }

  private findWorkTitle(doc: Document): string {
    const candidates = [
      ".book-title a",
      ".book-title",
      ".reader-header .book-title",
      "header .book-title",
      'meta[property="og:novel:book_name"]',
    ];
    for (const sel of candidates) {
      const node = doc.querySelector(sel);
      const text =
        node?.getAttribute("content") ?? node?.textContent ?? "";
      const normalized = normalizeInline(text);
      if (normalized) return normalized;
    }
    return normalizeInline(doc.title.replace(/—.*$/, ""));
  }

  private findChapterTitle(doc: Document): string {
    const candidates = [
      ".chapter-title",
      ".reader-header h1",
      "h1.chapter-title",
      "h1",
    ];
    for (const sel of candidates) {
      const node = doc.querySelector(sel);
      const text = normalizeInline(node?.textContent ?? "");
      if (text) return text;
    }
    return normalizeInline(doc.title);
  }
}
