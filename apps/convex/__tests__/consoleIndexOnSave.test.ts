/**
 * A NOTE SAVED IN THE CONSOLE IS SEARCHABLE BY THE NEXT SEARCH.
 *
 * Before, a console save touched no index at all. The note reached search only
 * when a later pass listed the bucket — which a console search schedules only
 * over an index that says it is incomplete — so a note saved beside an older
 * match was missing from every answer that found the older one.
 *
 * The barrier now schedules `indexNotes` behind every single-note operation
 * (`indexChangeOf`), which runs `indexChangedNotes`. These tests drive that
 * function directly over a converged index, with the same query matching an
 * older note so a miss-refresh cannot be what finds the new one.
 *
 * Sabotage: making `indexChangedNotes` return without running its pass fails
 * the first two tests.
 */

import { describe, expect, test } from "vitest";
import { clearanceOf } from "../functions/lib/clearance";
import { indexChangeOf } from "../functions/lib/filesFns/access";
import {
  type FileStore,
  indexChangedNotes,
  maintainSearchIndex,
  movePath,
  searchNotes,
  writeFile,
} from "../functions/lib/fileOps";
import { attachQueueMove } from "../functions/lib/nodes/moveBarrier";
import { sqliteProjection } from "./sqliteProjection.helpers";
import { type KeyedBucket, keyedBucket } from "./fileOps/keyedFixture.fileops1.helpers";

/**
 * A keyed workspace with an index converged over `2-areas/older.md`. Writes and
 * moves go through the id layer, as the product's do, so a note is found by its
 * name and its bytes sit at their key.
 */
async function indexed(): Promise<KeyedBucket> {
  const f = await keyedBucket({
    "index.md": "# Context\n",
    "2-areas/older.md": "# Older\n\nA narwhalist was here once.\n",
  });
  for (let pass = 0; pass < 10; pass += 1) {
    if ((await maintainSearchIndex(f.store)).complete) break;
  }
  return f;
}

const owner = clearanceOf("private");

async function found(store: FileStore): Promise<string[]> {
  const answer = await searchNotes(store, { query: "narwhalist", clearance: owner, refreshOnMiss: false });
  return answer.hits.map((hit) => hit.path).sort();
}

/**
 * The barrier's move seam with the search projection attached, as
 * `fileOperationBarrier.ts` attaches it: a keyed move follows the projection
 * inside the move (`settleRowMove`), and says it did not queue.
 */
function moveWithProjection(f: KeyedBucket, database: ReturnType<typeof sqliteProjection>): void {
  attachQueueMove(f.ctx, { workspaceId: f.workspaceId, scope: "private", operation: { kind: "move" } } as never, f.store, f.store, database.client as never);
}

describe("indexing on save", () => {
  test("a written note is found by the next search, beside the older match", async () => {
    const f = await indexed();
    const operation = { kind: "write" as const, path: "2-areas/fresh.md", text: "# Fresh\n\nA second narwhalist.\n" };
    await writeFile(f.store, { path: operation.path, text: operation.text, clearance: owner, now: Date.now() });
    const change = indexChangeOf(operation);
    expect(change).toEqual({ written: ["2-areas/fresh.md"], gone: [] });
    await indexChangedNotes(f.store, change!);
    expect(await found(f.store)).toEqual(["2-areas/fresh.md", "2-areas/older.md"]);
  });

  test("a moved note is found at its new path and not at its old one", async () => {
    const f = await indexed();
    const operation = { kind: "move" as const, from: "2-areas/older.md", to: "2-areas/renamed.md" };
    await movePath(f.store, { from: operation.from, to: operation.to, clearance: owner, now: Date.now() });
    await indexChangedNotes(f.store, indexChangeOf(operation)!);
    expect(await found(f.store)).toEqual(["2-areas/renamed.md"]);
  });

  test("folder-wide and read-only operations schedule nothing", () => {
    expect(indexChangeOf({ kind: "list", path: "2-areas" })).toBeNull();
    expect(indexChangeOf({ kind: "maintainIndex" })).toBeNull();
    expect(indexChangeOf({ kind: "indexNotes", written: ["a.md"], gone: [] })).toBeNull();
    expect(indexChangeOf({ kind: "delete", path: "2-areas/older.md", confirmation: "x" })).toEqual({
      written: [],
      gone: ["2-areas/older.md"],
    });
  });
});

/*
 * AND THE SAME CHANGE REACHES A `ready` FAST SEARCH DATABASE.
 *
 * Measured on production on 2026-10-13: a moved note was found by search at
 * its old path, which no longer opens, and not at its new one, minutes later.
 * A ready projection's miss is the answer, and a console rename or move only
 * ever touched the R2 index. These run `indexChangedNotes` with a projection
 * over real SQLite (`node:sqlite`, the FTS5 D1 runs), seeded as a converged
 * database would be.
 *
 * Sabotage: `indexChangedNotes` ignoring its projection fails the first two;
 * `movedBy` dropping its `queued` check fails the last.
 */
describe("following a change into a ready fast search database", () => {
  test("a renamed note leaves its old path and is projected at its new one", async () => {
    const f = await indexed();
    const database = sqliteProjection();
    database.seed("2-areas/older.md", "# Older\n\nA narwhalist was here once.\n");
    moveWithProjection(f, database);
    const operation = { kind: "move" as const, from: "2-areas/older.md", to: "2-areas/renamed.md" };
    const moved = await movePath(f.store, { from: operation.from, to: operation.to, clearance: owner, now: Date.now() });
    // A keyed move has already followed the projection inside the move (`settleRowMove`), so the change
    // says it is queued and nothing is followed twice. The projection below is what proves it followed.
    const change = indexChangeOf(operation, { kind: "moved", ...moved });
    expect(change?.queued).toBe(true);
    await indexChangedNotes(f.store, change!, database.client);
    expect(database.paths()).toEqual(["2-areas/renamed.md"]);
  });

  test("a moved folder's notes are renamed in place", async () => {
    const f = await indexed();
    await f.store.put("2-areas/trip/day.md", "# Day\n\nA narwhalist sighting.\n");
    const database = sqliteProjection();
    database.seed("2-areas/older.md", "# Older\n\nA narwhalist was here once.\n");
    database.seed("2-areas/trip/day.md", "# Day\n\nA narwhalist sighting.\n");
    moveWithProjection(f, database);
    const operation = { kind: "move" as const, from: "2-areas/trip", to: "2-areas/journey" };
    const moved = await movePath(f.store, { from: operation.from, to: operation.to, clearance: owner, now: Date.now() });
    await indexChangedNotes(f.store, indexChangeOf(operation, { kind: "moved", ...moved })!, database.client);
    expect(database.paths()).toEqual(["2-areas/journey/day.md", "2-areas/older.md"]);
  });

  test("a queued folder move is not followed until its copy lands", async () => {
    const f = await indexed();
    const database = sqliteProjection();
    database.seed("2-areas/trip/day.md", "# Day\n\nA narwhalist sighting.\n");
    const operation = { kind: "move" as const, from: "2-areas/trip", to: "2-areas/journey" };
    const change = indexChangeOf(operation, { kind: "moved", from: "2-areas/trip", to: "2-areas/journey", paths: ["2-areas/journey"], queued: 1 });
    expect(change?.queued).toBe(true);
    await indexChangedNotes(f.store, change!, database.client);
    expect(database.paths()).toEqual(["2-areas/trip/day.md"]);
  });
});
