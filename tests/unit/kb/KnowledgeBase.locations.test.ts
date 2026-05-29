import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KnowledgeBase } from "@/kb/KnowledgeBase";
import type { Operation } from "@/kb/operations";

let kb: KnowledgeBase;
let dbName: string;

beforeEach(async () => {
  dbName = `bookrag-test-${crypto.randomUUID()}`;
  kb = await KnowledgeBase.open(dbName);
});
afterEach(() => {
  kb.close();
  indexedDB.deleteDatabase(dbName);
});

async function seedLocAndArt(): Promise<{
  workId: string;
  chapterId: string;
  locId: string;
  artId: string;
}> {
  const work = await kb.createWork({ title: "T", siteUrl: "https://t.test" });
  const ch = await kb.addChapter({
    workId: work.id,
    number: 1,
    title: "x",
    url: "u",
    text: ".",
  });
  const ops: Operation[] = [
    {
      kind: "create_location",
      tempId: "tmp:l",
      name: "Северный лес",
      summary: "Тёмный лес",
      evidence: "лес",
      confidence: 0.9,
    },
    {
      kind: "create_artifact",
      tempId: "tmp:a",
      name: "Меч",
      summary: "Светящийся меч",
      evidence: "меч",
      confidence: 0.9,
    },
    {
      kind: "create_chapter_summary",
      summary: "Алексей пришёл в лес и нашёл меч.",
      charactersPresent: [],
      locationsPresent: ["tmp:l"],
      artifactsMentioned: ["tmp:a"],
      keyEventsOneline: ["находка меча"],
      evidence: "ev",
      confidence: 0.8,
    },
  ];
  const res = await kb.applyOperations({
    workId: work.id,
    chapterId: ch.id,
    chapterNumber: 1,
    operations: ops,
  });
  return {
    workId: work.id,
    chapterId: ch.id,
    locId: res.tempIdMap["tmp:l"]!,
    artId: res.tempIdMap["tmp:a"]!,
  };
}

describe("KnowledgeBase.deleteLocation", () => {
  it("deletes location and removes references from chapter_summaries and evidences", async () => {
    const { workId, locId } = await seedLocAndArt();

    await kb.deleteLocation(workId, locId);

    const locs = await kb.listLocations(workId);
    expect(locs).toHaveLength(0);

    const summaries = await kb.listChapterSummaries(workId);
    expect(summaries[0]!.locationsPresent).toEqual([]);

    const evidences = await kb["db"].getAllFromIndex(
      "evidences",
      "by-target",
      ["location", locId],
    );
    expect(evidences).toHaveLength(0);
  });

  it("rejects cross-work delete", async () => {
    const { workId, locId } = await seedLocAndArt();
    const other = await kb.createWork({ title: "O", siteUrl: "https://o.test" });
    await expect(kb.deleteLocation(other.id, locId)).rejects.toThrow();
  });

  it("is no-op when location does not exist", async () => {
    const { workId } = await seedLocAndArt();
    await expect(kb.deleteLocation(workId, "loc_does_not_exist")).resolves.toBeUndefined();
  });
});

describe("KnowledgeBase.deleteArtifact", () => {
  it("deletes artifact and removes references from chapter_summaries and evidences", async () => {
    const { workId, artId } = await seedLocAndArt();

    await kb.deleteArtifact(workId, artId);

    const arts = await kb.listArtifacts(workId);
    expect(arts).toHaveLength(0);

    const summaries = await kb.listChapterSummaries(workId);
    expect(summaries[0]!.artifactsMentioned).toEqual([]);

    const evidences = await kb["db"].getAllFromIndex(
      "evidences",
      "by-target",
      ["artifact", artId],
    );
    expect(evidences).toHaveLength(0);
  });

  it("rejects cross-work delete", async () => {
    const { artId } = await seedLocAndArt();
    const other = await kb.createWork({ title: "O", siteUrl: "https://o.test" });
    await expect(kb.deleteArtifact(other.id, artId)).rejects.toThrow();
  });
});
