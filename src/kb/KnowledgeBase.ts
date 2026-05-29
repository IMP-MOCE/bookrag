import { sha256Hex } from "../lib/hash";
import { newId } from "../lib/id";
import { buildKeys, isRedundantAliasForName, normalizeAlias } from "../lib/normalize";
import type { CharacterCard, CharacterHistoryEntry } from "./models/character";
import type { ChapterSummary, EvidenceTargetType, FactEvidence } from "./models/event";
import type { Artifact, Location } from "./models/location";
import type { CollisionReviewItem, ReviewStatus } from "./models/review";
import type { AnalysisRun, Chapter, ModelProfile, Work } from "./models/work";
import {
  isTempRef,
  sortOperations,
  type EntityRef,
  type Operation,
} from "./operations";
import { openKb, type BookragDB } from "./schema";

export interface ApplyResult {
  applied: number;
  skipped: number;
  tempIdMap: Record<string, string>;
}

export interface KbContext {
  characters: CharacterCard[];
  locations: Location[];
  artifacts: Artifact[];
}

export interface CharacterEditPatch {
  name?: string;
  aliases?: string[];
  summary?: string;
  role?: string;
  status?: string;
  confidence?: number;
}

// v4: helper для денормализованного трекинга появлений. Вызывается:
//  - в applyOperations при create_chapter_summary (по каждому id из participants),
//  - в applyOperations при create_*-операциях (для seed-главы),
//  - в applyOperations при попадании в дубль existing записи (модель пересоздала),
//  - в mergeCharacters (через recomputeAppearance(union)).
// Возвращает true, если глава ещё не была учтена и счётчик увеличился.
interface AppearanceTracked {
  appearances: number[];
  appearanceCount: number;
  firstSeenChapter: number;
  lastUpdatedChapter: number;
}

function bumpAppearance<T extends AppearanceTracked>(record: T, chapterNumber: number): boolean {
  if (record.appearances.includes(chapterNumber)) return false;
  const next = [...record.appearances, chapterNumber].sort((a, b) => a - b);
  record.appearances = next;
  record.appearanceCount = next.length;
  record.firstSeenChapter = next[0]!;
  record.lastUpdatedChapter = next[next.length - 1]!;
  return true;
}

function unionAppearances(a: readonly number[], b: readonly number[]): number[] {
  const seen = new Set<number>();
  for (const n of a) seen.add(n);
  for (const n of b) seen.add(n);
  return Array.from(seen).sort((x, y) => x - y);
}

export class KnowledgeBase {
  constructor(private readonly db: BookragDB) {}

  static async open(name?: string): Promise<KnowledgeBase> {
    const db = await openKb(name);
    return new KnowledgeBase(db);
  }

  close(): void {
    this.db.close();
  }

  // ---------- Works ----------

  async createWork(input: { title: string; siteUrl: string }): Promise<Work> {
    const work: Work = {
      id: newId("work"),
      title: input.title,
      siteUrl: input.siteUrl,
      createdAt: Date.now(),
    };
    await this.db.put("works", work);
    return work;
  }

  getWork(id: string): Promise<Work | undefined> {
    return this.db.get("works", id);
  }

  listWorks(): Promise<Work[]> {
    return this.db.getAll("works");
  }

  // ---------- Chapters ----------

  async addChapter(input: {
    workId: string;
    number: number;
    title: string;
    url: string;
    text: string;
  }): Promise<Chapter> {
    const existing = await this.db.getFromIndex("chapters", "by-work-number", [
      input.workId,
      input.number,
    ]);
    if (existing) {
      const newHash = await sha256Hex(input.text);
      if (existing.contentHash === newHash) return existing;
      const updated: Chapter = {
        ...existing,
        title: input.title,
        url: input.url,
        contentHash: newHash,
      };
      await this.db.put("chapters", updated);
      return updated;
    }
    const chapter: Chapter = {
      id: newId("chap"),
      workId: input.workId,
      number: input.number,
      title: input.title,
      url: input.url,
      contentHash: await sha256Hex(input.text),
      createdAt: Date.now(),
    };
    await this.db.put("chapters", chapter);
    return chapter;
  }

  getChapter(id: string): Promise<Chapter | undefined> {
    return this.db.get("chapters", id);
  }

  listChapters(workId: string): Promise<Chapter[]> {
    return this.db.getAllFromIndex("chapters", "by-work", workId);
  }

  // ---------- Analysis runs ----------

  async startAnalysisRun(input: {
    workId: string;
    chapterId: string;
    modelProfile: ModelProfile;
  }): Promise<AnalysisRun> {
    const run: AnalysisRun = {
      id: newId("run"),
      workId: input.workId,
      chapterId: input.chapterId,
      modelProfile: input.modelProfile,
      status: "running",
      startedAt: Date.now(),
    };
    await this.db.put("analysis_runs", run);
    return run;
  }

  async completeAnalysisRun(runId: string, error?: string): Promise<void> {
    const run = await this.db.get("analysis_runs", runId);
    if (!run) return;
    const updated: AnalysisRun = {
      ...run,
      status: error ? "error" : "done",
      finishedAt: Date.now(),
      ...(error ? { error } : {}),
    };
    await this.db.put("analysis_runs", updated);
  }

  // ---------- Reads ----------

  getCharacter(id: string): Promise<CharacterCard | undefined> {
    return this.db.get("characters", id);
  }

  listCharacters(workId: string): Promise<CharacterCard[]> {
    return this.db.getAllFromIndex("characters", "by-work", workId);
  }

  listLocations(workId: string): Promise<Location[]> {
    return this.db.getAllFromIndex("locations", "by-work", workId);
  }

  listArtifacts(workId: string): Promise<Artifact[]> {
    return this.db.getAllFromIndex("artifacts", "by-work", workId);
  }

  // FTv6: chapter_summaries вместо events. Одна запись на главу, отсортирована
  // по chapterNumber (ASC), чтобы «previously on…» строилось хронологически.
  async listChapterSummaries(workId: string): Promise<ChapterSummary[]> {
    const list = await this.db.getAllFromIndex("chapter_summaries", "by-work", workId);
    return list.sort((a, b) => a.chapterNumber - b.chapterNumber);
  }

  getChapterSummary(chapterId: string): Promise<ChapterSummary | undefined> {
    return this.db
      .getAllFromIndex("chapter_summaries", "by-chapter", chapterId)
      .then((list) => list[0]);
  }

  async updateCharacter(
    workId: string,
    characterId: string,
    patch: CharacterEditPatch,
  ): Promise<CharacterCard> {
    const current = await this.db.get("characters", characterId);
    if (!current) throw new Error(`updateCharacter: character not found (${characterId})`);
    if (current.workId !== workId) throw new Error("updateCharacter: cross-work update is not allowed");

    const name = patch.name !== undefined ? patch.name.trim() : current.name;
    if (!name) throw new Error("updateCharacter: name must not be empty");

    const aliases = patch.aliases !== undefined
      ? normalizeAliasList(name, patch.aliases)
      : current.aliases;
    const summary = patch.summary !== undefined ? patch.summary.trim() : current.summary;
    const role = patch.role !== undefined ? patch.role.trim() : current.role;
    const status = patch.status !== undefined ? patch.status.trim() : current.status;
    const confidence = patch.confidence !== undefined
      ? Math.min(1, Math.max(0, patch.confidence))
      : current.confidence;

    const changes: CharacterHistoryEntry[] = [];
    const now = Date.now();
    if (name !== current.name) {
      changes.push({ chapterId: "", operation: "manual_edit", field: "name", value: name, at: now });
    }
    if (aliases.join("\n") !== current.aliases.join("\n")) {
      changes.push({
        chapterId: "",
        operation: "manual_edit",
        field: "aliases",
        value: aliases.join(", "),
        at: now,
      });
    }
    if (summary !== current.summary) {
      changes.push({ chapterId: "", operation: "manual_edit", field: "summary", value: summary, at: now });
    }
    if ((role ?? "") !== (current.role ?? "")) {
      changes.push({ chapterId: "", operation: "manual_edit", field: "role", value: role ?? "", at: now });
    }
    if ((status ?? "") !== (current.status ?? "")) {
      changes.push({ chapterId: "", operation: "manual_edit", field: "status", value: status ?? "", at: now });
    }
    if (confidence !== current.confidence) {
      changes.push({
        chapterId: "",
        operation: "manual_edit",
        field: "confidence",
        value: confidence.toFixed(2),
        at: now,
      });
    }

    const updated: CharacterCard = {
      ...current,
      name,
      normalizedName: normalizeAlias(name),
      aliases,
      keys: buildKeys(name, aliases),
      summary,
      confidence,
      history: changes.length > 0 ? [...current.history, ...changes] : current.history,
      ...(role ? { role } : {}),
      ...(status ? { status } : {}),
    };
    if (!role) delete (updated as { role?: string }).role;
    if (!status) delete (updated as { status?: string }).status;

    await this.db.put("characters", updated);
    return updated;
  }

  async deleteLocation(workId: string, locationId: string): Promise<void> {
    const tx = this.db.transaction(
      ["locations", "chapter_summaries", "evidences"],
      "readwrite",
    );
    const loc = await tx.objectStore("locations").get(locationId);
    if (!loc) return;
    if (loc.workId !== workId) throw new Error("deleteLocation: cross-work delete is not allowed");

    const summaries = await tx.objectStore("chapter_summaries").index("by-work").getAll(workId);
    for (const s of summaries) {
      if (!s.locationsPresent.includes(locationId)) continue;
      await tx.objectStore("chapter_summaries").put({
        ...s,
        locationsPresent: s.locationsPresent.filter((id) => id !== locationId),
      });
    }

    const evidences = await tx
      .objectStore("evidences")
      .index("by-target")
      .getAll(["location", locationId]);
    for (const ev of evidences) {
      await tx.objectStore("evidences").delete(ev.id);
    }

    await tx.objectStore("locations").delete(locationId);
    await tx.done;
  }

  async deleteArtifact(workId: string, artifactId: string): Promise<void> {
    const tx = this.db.transaction(
      ["artifacts", "chapter_summaries", "evidences"],
      "readwrite",
    );
    const art = await tx.objectStore("artifacts").get(artifactId);
    if (!art) return;
    if (art.workId !== workId) throw new Error("deleteArtifact: cross-work delete is not allowed");

    const summaries = await tx.objectStore("chapter_summaries").index("by-work").getAll(workId);
    for (const s of summaries) {
      if (!s.artifactsMentioned.includes(artifactId)) continue;
      await tx.objectStore("chapter_summaries").put({
        ...s,
        artifactsMentioned: s.artifactsMentioned.filter((id) => id !== artifactId),
      });
    }

    const evidences = await tx
      .objectStore("evidences")
      .index("by-target")
      .getAll(["artifact", artifactId]);
    for (const ev of evidences) {
      await tx.objectStore("evidences").delete(ev.id);
    }

    await tx.objectStore("artifacts").delete(artifactId);
    await tx.done;
  }

  async deleteCharacter(workId: string, characterId: string): Promise<void> {
    const tx = this.db.transaction(
      ["characters", "chapter_summaries", "evidences", "review_items"],
      "readwrite",
    );
    const card = await tx.objectStore("characters").get(characterId);
    if (!card) return;
    if (card.workId !== workId) throw new Error("deleteCharacter: cross-work delete is not allowed");

    // Вычистить characterId из chapter_summaries.charactersPresent. Сами summaries
    // не удаляем — они описывают главу как единое целое.
    const summaries = await tx.objectStore("chapter_summaries").index("by-work").getAll(workId);
    for (const s of summaries) {
      if (!s.charactersPresent.includes(characterId)) continue;
      await tx.objectStore("chapter_summaries").put({
        ...s,
        charactersPresent: s.charactersPresent.filter((id) => id !== characterId),
      });
    }

    const evidences = await tx
      .objectStore("evidences")
      .index("by-target")
      .getAll(["character", characterId]);
    for (const ev of evidences) {
      await tx.objectStore("evidences").delete(ev.id);
    }

    const reviews = await tx.objectStore("review_items").index("by-work").getAll(workId);
    for (const review of reviews) {
      if (review.newCharacterId === characterId || review.candidateId === characterId) {
        await tx.objectStore("review_items").delete(review.id);
      }
    }

    await tx.objectStore("characters").delete(characterId);
    await tx.done;
  }

  async searchByKey(
    workId: string,
    query: string,
  ): Promise<{
    characters: CharacterCard[];
    locations: Location[];
    artifacts: Artifact[];
  }> {
    const key = normalizeAlias(query);
    if (!key) return { characters: [], locations: [], artifacts: [] };
    const [chars, locs, arts] = await Promise.all([
      this.db.getAllFromIndex("characters", "by-key", key),
      this.db.getAllFromIndex("locations", "by-key", key),
      this.db.getAllFromIndex("artifacts", "by-key", key),
    ]);
    return {
      characters: chars.filter((c) => c.workId === workId),
      locations: locs.filter((l) => l.workId === workId),
      artifacts: arts.filter((a) => a.workId === workId),
    };
  }

  // ---------- Context for analysis ----------

  async buildContextForAnalysis(workId: string, chapterText: string): Promise<KbContext> {
    const normalizedText = " " + normalizeAlias(chapterText) + " ";
    const [allChars, allLocs, allArts] = await Promise.all([
      this.listCharacters(workId),
      this.listLocations(workId),
      this.listArtifacts(workId),
    ]);
    const matches = (keys: readonly string[]): boolean =>
      keys.some((k) => k.length > 1 && normalizedText.includes(` ${k} `));
    return {
      characters: allChars.filter((c) => matches(c.keys)),
      locations: allLocs.filter((l) => matches(l.keys)),
      artifacts: allArts.filter((a) => matches(a.keys)),
    };
  }

  // ---------- Apply operations ----------

  async applyOperations(input: {
    workId: string;
    chapterId: string;
    chapterNumber: number;
    operations: readonly Operation[];
  }): Promise<ApplyResult> {
    const sorted = sortOperations(input.operations);
    const tempIdMap: Record<string, string> = {};
    let applied = 0;
    let skipped = 0;
    const now = Date.now();

    const tx = this.db.transaction(
      ["characters", "locations", "artifacts", "chapter_summaries", "evidences"],
      "readwrite",
    );

    const resolveRef = (ref: EntityRef): string | undefined =>
      isTempRef(ref) ? tempIdMap[ref] : ref;

    const writeEvidence = async (
      targetType: EvidenceTargetType,
      targetId: string,
      snippet: string,
      confidence: number,
    ): Promise<void> => {
      const ev: FactEvidence = {
        id: newId("ev"),
        workId: input.workId,
        chapterId: input.chapterId,
        targetType,
        targetId,
        snippet,
        confidence,
        createdAt: now,
      };
      await tx.objectStore("evidences").add(ev);
    };

    for (const op of sorted) {
      switch (op.kind) {
        case "create_character": {
          const normalized = normalizeAlias(op.name);
          const dup = await tx
            .objectStore("characters")
            .index("by-work-normalized")
            .get([input.workId, normalized]);
          if (dup) {
            tempIdMap[op.tempId] = dup.id;
            // Дубль = модель снова описала уже-известного персонажа в этой
            // главе. Учитываем появление, чтобы счётчик/lastUpdatedChapter
            // двигались (отдельно от create_chapter_summary, на случай если
            // summary почему-то не пришёл).
            if (bumpAppearance(dup, input.chapterNumber)) {
              await tx.objectStore("characters").put(dup);
            }
            skipped++;
            break;
          }
          const card: CharacterCard = {
            id: newId("char"),
            workId: input.workId,
            name: op.name,
            normalizedName: normalized,
            aliases: Array.from(new Set(op.aliases)),
            keys: buildKeys(op.name, op.aliases),
            summary: op.summary,
            ...(op.role ? { role: op.role } : {}),
            confidence: op.confidence,
            firstSeenChapter: input.chapterNumber,
            lastUpdatedChapter: input.chapterNumber,
            appearanceCount: 1,
            appearances: [input.chapterNumber],
            createdAt: now,
            history: [
              { chapterId: input.chapterId, operation: "created", at: now },
            ],
          };
          await tx.objectStore("characters").add(card);
          await writeEvidence("character", card.id, op.evidence, op.confidence);
          tempIdMap[op.tempId] = card.id;
          applied++;
          break;
        }

        case "create_location": {
          const normalized = normalizeAlias(op.name);
          const dup = await tx
            .objectStore("locations")
            .index("by-work-normalized")
            .get([input.workId, normalized]);
          if (dup) {
            tempIdMap[op.tempId] = dup.id;
            if (bumpAppearance(dup, input.chapterNumber)) {
              await tx.objectStore("locations").put(dup);
            }
            skipped++;
            break;
          }
          const loc: Location = {
            id: newId("loc"),
            workId: input.workId,
            name: op.name,
            normalizedName: normalized,
            keys: buildKeys(op.name, []),
            summary: op.summary,
            confidence: op.confidence,
            firstSeenChapter: input.chapterNumber,
            lastUpdatedChapter: input.chapterNumber,
            appearanceCount: 1,
            appearances: [input.chapterNumber],
            createdAt: now,
          };
          await tx.objectStore("locations").add(loc);
          await writeEvidence("location", loc.id, op.evidence, op.confidence);
          tempIdMap[op.tempId] = loc.id;
          applied++;
          break;
        }

        case "create_artifact": {
          const normalized = normalizeAlias(op.name);
          const dup = await tx
            .objectStore("artifacts")
            .index("by-work-normalized")
            .get([input.workId, normalized]);
          if (dup) {
            tempIdMap[op.tempId] = dup.id;
            if (bumpAppearance(dup, input.chapterNumber)) {
              await tx.objectStore("artifacts").put(dup);
            }
            skipped++;
            break;
          }
          const art: Artifact = {
            id: newId("art"),
            workId: input.workId,
            name: op.name,
            normalizedName: normalized,
            keys: buildKeys(op.name, []),
            summary: op.summary,
            confidence: op.confidence,
            firstSeenChapter: input.chapterNumber,
            lastUpdatedChapter: input.chapterNumber,
            appearanceCount: 1,
            appearances: [input.chapterNumber],
            createdAt: now,
          };
          await tx.objectStore("artifacts").add(art);
          await writeEvidence("artifact", art.id, op.evidence, op.confidence);
          tempIdMap[op.tempId] = art.id;
          applied++;
          break;
        }

        case "add_alias": {
          const realId = resolveRef(op.targetId);
          if (!realId) {
            skipped++;
            break;
          }
          const card = await tx.objectStore("characters").get(realId);
          if (!card) {
            skipped++;
            break;
          }
          const normalized = normalizeAlias(op.alias);
          if (
            card.aliases.some((a) => normalizeAlias(a) === normalized) ||
            normalizeAlias(card.name) === normalized ||
            isRedundantAliasForName(card.name, card.aliases, op.alias)
          ) {
            skipped++;
            break;
          }
          const updated: CharacterCard = {
            ...card,
            aliases: [...card.aliases, op.alias],
            keys: buildKeys(card.name, [...card.aliases, op.alias]),
            lastUpdatedChapter: input.chapterNumber,
            history: [
              ...card.history,
              {
                chapterId: input.chapterId,
                operation: "add_alias",
                value: op.alias,
                at: now,
              } satisfies CharacterHistoryEntry,
            ],
          };
          await tx.objectStore("characters").put(updated);
          await writeEvidence("character", realId, op.evidence, op.confidence);
          applied++;
          break;
        }

        case "update_character": {
          const realId = resolveRef(op.targetId);
          if (!realId) {
            skipped++;
            break;
          }
          const card = await tx.objectStore("characters").get(realId);
          if (!card) {
            skipped++;
            break;
          }
          if (card[op.field] === op.newValue) {
            skipped++;
            break;
          }
          const updated: CharacterCard = {
            ...card,
            [op.field]: op.newValue,
            lastUpdatedChapter: input.chapterNumber,
            history: [
              ...card.history,
              {
                chapterId: input.chapterId,
                operation: "update_character",
                field: op.field,
                value: op.newValue,
                at: now,
              } satisfies CharacterHistoryEntry,
            ],
          };
          await tx.objectStore("characters").put(updated);
          await writeEvidence("character", realId, op.evidence, op.confidence);
          applied++;
          break;
        }

        case "create_chapter_summary": {
          // Одна summary на главу. На уровне ChapterAnalyzer'а SummaryAggregator
          // склеивает чанковые summary в одну операцию. Если каким-то образом
          // пришли две операции на одну главу — дублёр заменяет существующую запись
          // (последний-победил, чтобы не множить чанковые версии в KB).
          const charactersPresent = op.charactersPresent
            .map(resolveRef)
            .filter((id): id is string => Boolean(id));
          const locationsPresent = op.locationsPresent
            .map(resolveRef)
            .filter((id): id is string => Boolean(id));
          const artifactsMentioned = op.artifactsMentioned
            .map(resolveRef)
            .filter((id): id is string => Boolean(id));

          const existing = await tx
            .objectStore("chapter_summaries")
            .index("by-work-chapter-number")
            .get([input.workId, input.chapterNumber]);

          const summary: ChapterSummary = {
            id: existing?.id ?? newId("smry"),
            workId: input.workId,
            chapterId: input.chapterId,
            chapterNumber: input.chapterNumber,
            summary: op.summary,
            charactersPresent,
            locationsPresent,
            artifactsMentioned,
            keyEventsOneline: [...op.keyEventsOneline],
            confidence: op.confidence,
            createdAt: existing?.createdAt ?? now,
          };
          await tx.objectStore("chapter_summaries").put(summary);
          await writeEvidence("chapter_summary", summary.id, op.evidence, op.confidence);

          // v4: двигаем счётчик появлений у каждого participant'а. Union без
          // вычитания: если та же глава анализируется повторно (upsert summary),
          // bumpAppearance idempotent — chapter уже в массиве → no-op. id из
          // resolveRef(): canonical KB id; запись могла быть создана выше в этом
          // же applyOperations или ещё раньше. Если записи нет (грязная ссылка) —
          // тихо пропускаем.
          for (const charId of charactersPresent) {
            const card = await tx.objectStore("characters").get(charId);
            if (!card) continue;
            if (bumpAppearance(card, input.chapterNumber)) {
              await tx.objectStore("characters").put(card);
            }
          }
          for (const locId of locationsPresent) {
            const loc = await tx.objectStore("locations").get(locId);
            if (!loc) continue;
            if (bumpAppearance(loc, input.chapterNumber)) {
              await tx.objectStore("locations").put(loc);
            }
          }
          for (const artId of artifactsMentioned) {
            const art = await tx.objectStore("artifacts").get(artId);
            if (!art) continue;
            if (bumpAppearance(art, input.chapterNumber)) {
              await tx.objectStore("artifacts").put(art);
            }
          }
          applied++;
          break;
        }
      }
    }

    await tx.done;
    return { applied, skipped, tempIdMap };
  }

  // ---------- Collision review queue ----------

  async enqueueReview(input: {
    workId: string;
    chapterId: string;
    newCharacterId: string;
    candidateId: string;
    score: number;
    features: string[];
    llmHint?: number;
  }): Promise<CollisionReviewItem> {
    const item: CollisionReviewItem = {
      id: newId("rev"),
      workId: input.workId,
      chapterId: input.chapterId,
      newCharacterId: input.newCharacterId,
      candidateId: input.candidateId,
      score: input.score,
      features: input.features,
      ...(input.llmHint !== undefined ? { llmHint: input.llmHint } : {}),
      status: "pending",
      createdAt: Date.now(),
    };
    await this.db.put("review_items", item);
    return item;
  }

  listPendingReviews(workId: string): Promise<CollisionReviewItem[]> {
    return this.db.getAllFromIndex("review_items", "by-work-status", [workId, "pending"]);
  }

  async resolveReview(
    reviewId: string,
    resolution: { status: Exclude<ReviewStatus, "pending">; note?: string },
  ): Promise<void> {
    const item = await this.db.get("review_items", reviewId);
    if (!item) return;
    const updated: CollisionReviewItem = {
      ...item,
      status: resolution.status,
      resolvedAt: Date.now(),
      ...(resolution.note ? { resolutionNote: resolution.note } : {}),
    };
    await this.db.put("review_items", updated);
  }

  // ---------- Merge characters ----------

  async mergeCharacters(input: {
    workId: string;
    primaryId: string;
    secondaryId: string;
    reason: string;
  }): Promise<void> {
    if (input.primaryId === input.secondaryId) return;

    const tx = this.db.transaction(
      ["characters", "chapter_summaries", "evidences", "review_items"],
      "readwrite",
    );

    const primary = await tx.objectStore("characters").get(input.primaryId);
    const secondary = await tx.objectStore("characters").get(input.secondaryId);
    if (!primary || !secondary) {
      throw new Error(`mergeCharacters: character not found (primary=${!!primary}, secondary=${!!secondary})`);
    }
    if (primary.workId !== input.workId || secondary.workId !== input.workId) {
      throw new Error("mergeCharacters: cross-work merge is not allowed");
    }

    const now = Date.now();
    const newAliases: string[] = [...primary.aliases];
    for (const alias of [secondary.name, ...secondary.aliases]) {
      if (isRedundantAliasForName(primary.name, newAliases, alias)) continue;
      if (newAliases.some((a) => normalizeAlias(a) === normalizeAlias(alias))) continue;
      newAliases.push(alias);
    }
    const mergedSummary =
      primary.summary && secondary.summary && primary.summary !== secondary.summary
        ? `${primary.summary}\n\n[После слияния] ${secondary.summary}`
        : primary.summary || secondary.summary;

    // v4: объединяем appearances обоих персонажей без дублей. firstSeen/
    // lastUpdated теперь производные от union'а (а не Math.min/max от полей,
    // которые могли расходиться с массивом, например после ручного редактирования).
    const mergedAppearances = unionAppearances(primary.appearances, secondary.appearances);
    const updatedPrimary: CharacterCard = {
      ...primary,
      aliases: newAliases,
      keys: buildKeys(primary.name, newAliases),
      summary: mergedSummary,
      confidence: Math.max(primary.confidence, secondary.confidence),
      appearances: mergedAppearances,
      appearanceCount: mergedAppearances.length,
      firstSeenChapter:
        mergedAppearances[0] ?? Math.min(primary.firstSeenChapter, secondary.firstSeenChapter),
      lastUpdatedChapter:
        mergedAppearances[mergedAppearances.length - 1] ??
        Math.max(primary.lastUpdatedChapter, secondary.lastUpdatedChapter),
      history: [
        ...primary.history,
        ...secondary.history,
        {
          chapterId: "",
          operation: "merged",
          value: `merged ${secondary.id} → ${primary.id}: ${input.reason}`,
          at: now,
        } satisfies CharacterHistoryEntry,
      ],
    };
    await tx.objectStore("characters").put(updatedPrimary);
    await tx.objectStore("characters").delete(input.secondaryId);

    // Перенаправить chapter_summaries.charactersPresent: secondaryId → primaryId.
    const summaries = await tx
      .objectStore("chapter_summaries")
      .index("by-work")
      .getAll(input.workId);
    for (const s of summaries) {
      if (!s.charactersPresent.includes(input.secondaryId)) continue;
      const newIds = Array.from(
        new Set(
          s.charactersPresent.map((id) => (id === input.secondaryId ? input.primaryId : id)),
        ),
      );
      await tx.objectStore("chapter_summaries").put({ ...s, charactersPresent: newIds });
    }

    // Перенаправить evidences для character.
    const evs = await tx
      .objectStore("evidences")
      .index("by-target")
      .getAll(["character", input.secondaryId]);
    for (const ev of evs) {
      await tx.objectStore("evidences").put({ ...ev, targetId: input.primaryId });
    }

    const reviews = await tx.objectStore("review_items").index("by-work").getAll(input.workId);
    for (const review of reviews) {
      if (review.newCharacterId === input.secondaryId || review.candidateId === input.secondaryId) {
        await tx.objectStore("review_items").delete(review.id);
      }
    }

    await tx.done;
  }
}

function normalizeAliasList(name: string, aliases: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of aliases) {
    const alias = raw.trim();
    if (!alias) continue;
    if (isRedundantAliasForName(name, out, alias)) continue;
    const normalized = normalizeAlias(alias);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(alias);
  }
  return out;
}
