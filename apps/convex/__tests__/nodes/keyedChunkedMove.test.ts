/**
 * A keyed folder move bigger than one transaction (`lib/nodes/rowMoveChunks.ts`):
 * the root moves at once and the rows beneath follow in pages of `ROW_MOVE_PAGE`.
 *
 * Runs the real functions through `convex-test`. Each case fails if its guard
 * is removed:
 *  - the chunked branch (`too_large` again: a 1,200-row rename refused);
 *  - the listing fold through a moving keyed move (`drawnMoves`: notes left at
 *    the old name vanish from the folder mid-move);
 *  - the id layer's lookup through it (`throughRowMoves`: a note asked for by
 *    the name people see is not found mid-move);
 *  - the access copies (`withMovingAccess`: rows not yet moved out of a private
 *    folder read as their old parent's, `team`);
 *  - the file-mode rules guard (`rules_changed`: a page moves rows the rules
 *    changed under);
 *  - the watchdog and the resume (`continueRowMove`, `rowMoveFor`: a move whose
 *    request stopped is never finished);
 *  - the overlap check (`overlapsRowMove`: a second move inside the moving one lands);
 *  - the page size (`ROW_MOVE_PAGE`: a page of `ROW_MOVE_MAX` linked notes went past
 *    the reads one function may make, and the move stopped for good).
 */

import { describe, expect, test } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { rulesForReaders } from "../../functions/lib/nodes/readerRules";
import { canSee } from "../../functions/lib/privacy";
import { OWNER, listed, start } from "./moveFixture.helpers";
import { setFolderVisibility } from "../../functions/lib/fileOps";
import { touchNodesNow } from "../../functions/lib/nodes/run";
import { PRIVACY_KEY } from "../../functions/lib/privacy";
import { NOTE_ID, keyedFixture, privacyEtag, rowOf, treeOf } from "./keyedFixture.helpers";
import { ROW_MOVE_PAGE } from "../../functions/lib/nodes/rowMoveChunks";

type Fixture = Awaited<ReturnType<typeof keyedFixture>>;

const FILES = 1_200;
const FROM = "1-projects/big";
const TO = "3-resources/big";

/** `FROM` under `1-projects` with a subfolder and `FILES` keyed files, every row with its real parent. */
async function bigTree(f: Fixture): Promise<void> {
  await f.t.run(async (ctx) => {
    const parent = await ctx.db
      .query("nodes")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", f.ws).eq("path", "1-projects"))
      .unique();
    const folder = await ctx.db.insert("nodes", {
      workspaceId: f.ws,
      noteId: NOTE_ID(5000),
      path: FROM,
      parentId: parent?._id,
      name: "big",
      kind: "folder",
      observedAt: 1,
    });
    const sub = await ctx.db.insert("nodes", {
      workspaceId: f.ws,
      noteId: NOTE_ID(5001),
      path: `${FROM}/sub`,
      parentId: folder,
      name: "sub",
      kind: "folder",
      observedAt: 1,
    });
    for (let index = 0; index < FILES; index += 1) {
      const inSub = index % 10 === 0;
      const name = `n${String(index).padStart(4, "0")}.md`;
      await ctx.db.insert("nodes", {
        workspaceId: f.ws,
        noteId: NOTE_ID(10_000 + index),
        path: inSub ? `${FROM}/sub/${name}` : `${FROM}/${name}`,
        parentId: inSub ? sub : folder,
        name,
        kind: "file",
        etag: "e",
        observedAt: 1,
        storageKey: `notes/${NOTE_ID(10_000 + index)}.md`,
      });
    }
  });
}

/** Every live row's path by note id. */
async function liveByNoteId(f: Fixture): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  for (const row of await treeOf(f)) {
    if (!row.live || row.noteId === undefined) continue;
    found.set(row.noteId, [...(found.get(row.noteId) ?? []), row.path]);
  }
  return found;
}

/** Whether a team member may see each path, by the rules readers judge by now. */
async function teamSees(f: Fixture, paths: string[]): Promise<boolean[]> {
  return await f.t.run(async (ctx) => {
    const judged = await rulesForReaders(ctx, f.ws);
    return paths.map((path) => canSee(path, "team", judged.rules, judged.overrides));
  });
}

/** The first mutation of a chunked move, as the request makes it. */
async function begin(f: Fixture, from = FROM, to = TO) {
  const answer = await f.t.mutation(internal.functions.nodeRowMoves.rowMove, {
    workspaceId: f.ws,
    from,
    to,
    privacyEtag: await privacyEtag(f),
    chunk: { scope: "private", grantedNames: [] },
    now: Date.now(),
  });
  expect(answer).toMatchObject({ ok: true, kind: "folder" });
  const id = (answer as { chunked?: Id<"rowMoves"> }).chunked;
  expect(id).toBeDefined();
  return id as Id<"rowMoves">;
}

const page = (f: Fixture, id: Id<"rowMoves">) => f.t.mutation(internal.functions.nodeRowMoves.rowMovePage, { id });

const records = (f: Fixture) => f.t.run(async (ctx) => await ctx.db.query("rowMoves").collect());

/** Every file the tree draws under `folder`, through every subfolder, as the owner lists it. */
async function listedDeep(f: Fixture, folder: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await f.owner.query(api.functions.nodesListing.listFolder, { workspaceId: f.ws, path: folder }).then((l) => l!.entries)) {
    if (entry.kind === "folder") found.push(...(await listedDeep(f, entry.path)));
    else found.push(entry.path);
  }
  return found;
}

describe("a keyed folder over the row cap moves in pages", { timeout: 60_000 }, () => {
  test("a 1,200-note rename completes: every row at the new name, ids, keys and parents kept", async () => {
    const f = await keyedFixture();
    await bigTree(f);
    const before = await liveByNoteId(f);
    const root = await rowOf(f, FROM);
    const sub = await rowOf(f, `${FROM}/sub`);
    await f.t.run(async (ctx) => {
      await ctx.db.insert("nodeLinks", { workspaceId: f.ws, source: `${FROM}/n0001.md`, kind: "path", target: "1-projects/keep.md" });
    });

    const moved = await start(f, FROM, TO);

    expect(moved).toMatchObject({ rowed: true, queued: FILES });
    expect(moved?.moved).toHaveLength(FILES);
    const after = await liveByNoteId(f);
    for (const [noteId, paths] of before) {
      if (!paths[0].startsWith(`${FROM}/`) && paths[0] !== FROM) continue;
      expect(after.get(noteId)).toEqual([`${TO}${paths[0].slice(FROM.length)}`]);
    }
    expect((await treeOf(f)).some((row) => row.live && (row.path === FROM || row.path.startsWith(`${FROM}/`)))).toBe(false);
    expect(await rowOf(f, TO)).toMatchObject({ _id: root._id, name: "big", parentId: (await rowOf(f, "3-resources"))._id });
    expect(await rowOf(f, `${TO}/sub`)).toMatchObject({ _id: sub._id, parentId: root._id });
    expect(await rowOf(f, `${TO}/sub/n0010.md`)).toMatchObject({ parentId: sub._id, storageKey: `notes/${NOTE_ID(10_010)}.md` });
    // The moved note's links say where it is, and the move is over: nothing is left recorded.
    const links = await f.t.run(async (ctx) => await ctx.db.query("nodeLinks").collect());
    expect(links.map((link) => link.source)).toEqual([`${TO}/n0001.md`]);
    expect(await records(f)).toEqual([]);
    expect((await listedDeep(f, TO)).length).toBe(FILES);
  });

  test("mid-move every note is found exactly once, by listing and by either name, at the new name", async () => {
    const f = await keyedFixture();
    await bigTree(f);
    const id = await begin(f);
    expect(await page(f, id)).toMatchObject({ state: "moving" });

    // Split for real: some rows still sit at the old name.
    const tree = await treeOf(f);
    expect(tree.filter((row) => row.live && row.path.startsWith(`${FROM}/`)).length).toBeGreaterThan(0);
    expect(tree.filter((row) => row.live && row.path.startsWith(`${TO}/`)).length).toBeGreaterThan(0);
    for (const paths of (await liveByNoteId(f)).values()) expect(paths).toHaveLength(1);

    const drawn = await listedDeep(f, TO);
    expect(drawn.length).toBe(FILES);
    expect(new Set(drawn).size).toBe(FILES);
    // Each at the name people see, the ones not yet moved included.
    expect(drawn.filter((path) => !path.startsWith(`${TO}/`))).toEqual([]);
    expect(drawn).toContain(`${TO}/n${String(FILES - 1).padStart(4, "0")}.md`);
    expect(await listed(f.owner, f.ws, "1-projects")).not.toContain(FROM);
    expect(await listed(f.owner, f.ws, "3-resources")).toContain(TO);

    // The id layer finds a note not yet moved at the name people see, and a moved one at the name it had.
    const last = `n${String(FILES - 1).padStart(4, "0")}.md`;
    const first = "n0001.md";
    const asked = [`${TO}/${last}`, `${FROM}/${last}`, `${TO}/${first}`, `${FROM}/${first}`];
    const found = await f.t.query(internal.functions.noteIdsKeyed.notesFor, { workspaceId: f.ws, paths: asked });
    expect(found.notes.map((note) => [note.path, "noteId" in note ? note.noteId : null])).toEqual([
      [asked[0], NOTE_ID(10_000 + FILES - 1)],
      [asked[1], NOTE_ID(10_000 + FILES - 1)],
      [asked[2], NOTE_ID(10_001)],
      [asked[3], NOTE_ID(10_001)],
    ]);
  });

  test("rows mode: rows not yet out of a private folder stay private, at both names, mid-move", async () => {
    const f = await keyedFixture();
    await bigTree(f);
    await f.t.mutation(internal.functions.nodesPrivacy.setAccessSource, { workspaceId: f.ws, source: "rows" });
    await f.t.mutation(internal.functions.nodesAccess.setAccess, {
      workspaceId: f.ws,
      path: FROM,
      base: "private",
      actor: { userId: f.ownerId, role: "owner" },
    });
    const answer = await f.t.mutation(internal.functions.nodeRowMoves.rowMove, {
      workspaceId: f.ws,
      from: FROM,
      to: TO,
      privacyEtag: await f.t.query(internal.functions.nodesAccess.privacyEtagNow, { workspaceId: f.ws }),
      chunk: { scope: "private", grantedNames: [] },
      now: Date.now(),
    });
    const id = (answer as { chunked: Id<"rowMoves"> }).chunked;
    await page(f, id);

    const tree = await treeOf(f);
    const unmoved = tree.find((row) => row.live && row.kind === "file" && row.path.startsWith(`${FROM}/`));
    const moved = tree.find((row) => row.live && row.kind === "file" && row.path.startsWith(`${TO}/`));
    expect(unmoved && moved).toBeTruthy();
    expect(await teamSees(f, [unmoved!.path, moved!.path, `${TO}${unmoved!.path.slice(FROM.length)}`])).toEqual([false, false, false]);
    // The folder it left keeps its own rule: a note there is judged as before.
    expect(await teamSees(f, ["1-projects/keep.md"])).toEqual([true]);
    expect(await listed(f.member, f.ws, TO)).toEqual([]);

    while ((await page(f, id)).state !== "done");
    expect(await teamSees(f, [`${TO}/n0001.md`, `${TO}/sub/n0010.md`])).toEqual([false, false]);
  });

  test("file mode: a rule written under the old name mid-move holds the pages until it is carried; asking again carries it", async () => {
    const f = await keyedFixture();
    await bigTree(f);
    const id = await begin(f);
    await page(f, id);
    const midway = await treeOf(f);
    // An owner makes the subfolder private mid-move, at the old name the rules still hold it by.
    await setFolderVisibility(f.store, { path: `${FROM}/sub`, visibility: "private", clearance: OWNER });
    await touchNodesNow(f.ctx, f.ws, f.store, { paths: [], files: [PRIVACY_KEY] });

    expect(await page(f, id)).toMatchObject({ state: "rules_changed", files: [] });
    expect(await treeOf(f)).toEqual(midway);

    // Asked again, the request carries the rules once more and pages to the end: the rule reached the new name.
    const finished = await start(f, FROM, TO);
    expect(finished).toMatchObject({ rowed: true });
    expect((await treeOf(f)).filter((row) => row.live && row.path.startsWith(`${TO}/`) && row.kind === "file")).toHaveLength(FILES);
    expect(await records(f)).toEqual([]);
    expect(await teamSees(f, [`${TO}/sub/n0010.md`, `${TO}/n0001.md`])).toEqual([false, true]);
  });

  test("file mode: a rule changed elsewhere mid-move does not hold the pages", async () => {
    const f = await keyedFixture();
    await bigTree(f);
    const id = await begin(f);
    await page(f, id);
    const before = await privacyEtag(f);
    await setFolderVisibility(f.store, { path: "1-projects/secret", visibility: "team", clearance: OWNER });
    await touchNodesNow(f.ctx, f.ws, f.store, { paths: [], files: [PRIVACY_KEY] });
    expect(await privacyEtag(f)).not.toBe(before);

    expect(await page(f, id)).toMatchObject({ state: "moving" });
  });

  test("a move whose request stopped mid-way is finished by the watchdog, and asking again settles it", async () => {
    const f = await keyedFixture();
    await bigTree(f);
    const id = await begin(f);
    await page(f, id);
    // The request died here. While it was paging, the watchdog waits; once it has been quiet a lease, it pages.
    await f.t.mutation(internal.functions.nodeRowMoves.continueRowMove, { id });
    const waited = await treeOf(f);
    expect(waited.filter((row) => row.live && row.path.startsWith(`${FROM}/`)).length).toBeGreaterThan(0);
    for (let pass = 0; pass < 40 && (await records(f))[0]?.state === "moving"; pass += 1) {
      await f.t.run(async (ctx) => await ctx.db.patch(id, { updatedAt: 0 }));
      await f.t.mutation(internal.functions.nodeRowMoves.continueRowMove, { id });
    }
    expect((await records(f))[0]).toMatchObject({ state: "moved", left: 0 });
    expect((await treeOf(f)).filter((row) => row.live && row.path.startsWith(`${TO}/`) && row.kind === "file")).toHaveLength(FILES);
    for (const paths of (await liveByNoteId(f)).values()) expect(paths).toHaveLength(1);

    // The bucket's side is the request's: asking for the same move again does it and lets the record go.
    await start(f, FROM, TO);
    expect(await records(f)).toEqual([]);
  });

  test("a page moves at most a page of rows, well inside what one function may read", async () => {
    const f = await keyedFixture();
    await bigTree(f);
    const id = await begin(f);
    const first = await page(f, id);
    expect(first.state).toBe("moving");
    expect(first.files.length).toBeGreaterThan(0);
    expect(first.files.length).toBeLessThanOrEqual(ROW_MOVE_PAGE);
    expect(ROW_MOVE_PAGE).toBeLessThanOrEqual(100);
  });

  test("a page run twice, or after the move finished, moves nothing twice", async () => {
    const f = await keyedFixture();
    await bigTree(f);
    const id = await begin(f);
    while ((await page(f, id)).state !== "done");
    const done = await treeOf(f);
    expect(await page(f, id)).toMatchObject({ state: "done", files: [] });
    expect(await treeOf(f)).toEqual(done);
  });

  test("a second move overlapping a moving one is refused, and one elsewhere is not", async () => {
    const f = await keyedFixture();
    await bigTree(f);
    await begin(f);

    await expect(start(f, `${FROM}/n0001.md`, "1-projects/n0001.md")).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(start(f, `${TO}/n0001.md`, "1-projects/n0001.md")).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(start(f, "3-resources", "2-areas")).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(start(f, "1-projects/keep.md", `${TO}/keep.md`)).rejects.toMatchObject({ code: "CONFLICT" });
    // The same folder somewhere else is the move already under way, which is not this one.
    await expect(start(f, FROM, "2-areas/big")).rejects.toMatchObject({ code: "CONFLICT" });

    expect(await start(f, "1-projects/keep.md", "1-projects/kept.md")).toMatchObject({ rowed: true });
  });

  test("a name taken under the new folder mid-move leaves that note at the old name, in a folder there, never lost", async () => {
    const f = await keyedFixture();
    await bigTree(f);
    const id = await begin(f);
    const last = `n${String(FILES - 1).padStart(4, "0")}.md`;
    await f.t.run(async (ctx) => {
      const parent = await ctx.db
        .query("nodes")
        .withIndex("by_workspace_path", (q) => q.eq("workspaceId", f.ws).eq("path", TO))
        .unique();
      await ctx.db.insert("nodes", {
        workspaceId: f.ws,
        noteId: NOTE_ID(9_999),
        path: `${TO}/${last}`,
        parentId: parent!._id,
        name: last,
        kind: "file",
        observedAt: 1,
        storageKey: `notes/${NOTE_ID(9_999)}.md`,
      });
    });

    let answer;
    do answer = await page(f, id);
    while (answer.state !== "done");

    expect(answer.left).toBe(1);
    const stayed = await rowOf(f, `${FROM}/${last}`);
    expect(stayed).toMatchObject({ noteId: NOTE_ID(10_000 + FILES - 1) });
    const folder = await rowOf(f, FROM);
    expect(folder.goneAt).toBeUndefined();
    expect(stayed.parentId).toBe(folder._id);
    expect(await rowOf(f, `${TO}/${last}`)).toMatchObject({ noteId: NOTE_ID(9_999) });
    expect(await listed(f.owner, f.ws, FROM)).toEqual([`${FROM}/${last}`]);
  });
});

describe("the old cap still holds where a move must land whole", { timeout: 60_000 }, () => {
  test("without a chunk the mutation refuses a folder over the cap as too large", async () => {
    const f = await keyedFixture();
    await bigTree(f);
    const before = await treeOf(f);
    const answer = await f.t.mutation(internal.functions.nodeRowMoves.rowMove, {
      workspaceId: f.ws,
      from: FROM,
      to: TO,
      privacyEtag: await privacyEtag(f),
      now: Date.now(),
    });
    expect(answer).toEqual({ ok: false, reason: "too_large" });
    expect(await treeOf(f)).toEqual(before);
  });
});
