import { AuthorTodayAdapter } from "./adapters/AuthorTodayAdapter";
import { FicbookAdapter } from "./adapters/FicbookAdapter";
import { GenericReadabilityAdapter } from "./adapters/GenericReadabilityAdapter";
import { RoyalRoadAdapter } from "./adapters/RoyalRoadAdapter";
import type { ParsedChapter, SiteAdapter } from "./types";

export const DEFAULT_ADAPTERS: readonly SiteAdapter[] = [
  new AuthorTodayAdapter(),
  new FicbookAdapter(),
  new RoyalRoadAdapter(),
  new GenericReadabilityAdapter(),
];

export class PageParser {
  private readonly adapters: SiteAdapter[];

  constructor(adapters: readonly SiteAdapter[] = DEFAULT_ADAPTERS) {
    this.adapters = [...adapters].sort((a, b) => b.priority - a.priority);
  }

  // Возвращает сработавший ParsedChapter или null, если ни один адаптер не справился.
  parse(doc: Document, url: URL = new URL(doc.URL)): ParsedChapter | null {
    for (const adapter of this.adapters) {
      let matched = false;
      try {
        matched = adapter.matches(url);
      } catch (err) {
        console.warn(`[BookRAG] adapter ${adapter.id} matches() failed:`, err);
      }
      if (!matched) continue;
      try {
        const result = adapter.parse(doc, url);
        if (result) return result;
      } catch (err) {
        console.warn(`[BookRAG] adapter ${adapter.id} parse() failed:`, err);
      }
    }
    return null;
  }

  listAdapterIds(): string[] {
    return this.adapters.map((a) => a.id);
  }
}
