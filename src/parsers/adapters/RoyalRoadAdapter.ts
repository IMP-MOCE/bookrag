import {
  extractParagraphs,
  joinParagraphs,
  normalizeInline,
  pickChapterNumber,
} from "../extract";
import type { ParsedChapter, SiteAdapter } from "../types";

// URL вида:
//   https://www.royalroad.com/fiction/<workId>/<slug>
//   https://www.royalroad.com/fiction/<workId>/<slug>/chapter/<chapterId>/<slug>
const WORK_ID_RE = /\/fiction\/(\d+)/;

export class RoyalRoadAdapter implements SiteAdapter {
  readonly id = "royal-road";
  readonly priority = 100;

  matches(url: URL): boolean {
    return (
      url.hostname === "www.royalroad.com" &&
      url.pathname.includes("/fiction/") &&
      url.pathname.includes("/chapter/")
    );
  }

  chapterRoot(doc: Document): Element | null {
    return (
      doc.querySelector(".chapter-inner.chapter-content") ??
      doc.querySelector(".chapter-inner") ??
      doc.querySelector(".chapter-content")
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
    const slugMatch = url.pathname.match(/\/fiction\/\d+\/([^/]+)/);
    const workSiteUrl =
      workId && slugMatch
        ? `${url.origin}/fiction/${workId}/${slugMatch[1]}`
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
    if (workId) result.workSiteId = `royal-road:${workId}`;
    return result;
  }

  private findWorkTitle(doc: Document): string {
    const candidates = [
      ".fic-header h1",
      ".fic-header h2",
      ".fic-title h1",
      "a.text-truncate",
      'meta[property="og:title"]',
    ];
    for (const sel of candidates) {
      const node = doc.querySelector(sel);
      const text =
        node?.getAttribute("content") ?? node?.textContent ?? "";
      const normalized = normalizeInline(text);
      if (normalized) return normalized;
    }
    return normalizeInline(doc.title.replace(/\s*\|.*$/, ""));
  }

  private findChapterTitle(doc: Document): string {
    const candidates = [
      "h1.font-white",
      ".chapter-page-title h1",
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
