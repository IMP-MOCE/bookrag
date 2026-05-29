import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Work, Chapter, AnalysisRun } from "./models/work";
import type { CharacterCard } from "./models/character";
import type { Location, Artifact } from "./models/location";
import type { ChapterSummary, FactEvidence } from "./models/event";
import type { CollisionReviewItem } from "./models/review";

export const DB_NAME = "bookrag";
// v3 (FTv6, 2026-05-26): drop events + relationships stores; create chapter_summaries.
// v4 (2026-05-26): добавлены поля appearances/appearanceCount в characters/
//   locations/artifacts. Поскольку прода нет, мигрируем «дубовым» способом —
//   дропаем все entity-stores (characters/locations/artifacts/chapter_summaries/
//   evidences/review_items) и пересоздаём их с теми же индексами. works/chapters/
//   analysis_runs остаются нетронутыми (они не зависят от новых полей).
export const DB_VERSION = 4;

export interface BookragSchema extends DBSchema {
  works: {
    key: string;
    value: Work;
    indexes: { "by-created": number };
  };
  chapters: {
    key: string;
    value: Chapter;
    indexes: {
      "by-work": string;
      "by-work-number": [string, number];
    };
  };
  analysis_runs: {
    key: string;
    value: AnalysisRun;
    indexes: {
      "by-chapter": string;
      "by-work": string;
    };
  };
  characters: {
    key: string;
    value: CharacterCard;
    indexes: {
      "by-work": string;
      "by-work-normalized": [string, string];
      "by-key": string;
    };
  };
  locations: {
    key: string;
    value: Location;
    indexes: {
      "by-work": string;
      "by-work-normalized": [string, string];
      "by-key": string;
    };
  };
  artifacts: {
    key: string;
    value: Artifact;
    indexes: {
      "by-work": string;
      "by-work-normalized": [string, string];
      "by-key": string;
    };
  };
  chapter_summaries: {
    key: string;
    value: ChapterSummary;
    indexes: {
      "by-work": string;
      "by-chapter": string;
      "by-work-chapter-number": [string, number];
    };
  };
  evidences: {
    key: string;
    value: FactEvidence;
    indexes: {
      "by-chapter": string;
      "by-target": [string, string];
    };
  };
  review_items: {
    key: string;
    value: CollisionReviewItem;
    indexes: {
      "by-work": string;
      "by-work-status": [string, string];
    };
  };
}

export type BookragDB = IDBPDatabase<BookragSchema>;

export function openKb(name: string = DB_NAME): Promise<BookragDB> {
  return openDB<BookragSchema>(name, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        createV1Stores(db);
      }
      if (oldVersion < 2) {
        createReviewStore(db);
      }
      if (oldVersion < 3) {
        upgradeToV3(db);
      }
      if (oldVersion < 4) {
        upgradeToV4(db);
      }
    },
  });
}

function createV1Stores(db: IDBPDatabase<BookragSchema>): void {
  const works = db.createObjectStore("works", { keyPath: "id" });
  works.createIndex("by-created", "createdAt");

  const chapters = db.createObjectStore("chapters", { keyPath: "id" });
  chapters.createIndex("by-work", "workId");
  chapters.createIndex("by-work-number", ["workId", "number"], { unique: true });

  const runs = db.createObjectStore("analysis_runs", { keyPath: "id" });
  runs.createIndex("by-chapter", "chapterId");
  runs.createIndex("by-work", "workId");

  const characters = db.createObjectStore("characters", { keyPath: "id" });
  characters.createIndex("by-work", "workId");
  characters.createIndex("by-work-normalized", ["workId", "normalizedName"], {
    unique: false,
  });
  characters.createIndex("by-key", "keys", { multiEntry: true });

  const locations = db.createObjectStore("locations", { keyPath: "id" });
  locations.createIndex("by-work", "workId");
  locations.createIndex("by-work-normalized", ["workId", "normalizedName"], {
    unique: false,
  });
  locations.createIndex("by-key", "keys", { multiEntry: true });

  const artifacts = db.createObjectStore("artifacts", { keyPath: "id" });
  artifacts.createIndex("by-work", "workId");
  artifacts.createIndex("by-work-normalized", ["workId", "normalizedName"], {
    unique: false,
  });
  artifacts.createIndex("by-key", "keys", { multiEntry: true });

  const evidences = db.createObjectStore("evidences", { keyPath: "id" });
  evidences.createIndex("by-chapter", "chapterId");
  evidences.createIndex("by-target", ["targetType", "targetId"]);
}

function createReviewStore(db: IDBPDatabase<BookragSchema>): void {
  const reviews = db.createObjectStore("review_items", { keyPath: "id" });
  reviews.createIndex("by-work", "workId");
  reviews.createIndex("by-work-status", ["workId", "status"]);
}

// FTv6 upgrade: убираем events + relationships, заводим chapter_summaries.
// Метаданные старых stores не сохраняются — на проде их никто не использовал.
function upgradeToV3(db: IDBPDatabase<BookragSchema>): void {
  // db.objectStoreNames содержит ВСЕ имена, включая «несуществующие» в новой схеме —
  // idb-types этого знать не могут, поэтому каст к строковому Iterable.
  const names = db.objectStoreNames as unknown as DOMStringList;
  if (names.contains("events")) {
    db.deleteObjectStore("events" as never);
  }
  if (names.contains("relationships")) {
    db.deleteObjectStore("relationships" as never);
  }
  if (!names.contains("chapter_summaries")) {
    const summaries = db.createObjectStore("chapter_summaries", { keyPath: "id" });
    summaries.createIndex("by-work", "workId");
    summaries.createIndex("by-chapter", "chapterId");
    summaries.createIndex("by-work-chapter-number", ["workId", "chapterNumber"], {
      unique: true,
    });
  }
}

// v4 upgrade: добавлены поля appearances/appearanceCount в characters/locations/
// artifacts. Старые записи в этих сущностях не имеют новых полей, поэтому проще
// дропнуть и пересоздать stores (продакшна нет, потеря локального справочника
// допустима — пользователь повторит анализ глав). chapter_summaries / evidences /
// review_items тоже сбрасываем, чтобы не остались висячие ссылки на удалённые
// characters. works / chapters / analysis_runs не трогаем.
function upgradeToV4(db: IDBPDatabase<BookragSchema>): void {
  const names = db.objectStoreNames as unknown as DOMStringList;
  const dropAndRecreate = [
    "characters",
    "locations",
    "artifacts",
    "chapter_summaries",
    "evidences",
    "review_items",
  ] as const;
  for (const storeName of dropAndRecreate) {
    if (names.contains(storeName)) {
      db.deleteObjectStore(storeName);
    }
  }

  const characters = db.createObjectStore("characters", { keyPath: "id" });
  characters.createIndex("by-work", "workId");
  characters.createIndex("by-work-normalized", ["workId", "normalizedName"], {
    unique: false,
  });
  characters.createIndex("by-key", "keys", { multiEntry: true });

  const locations = db.createObjectStore("locations", { keyPath: "id" });
  locations.createIndex("by-work", "workId");
  locations.createIndex("by-work-normalized", ["workId", "normalizedName"], {
    unique: false,
  });
  locations.createIndex("by-key", "keys", { multiEntry: true });

  const artifacts = db.createObjectStore("artifacts", { keyPath: "id" });
  artifacts.createIndex("by-work", "workId");
  artifacts.createIndex("by-work-normalized", ["workId", "normalizedName"], {
    unique: false,
  });
  artifacts.createIndex("by-key", "keys", { multiEntry: true });

  const summaries = db.createObjectStore("chapter_summaries", { keyPath: "id" });
  summaries.createIndex("by-work", "workId");
  summaries.createIndex("by-chapter", "chapterId");
  summaries.createIndex("by-work-chapter-number", ["workId", "chapterNumber"], {
    unique: true,
  });

  const evidences = db.createObjectStore("evidences", { keyPath: "id" });
  evidences.createIndex("by-chapter", "chapterId");
  evidences.createIndex("by-target", ["targetType", "targetId"]);

  const reviews = db.createObjectStore("review_items", { keyPath: "id" });
  reviews.createIndex("by-work", "workId");
  reviews.createIndex("by-work-status", ["workId", "status"]);
}
