import {
  extractParagraphs,
  joinParagraphs,
  normalizeInline,
  pickChapterNumber,
} from "../extract";
import type { ParsedChapter, SiteAdapter } from "../types";

// URL вида:
//   https://ficbook.net/readfic/<ficId>
//   https://ficbook.net/readfic/<ficId>/<partId>
const WORK_ID_RE = /\/readfic\/(\d+)/;

export class FicbookAdapter implements SiteAdapter {
  readonly id = "ficbook";
  readonly priority = 100;

  matches(url: URL): boolean {
    return (
      (url.hostname === "ficbook.net" || url.hostname.endsWith(".ficbook.net")) &&
      url.pathname.includes("/readfic/")
    );
  }

  chapterRoot(doc: Document): Element | null {
    return (
      doc.querySelector("#content") ??
      doc.querySelector(".js-public-beta-text-content") ??
      doc.querySelector("article .text") ??
      doc.querySelector("[itemprop='articleBody']")
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
      ? `${url.origin}/readfic/${workId}`
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
    if (workId) result.workSiteId = `ficbook:${workId}`;
    return result;
  }

  private findWorkTitle(doc: Document): string {
    const candidates = [
      ".fanfic-main-info h1",
      ".fanfic-main-info .mb-10",
      "h1.fanfic-main-info__title",
      'meta[property="og:title"]',
    ];
    for (const sel of candidates) {
      const node = doc.querySelector(sel);
      const text =
        node?.getAttribute("content") ?? node?.textContent ?? "";
      const normalized = normalizeInline(text);
      if (normalized) return normalized;
    }
    return normalizeInline(doc.title.replace(/—.*$/, "").replace(/\| Книга Фанфиков.*$/i, ""));
  }

  private findChapterTitle(doc: Document): string {
    const candidates = [
      ".part-content h2",
      ".part-name",
      "h2.part-name",
      ".chapter-title",
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
