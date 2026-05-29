export interface ParsedChapter {
  // Идентификатор адаптера, который сработал — для диагностики и логов.
  adapterId: string;
  // Название произведения, как отображается на странице.
  workTitle: string;
  // Канонический URL произведения (страница работы, не главы) — основа для группировки глав.
  workSiteUrl: string;
  // Стабильный id произведения на платформе, если получается извлечь из URL.
  workSiteId?: string;
  chapterTitle: string;
  // Порядковый номер главы. Если адаптер не может его определить, возвращает 0.
  chapterNumber: number;
  chapterUrl: string;
  // Полный текст главы (параграфы склеены через "\n\n").
  text: string;
  // Параграфы для последующего разбиения на чанки в анализаторе.
  paragraphs: string[];
}

export interface SiteAdapter {
  readonly id: string;
  // Большее значение — раньше пробуется. Специфичные адаптеры > GenericReadability.
  readonly priority: number;
  matches(url: URL): boolean;
  parse(doc: Document, url: URL): ParsedChapter | null;
}
