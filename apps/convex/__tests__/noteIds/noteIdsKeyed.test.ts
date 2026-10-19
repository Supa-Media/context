/**
 * The keyed rows' internal functions (`functions/noteIdsKeyed.ts`): what the
 * tree answers for a path (`notesFor`), and the three writes a keyed workspace
 * makes from the store seam (`adoptKeyed`, `recordKeyed`, `removeKeyed`).
 *
 * What is proved:
 *  - `notesFor` answers each state a path can be in (keyed, unkeyed with its
 *    copy, gone, folder), leaves out a path with no row, and answers a path a
 *    reader could not see (no `canSee` here: the store seam resolves it);
 *  - `keyed` is true only when the switch is at `keys` AND the flip has begun;
 *  - `adoptKeyed` creates a keyed row for a new note, and refuses (taken null)
 *    a bad note id, a key that is not the id key of the path, a plumbing path,
 *    a workspace that is not keyed and a note id a row already holds;
 *  - `adoptKeyed` answers `taken` with the entry of whatever holds the name:
 *    an unkeyed file, another keyed note, a folder, or a tombstone newer than
 *    the write;
 *  - `recordKeyed` and `removeKeyed` act only on a live keyed row whose
 *    `storageKey` is the key given;
 *  - a write's time is never taken from the future (clamped to the server's);
 *  - a keyed write that changes the note is its upload time (`uploaded`), so
 *    "changed since" readers see it; the same bytes again move nothing.
 *
 * Sabotage (temporary local edits, reverted): each guard named in the test
 * titles, removed one at a time, makes its case fail.
 */

import { describe, expect, test } from "vitest";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { idKeyFor } from "../../functions/lib/nodes/noteIds";
import { ensureCopyRow } from "../../functions/lib/noteIds/state";
import { boundWorkspace, rowAt, tester, type T } from "./noteIds.helpers";

const A = "0190a000-0000-7000-8000-00000000000a";
const B = "0190a000-0000-7000-8000-00000000000b";
const C = "0190a000-0000-7000-8000-00000000000c";
const PLAIN = "1-projects/plain.md";
const SECRET = "1-projects/secret/codes.md";

/** The switch at `keys`, and the flip begun (`keyedAt`): a keyed workspace. */
async function keyedWorkspace(t: T, ws: Id<"workspaces">) {
  await t.run(async (ctx) => {
    const layout = await ctx.db.query("noteIdLayout").first();
    if (layout === null) await ctx.db.insert("noteIdLayout", { paused: false, mode: "keys", updatedAt: 1, updatedBy: "test" });
    else await ctx.db.patch(layout._id, { mode: "keys" });
    const copies = await ensureCopyRow(ctx, ws);
    await ctx.db.patch(copies._id, { keyedAt: 1 });
  });
}

/** Bucket rows, observed as the sweep would see them (unkeyed). */
async function observed(t: T, ws: Id<"workspaces">, paths: string[], at = 10) {
  await t.mutation(internal.functions.nodes.observe, {
    workspaceId: ws,
    at,
    rows: paths.map((path) => ({ path, etag: `e-${path}`, size: 3, uploaded: 1 })),
    gone: [],
    vanishedUnder: [],
  });
}

async function notes(t: T, ws: Id<"workspaces">, paths: string[]) {
  return await t.query(internal.functions.noteIdsKeyed.notesFor, { workspaceId: ws, paths });
}

async function adopt(
  t: T,
  ws: Id<"workspaces">,
  path: string,
  noteId: string,
  options: { key?: string; etag?: string; size?: number; at?: number } = {},
) {
  return await t.mutation(internal.functions.noteIdsKeyed.adoptKeyed, {
    workspaceId: ws,
    path,
    noteId,
    key: options.key ?? idKeyFor(noteId, path),
    etag: options.etag ?? `k-${noteId}`,
    ...(options.size === undefined ? {} : { size: options.size }),
    at: options.at ?? 100,
  });
}

describe("notesFor: what the tree says about each path", () => {
  test("a keyed live row answers its note, its key and the key's version", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "keyed-notes-a");
    await keyedWorkspace(t, ws);
    await adopt(t, ws, PLAIN, A, { etag: "k1", size: 9 });
    const answer = await notes(t, ws, [PLAIN]);
    expect(answer).toEqual({
      keyed: true,
      notes: [{ path: PLAIN, state: "keyed", noteId: A, key: `notes/${A}.md`, etag: "k1", size: 9 }],
    });
  });

  test("a keyed row flipped from a path carries the path's etag as legacyEtag only while the key's etag is unchanged", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "keyed-notes-legacy");
    await keyedWorkspace(t, ws);
    await adopt(t, ws, PLAIN, A, { etag: "k1" });
    const id = (await rowAt(t, ws, PLAIN))!._id;
    await t.run(async (ctx) => {
      await ctx.db.patch(id, { keyedFrom: { pathEtag: "path-1", keyEtag: "k1" } });
    });
    const same = await notes(t, ws, [PLAIN]);
    expect(same.notes[0]).toMatchObject({ state: "keyed", etag: "k1", legacyEtag: "path-1" });
    await t.run(async (ctx) => {
      await ctx.db.patch(id, { etag: "k2" });
    });
    const moved = await notes(t, ws, [PLAIN]);
    expect(moved.notes[0]).toMatchObject({ state: "keyed", etag: "k2" });
    expect(moved.notes[0]).not.toHaveProperty("legacyEtag");
  });

  test("an unkeyed live file answers its id key, its copy's etag and whether the copy is fresh", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "keyed-notes-path");
    await observed(t, ws, [PLAIN]);
    await keyedWorkspace(t, ws);
    const row = await rowAt(t, ws, PLAIN);
    await t.run(async (ctx) => {
      await ctx.db.patch(row!._id, {
        noteId: A,
        idCopy: { key: `notes/${A}.md`, etag: `e-${PLAIN}`, copiedAt: 1, keyEtag: "ke" },
      });
    });
    expect((await notes(t, ws, [PLAIN])).notes).toEqual([
      { path: PLAIN, state: "path", key: `notes/${A}.md`, etag: `e-${PLAIN}`, keyEtag: "ke", fresh: true },
    ]);
  });

  test("a trashed file answers gone, a live folder answers folder, and a path with no row is left out", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "keyed-notes-states");
    await observed(t, ws, [PLAIN, SECRET]);
    await keyedWorkspace(t, ws);
    await t.mutation(internal.functions.nodes.observe, {
      workspaceId: ws,
      at: 20,
      rows: [],
      gone: [PLAIN],
      vanishedUnder: [],
    });
    const answer = await notes(t, ws, [PLAIN, "1-projects", "1-projects/secret", "1-projects/none.md"]);
    expect(answer.notes).toEqual([
      { path: PLAIN, state: "gone" },
      { path: "1-projects", state: "folder" },
      { path: "1-projects/secret", state: "folder" },
    ]);
  });

  test("a folder retired as empty answers gone, so a note may take its name", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "keyed-notes-retired");
    await observed(t, ws, [SECRET]);
    await keyedWorkspace(t, ws);
    await t.mutation(internal.functions.nodes.observe, { workspaceId: ws, at: 20, rows: [], gone: [SECRET], vanishedUnder: [] });
    const answer = await notes(t, ws, ["1-projects/secret"]);
    expect(answer.notes).toEqual([{ path: "1-projects/secret", state: "gone" }]);
  });

  test("a path a reader could not see is answered all the same: no privacy filter applies here", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "keyed-notes-hidden");
    await keyedWorkspace(t, ws);
    await adopt(t, ws, SECRET, A);
    expect((await notes(t, ws, [SECRET])).notes).toEqual([
      expect.objectContaining({ path: SECRET, state: "keyed", noteId: A }),
    ]);
  });

  test("keyed is false while the switch is not at keys, or the flip has not begun", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "keyed-notes-flag");
    await adopt(t, ws, PLAIN, A);
    expect((await notes(t, ws, [PLAIN])).keyed).toBe(false);
    await t.run(async (ctx) => {
      await ctx.db.insert("noteIdLayout", { paused: false, mode: "keys", updatedAt: 1, updatedBy: "test" });
    });
    expect((await notes(t, ws, [PLAIN])).keyed).toBe(false);
    await keyedWorkspace(t, ws);
    expect((await notes(t, ws, [PLAIN])).keyed).toBe(true);
  });
});

describe("adoptKeyed: a new note gets its row at its own id key", () => {
  test("a new path in a keyed workspace gets a keyed row under the note's id, with the key's etag and size", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "adopt-happy");
    await keyedWorkspace(t, ws);
    expect(await adopt(t, ws, PLAIN, A, { etag: "k1", size: 12 })).toEqual({ adopted: true });
    const row = await rowAt(t, ws, PLAIN);
    expect(row).toMatchObject({ noteId: A, storageKey: `notes/${A}.md`, etag: "k1", size: 12 });
    expect(row!.goneAt).toBeUndefined();
  });

  test("the folders of a new path are made with it", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "adopt-folders");
    await keyedWorkspace(t, ws);
    await adopt(t, ws, SECRET, A);
    expect((await rowAt(t, ws, "1-projects"))?.kind).toBe("folder");
    expect((await rowAt(t, ws, "1-projects/secret"))?.kind).toBe("folder");
  });

  test("a name an unkeyed file holds is taken: nothing changes, and the file's entry is answered", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "adopt-taken-path");
    await observed(t, ws, [PLAIN]);
    await keyedWorkspace(t, ws);
    const before = await rowAt(t, ws, PLAIN);
    const answer = await adopt(t, ws, PLAIN, A);
    expect(answer).toEqual({
      adopted: false,
      taken: { path: PLAIN, state: "path", key: idKeyFor(before!.noteId!, PLAIN), etag: null, keyEtag: null, fresh: false },
    });
    expect(await rowAt(t, ws, PLAIN)).toMatchObject({ kind: "file", etag: `e-${PLAIN}`, noteId: before!.noteId });
  });

  test("a name another keyed note holds is taken, and that note is answered", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "adopt-taken-note");
    await keyedWorkspace(t, ws);
    await adopt(t, ws, PLAIN, A, { etag: "k1" });
    const answer = await adopt(t, ws, PLAIN, B, { etag: "k2" });
    expect(answer).toEqual({
      adopted: false,
      taken: { path: PLAIN, state: "keyed", noteId: A, key: `notes/${A}.md`, etag: "k1" },
    });
    expect(await rowAt(t, ws, PLAIN)).toMatchObject({ noteId: A, etag: "k1" });
  });


  test("a name a folder holds is taken, and the folder is answered", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "adopt-taken-folder");
    await observed(t, ws, [SECRET]);
    await keyedWorkspace(t, ws);
    const answer = await adopt(t, ws, "1-projects/secret", A);
    expect(answer).toEqual({ adopted: false, taken: { path: "1-projects/secret", state: "folder" } });
  });

  test("a tombstone newer than the write holds the name: adopted false, answered gone", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "adopt-tombstone");
    await observed(t, ws, [PLAIN]);
    await keyedWorkspace(t, ws);
    await t.mutation(internal.functions.nodes.observe, { workspaceId: ws, at: 100, rows: [], gone: [PLAIN], vanishedUnder: [] });
    expect(await adopt(t, ws, PLAIN, A, { at: 50 })).toEqual({ adopted: false, taken: { path: PLAIN, state: "gone" } });
  });

  test("a tombstone older than the write is replaced: the name is the new note", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "adopt-old-tombstone");
    await observed(t, ws, [PLAIN]);
    await keyedWorkspace(t, ws);
    await t.mutation(internal.functions.nodes.observe, { workspaceId: ws, at: 50, rows: [], gone: [PLAIN], vanishedUnder: [] });
    expect(await adopt(t, ws, PLAIN, A, { at: 200 })).toEqual({ adopted: true });
    expect(await rowAt(t, ws, PLAIN)).toMatchObject({ noteId: A });
    expect((await rowAt(t, ws, PLAIN))!.goneAt).toBeUndefined();
  });

  test("a time from the future is clamped to the server's, so a row cannot be kept from every later observation", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "adopt-clamp");
    await keyedWorkspace(t, ws);
    const far = Date.now() + 10 ** 12;
    await adopt(t, ws, PLAIN, A, { at: far });
    const row = await rowAt(t, ws, PLAIN);
    expect(row!.observedAt).toBeLessThanOrEqual(Date.now());
  });

  test("refused for a note id that is not a UUIDv7, or a key that is not the path's id key: taken null, no row", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "adopt-refuse");
    await keyedWorkspace(t, ws);
    expect(await adopt(t, ws, PLAIN, "not-an-id", { key: `notes/not-an-id.md` })).toEqual({ adopted: false, taken: null });
    expect(await adopt(t, ws, PLAIN, A, { key: `notes/${B}.md` })).toEqual({ adopted: false, taken: null });
    expect(await adopt(t, ws, PLAIN, A, { key: `files/${A}.txt` })).toEqual({ adopted: false, taken: null });
    expect(await rowAt(t, ws, PLAIN)).toBeNull();
  });

  test("refused for a plumbing path, whatever key is given: taken null, no row", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "adopt-plumbing");
    await keyedWorkspace(t, ws);
    expect(await adopt(t, ws, "privacy.md", A)).toEqual({ adopted: false, taken: null });
    expect(await adopt(t, ws, ".context/x.md", B)).toEqual({ adopted: false, taken: null });
    expect(await rowAt(t, ws, "privacy.md")).toBeNull();
  });

  test("refused in a workspace that is not keyed: on the id switch, and on keys before the flip", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "adopt-not-keyed");
    await t.run(async (ctx) => {
      await ctx.db.insert("noteIdLayout", { paused: false, mode: "ids", updatedAt: 1, updatedBy: "test" });
    });
    expect(await adopt(t, ws, PLAIN, A)).toEqual({ adopted: false, taken: null });
    await t.run(async (ctx) => {
      const layout = await ctx.db.query("noteIdLayout").first();
      await ctx.db.patch(layout!._id, { mode: "keys" });
    });
    expect(await adopt(t, ws, PLAIN, A)).toEqual({ adopted: false, taken: null });
    expect(await rowAt(t, ws, PLAIN)).toBeNull();
  });

  test("refused when another row in the workspace already holds that note id: taken null", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "adopt-duplicate");
    await keyedWorkspace(t, ws);
    await adopt(t, ws, PLAIN, A);
    const other = "1-projects/other.md";
    expect(await adopt(t, ws, other, A)).toEqual({ adopted: false, taken: null });
    expect(await rowAt(t, ws, other)).toBeNull();
  });

  test("the same note's own row is no duplicate: a retried adoption is accepted", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "adopt-retry");
    await keyedWorkspace(t, ws);
    await adopt(t, ws, PLAIN, A, { etag: "k1" });
    expect(await adopt(t, ws, PLAIN, A, { etag: "k1", at: 200 })).toEqual({ adopted: true });
  });
});

describe("recordKeyed and removeKeyed: only a keyed row, at its own key", () => {
  test("recordKeyed takes the key's new version and size for a live keyed row of that key", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "record-ok");
    await keyedWorkspace(t, ws);
    await adopt(t, ws, PLAIN, A, { etag: "k1" });
    const recorded = await t.mutation(internal.functions.noteIdsKeyed.recordKeyed, {
      workspaceId: ws,
      path: PLAIN,
      key: `notes/${A}.md`,
      etag: "k2",
      size: 40,
      at: 300,
    });
    expect(recorded).toBe(true);
    expect(await rowAt(t, ws, PLAIN)).toMatchObject({ etag: "k2", size: 40, storageKey: `notes/${A}.md` });
  });

  test("a keyed write is the note's upload time, so the tree's updatedAt moves when the note changes", async () => {
    // Production, 2026-10-19: a keyed write cleared `uploaded`, so Tex's check-in
    // read every synced email day as unchanged and said "nothing changed".
    const t = tester();
    const ws = await boundWorkspace(t, "record-uploaded");
    await keyedWorkspace(t, ws);
    await adopt(t, ws, PLAIN, A, { etag: "k1", at: 100 });
    expect(await rowAt(t, ws, PLAIN)).toMatchObject({ uploaded: 100 });
    const record = (etag: string, at: number) =>
      t.mutation(internal.functions.noteIdsKeyed.recordKeyed, { workspaceId: ws, path: PLAIN, key: `notes/${A}.md`, etag, size: 40, at });
    expect(await record("k2", 300)).toBe(true);
    expect(await rowAt(t, ws, PLAIN)).toMatchObject({ etag: "k2", uploaded: 300 });
    // The same bytes written again are no change.
    expect(await record("k2", 400)).toBe(true);
    expect(await rowAt(t, ws, PLAIN)).toMatchObject({ etag: "k2", uploaded: 300 });
  });

  test("recordKeyed refuses a key that is not the row's storageKey, an unkeyed row and a path with no row", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "record-refuse");
    await observed(t, ws, ["1-projects/unkeyed.md"]);
    await keyedWorkspace(t, ws);
    await adopt(t, ws, PLAIN, A, { etag: "k1" });
    const record = (path: string, key: string) =>
      t.mutation(internal.functions.noteIdsKeyed.recordKeyed, { workspaceId: ws, path, key, etag: "k9", at: 300 });
    expect(await record(PLAIN, `notes/${B}.md`)).toBe(false);
    expect(await record("1-projects/unkeyed.md", `notes/${A}.md`)).toBe(false);
    expect(await record("1-projects/none.md", `notes/${A}.md`)).toBe(false);
    expect(await rowAt(t, ws, PLAIN)).toMatchObject({ etag: "k1" });
  });

  test("removeKeyed tombstones a live keyed row of that key, and the note is gone from the tree", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "remove-ok");
    await keyedWorkspace(t, ws);
    await adopt(t, ws, PLAIN, A);
    const removed = await t.mutation(internal.functions.noteIdsKeyed.removeKeyed, {
      workspaceId: ws,
      path: PLAIN,
      key: `notes/${A}.md`,
      at: 300,
    });
    expect(removed).toBe(true);
    expect((await notes(t, ws, [PLAIN])).notes).toEqual([{ path: PLAIN, state: "gone" }]);
  });

  test("removeKeyed refuses a key that is not the row's storageKey, and an unkeyed row stays live", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "remove-refuse");
    await observed(t, ws, ["1-projects/unkeyed.md"]);
    await keyedWorkspace(t, ws);
    await adopt(t, ws, PLAIN, A);
    const remove = (path: string, key: string) =>
      t.mutation(internal.functions.noteIdsKeyed.removeKeyed, { workspaceId: ws, path, key, at: 300 });
    expect(await remove(PLAIN, `notes/${B}.md`)).toBe(false);
    expect(await remove("1-projects/unkeyed.md", `notes/${A}.md`)).toBe(false);
    expect((await rowAt(t, ws, PLAIN))!.goneAt).toBeUndefined();
    expect((await rowAt(t, ws, "1-projects/unkeyed.md"))!.goneAt).toBeUndefined();
  });

  test("a note removed and then written again is a new note under a new id", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "remove-readd");
    await keyedWorkspace(t, ws);
    await adopt(t, ws, PLAIN, A);
    await t.mutation(internal.functions.noteIdsKeyed.removeKeyed, { workspaceId: ws, path: PLAIN, key: `notes/${A}.md`, at: 300 });
    expect(await adopt(t, ws, PLAIN, C, { at: 400 })).toEqual({ adopted: true });
    expect(await rowAt(t, ws, PLAIN)).toMatchObject({ noteId: C, storageKey: `notes/${C}.md` });
    expect((await rowAt(t, ws, PLAIN))!.goneAt).toBeUndefined();
  });
});
