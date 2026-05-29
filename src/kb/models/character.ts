export interface CharacterHistoryEntry {
  chapterId: string;
  operation: string;
  field?: string;
  value?: string;
  at: number;
}

export interface CharacterCard {
  id: string;
  workId: string;
  name: string;
  normalizedName: string;
  aliases: string[];
  // multiEntry-индекс: все нормализованные формы имени + псевдонимы (для поиска)
  keys: string[];
  summary: string;
  role?: string;
  status?: string;
  confidence: number;
  firstSeenChapter: number;
  lastUpdatedChapter: number;
  // v4: денормализованный трекинг появлений по главам. appearances —
  // отсортированный массив chapterNumber без дублей; appearanceCount —
  // его длина (кэш для сортировки списка). Источник истины: при apply
  // create_chapter_summary каждый id из charactersPresent двигает счётчик
  // владельца. firstSeen/lastUpdated теперь производные от appearances.
  appearanceCount: number;
  appearances: number[];
  createdAt: number;
  history: CharacterHistoryEntry[];
}

// Relationship удалён в FTv6 (2026-05-26) — модель фактически не выдавала
// add_relation, role-поле character'а покрывает большинство кейсов.
