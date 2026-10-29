/**
 * AN ACCESS CHANGE MOVES A NOTE'S FAST SEARCH ROWS TO ITS NEW TIER.
 *
 * Found 2026-10-29 in a CASA setup: a fresh note in a new workspace, opened to
 * the team, was read by a team-tier connection, and a search for its exact
 * title found nothing. Fast search keeps each note's rows in a tier table,
 * and a team caller is scored against the team table only. An access change
 * touches no text and no version, and the sweep re-projects only a version it
 * does not hold, so nothing ever moved the rows.
 *
 * Now every console access change (`rowsChange` in `lib/filesFns/visibility.ts`)
 * schedules `indexNotes` with the path as `retiered`, and `indexChangedNotes`
 * follows it into a ready database with no read (`search/d1/follow.js`).
 *
 * Sabotage (run by hand, each fails a test here): dropping the schedule in
 * `rowsChange` fails the first; `followInProjection` not passing `retiered`
 * fails the second; the empty-change guard in `indexChangedNotes` removed
 * fails the third.
 */

import { describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { asUser } from "./fixtures.helpers";
import { fixture, writeNote } from "./website.helpers";
import { indexChangedNotes } from "../functions/lib/fileOps";
import { sqliteProjection } from "./sqliteProjection.helpers";
import { keyedBucket } from "./fileOps/keyedFixture.fileops1.helpers";
import type { FileStore } from "../functions/lib/fileOps";

/** The store, with every key it is asked to read or write noted. */
function watched(store: FileStore): { store: FileStore; reads: string[]; writes: string[] } {
  const reads: string[] = [];
  const writes: string[] = [];
  const proxy = new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (property === "get") return (key: string, ...rest: unknown[]) => (reads.push(key), value.call(target, key, ...rest));
      if (property === "put") return (key: string, ...rest: unknown[]) => (writes.push(key), value.call(target, key, ...rest));
      return value.bind(target);
    },
  });
  return { store: proxy, reads, writes };
}

vi.setConfig({ testTimeout: 30_000 });

describe("an access change follows into fast search", () => {
  test("a note's visibility change schedules a tier follow for that path", async () => {
    const f = await fixture();
    await writeNote(f, "2-areas/zap synthetic note.md", "# zap synthetic note\n\nquokka\n");
    const before = await f.t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).length);
    await asUser(f.t, f.owner).action(api.functions.files.setNoteVisibility, {
      workspaceId: f.workspaceId,
      path: "2-areas/zap synthetic note.md",
      visibility: "team",
    });
    const jobs = await f.t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).slice(before));
    const follows = jobs
      .map((job) => (job.args[0] as { operation?: { kind?: string; retiered?: string[]; written?: string[]; gone?: string[] } }).operation)
      .filter((operation) => operation?.kind === "indexNotes");
    expect(follows).toEqual([{ kind: "indexNotes", written: [], gone: [], retiered: ["2-areas/zap synthetic note.md"] }]);
  });

  test("a note whose tier changed moves to it in a ready database, with no read", async () => {
    // The fixture's rules hold `2-areas` private. Projected while it was team (the same
    // move a note opened to the team takes the other way, `apps/mcp/test/searchFollow.test.mjs`).
    const f = await keyedBucket({ "2-areas/zap synthetic note.md": "# zap synthetic note\n\nquokka\n" });
    const database = sqliteProjection();
    database.seed("2-areas/zap synthetic note.md", "# zap synthetic note\n\nquokka\n", "team");
    const { store, reads } = watched(f.store);
    await indexChangedNotes(store, { written: [], gone: [], retiered: ["2-areas/zap synthetic note.md"] }, database.client);
    expect(database.tiers()).toEqual({ "2-areas/zap synthetic note.md": "private" });
    // The rules are read; the note is not.
    expect(reads.filter((key) => key.includes("zap") || key.startsWith("notes/"))).toEqual([]);
  });

  test("an access change alone starts no pass over the bucket's own index", async () => {
    const f = await keyedBucket({ "2-areas/a.md": "# A\n" });
    const { store, reads, writes } = watched(f.store);
    const pass = await indexChangedNotes(store, { written: [], gone: [], retiered: ["2-areas/a.md"] });
    expect(pass).toEqual({ pending: 0, changed: false, complete: true, shed: 0, oversizedShards: 0 });
    expect(reads).toEqual([]);
    expect(writes).toEqual([]);
  });
});
