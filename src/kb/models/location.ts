interface NamedEntity {
  id: string;
  workId: string;
  name: string;
  normalizedName: string;
  keys: string[];
  summary: string;
  confidence: number;
  firstSeenChapter: number;
  lastUpdatedChapter: number;
  // v4: денормализованный трекинг появлений (см. CharacterCard).
  appearanceCount: number;
  appearances: number[];
  createdAt: number;
}

export type Location = NamedEntity;
export type Artifact = NamedEntity;
