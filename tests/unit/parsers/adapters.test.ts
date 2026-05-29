import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { PageParser } from "@/parsers/PageParser";
import { AuthorTodayAdapter } from "@/parsers/adapters/AuthorTodayAdapter";
import { FicbookAdapter } from "@/parsers/adapters/FicbookAdapter";
import { RoyalRoadAdapter } from "@/parsers/adapters/RoyalRoadAdapter";
import { GenericReadabilityAdapter } from "@/parsers/adapters/GenericReadabilityAdapter";
import {
  AUTHOR_TODAY_HTML,
  FICBOOK_HTML,
  ROYAL_ROAD_HTML,
  GENERIC_HTML,
} from "./fixtures";

function asDocument(html: string, url: string): { doc: Document; url: URL } {
  const dom = new JSDOM(html, { url });
  return { doc: dom.window.document, url: new URL(url) };
}

describe("AuthorTodayAdapter", () => {
  const adapter = new AuthorTodayAdapter();

  it("matches reader URL and parses chapter", () => {
    const { doc, url } = asDocument(
      AUTHOR_TODAY_HTML,
      "https://author.today/reader/12345/chapter/678",
    );
    expect(adapter.matches(url)).toBe(true);

    const result = adapter.parse(doc, url);
    expect(result).not.toBeNull();
    expect(result!.workTitle).toBe("Северный род");
    expect(result!.chapterTitle).toBe("Глава 12. Дуэль на закате");
    expect(result!.chapterNumber).toBe(12);
    expect(result!.workSiteId).toBe("author-today:12345");
    expect(result!.paragraphs).toHaveLength(3);
    expect(result!.paragraphs[0]).toContain("Алексей Волков");
    expect(result!.text).not.toContain("Реклама");
  });

  it("does not match non-reader URLs", () => {
    expect(adapter.matches(new URL("https://author.today/work/123"))).toBe(false);
    expect(adapter.matches(new URL("https://example.test/reader/x"))).toBe(false);
  });
});

describe("FicbookAdapter", () => {
  const adapter = new FicbookAdapter();

  it("parses ficbook chapter", () => {
    const { doc, url } = asDocument(
      FICBOOK_HTML,
      "https://ficbook.net/readfic/9876/12345",
    );
    expect(adapter.matches(url)).toBe(true);

    const result = adapter.parse(doc, url);
    expect(result).not.toBeNull();
    expect(result!.workTitle).toBe("Серебряный лес");
    expect(result!.chapterTitle).toBe("Часть 3. Под луной");
    expect(result!.chapterNumber).toBe(3);
    expect(result!.workSiteId).toBe("ficbook:9876");
    expect(result!.paragraphs.length).toBeGreaterThan(0);
  });
});

describe("RoyalRoadAdapter", () => {
  const adapter = new RoyalRoadAdapter();

  it("parses royal road chapter", () => {
    const { doc, url } = asDocument(
      ROYAL_ROAD_HTML,
      "https://www.royalroad.com/fiction/55555/worldforge/chapter/7777/awakening",
    );
    expect(adapter.matches(url)).toBe(true);

    const result = adapter.parse(doc, url);
    expect(result).not.toBeNull();
    expect(result!.workTitle).toBe("Worldforge");
    expect(result!.chapterTitle).toBe("Chapter 7: The Awakening");
    expect(result!.chapterNumber).toBe(7);
    expect(result!.workSiteId).toBe("royal-road:55555");
    expect(result!.workSiteUrl).toBe("https://www.royalroad.com/fiction/55555/worldforge");
    expect(result!.paragraphs).toHaveLength(3);
  });

  it("does not match fiction list page (no /chapter/)", () => {
    expect(
      adapter.matches(new URL("https://www.royalroad.com/fiction/55555/worldforge")),
    ).toBe(false);
  });
});

describe("GenericReadabilityAdapter", () => {
  const adapter = new GenericReadabilityAdapter();

  it("matches anything (lowest priority fallback)", () => {
    expect(adapter.matches()).toBe(true);
  });

  it("extracts main article text from generic page", () => {
    const { doc, url } = asDocument(GENERIC_HTML, "https://some.example/articles/how-to-write");
    const result = adapter.parse(doc, url);
    expect(result).not.toBeNull();
    expect(result!.workTitle).toBe("Some Blog");
    expect(result!.chapterTitle).toContain("How to write good prose");
    expect(result!.paragraphs.length).toBeGreaterThan(0);
    expect(result!.text).toContain("Lorem ipsum");
    expect(result!.text).not.toContain("Site nav stuff");
  });
});

describe("PageParser facade", () => {
  const parser = new PageParser();

  it("prefers specific adapter over generic when URL matches", () => {
    const { doc } = asDocument(
      AUTHOR_TODAY_HTML,
      "https://author.today/reader/12345/chapter/678",
    );
    const result = parser.parse(doc);
    expect(result?.adapterId).toBe("author-today");
  });

  it("falls back to generic adapter on unknown site", () => {
    const { doc } = asDocument(GENERIC_HTML, "https://some.example/articles/how-to-write");
    const result = parser.parse(doc);
    expect(result?.adapterId).toBe("generic-readability");
  });

  it("returns null when no adapter can extract text", () => {
    const { doc, url } = asDocument(
      "<!doctype html><html><head><title>Empty</title></head><body></body></html>",
      "https://some.example/empty",
    );
    const result = parser.parse(doc, url);
    expect(result).toBeNull();
  });

  it("lists adapter ids in priority order", () => {
    const ids = parser.listAdapterIds();
    expect(ids[ids.length - 1]).toBe("generic-readability");
    expect(ids).toContain("author-today");
  });
});
