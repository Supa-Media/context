/**
 * A keyed trash and restore carry the note's collaboration history with its
 * row (`notes-by-id.md`, "Trash and Restore"), and the two operations that
 * would delete a path permanently, `removeNewFolder` and a plugin's delete,
 * trash its rows instead in a keyed workspace.
 *
 * Each case fails if its guard is removed:
 *  - the carry in `startRowTrash` (the head stays active at the old name, and the
 *    new note there inherits it);
 *  - the carry in `restoreRowTrash` (the restored note starts a new document);
 *  - the best-effort catch in `carryRowHistory` (a failed rename fails the trash);
 *  - the keyed branch in `removeNewFolder` (the undo is refused as keyed);
 *  - the keyed branch in `executeOperation`'s `pluginDelete` (refused, or deleted permanently);
 *  - the non-keyed `pluginDelete`, which must still delete permanently.
 */

import { readDocument } from "@context/collaboration";
import { describe, expect, test, vi } from "vitest";
import { executeOperation } from "../../functions/lib/filesFns/executeOperation";
import { renderNewFolderAbout } from "../../functions/lib/fileOps/folders";
import { readFile } from "../../functions/lib/fileOps/reading";
import { attachQueueMove } from "../../functions/lib/nodes/moveBarrier";
import { attachTreeListing } from "../../functions/lib/nodes/treeNames";
import { attachWorkspaceKeyed } from "../../functions/lib/noteIds/keyedStore";
import { OWNER, fixture, type Fixture } from "./moveFixture.helpers";
import { NOTE_ID, keyedFixture, liveAt, rowOf, treeOf } from "./keyedFixture.helpers";

const KEEP = "1-projects/keep.md";

type Moved = { kind: "moved"; from: string; to: string; paths: string[] };
type Deleted = { kind: "deleted"; paths: string[] };

/** Run one operation through the barrier's seams, as `fileOperationBarrier.ts` attaches them. */
function operate(f: Fixture, operation: Parameters<typeof executeOperation>[2]) {
  const args = { workspaceId: f.ws, scope: OWNER.scope, operation: { kind: operation.kind } };
  attachQueueMove(f.ctx, args, f.store, f.store);
  attachWorkspaceKeyed(f.ctx, f.ws, f.store);
  attachTreeListing(f.ctx, f.ws, f.store);
  return executeOperation(f.store, OWNER, operation, Date.now());
}

/** Every collaboration head in the bucket, as the engine wrote it. */
function headsOf(f: Fixture): { path: string; status: string; documentId: string; destination?: string }[] {
  return Object.entries(f.store.snapshot())
    .filter(([key]) => key.startsWith(".context/collaboration/v1/heads/"))
    .map(([, text]) => JSON.parse(text));
}

/** A folder made as `createFolder` makes one: a folder row and its about note, which holds only the template text. */
async function addNewFolder(f: Fixture, path: string, extra?: string): Promise<void> {
  await f.t.run(async (ctx) => {
    const folder = await ctx.db.insert("nodes", {
      workspaceId: f.ws,
      noteId: NOTE_ID(900),
      path,
      name: path.slice(path.lastIndexOf("/") + 1),
      kind: "folder",
      observedAt: 1,
    });
    await ctx.db.insert("nodes", {
      workspaceId: f.ws,
      noteId: NOTE_ID(901),
      path: `${path}/about.md`,
      parentId: folder,
      name: "about.md",
      kind: "file",
      etag: "e-about",
      observedAt: 1,
      storageKey: `notes/${NOTE_ID(901)}.md`,
    });
    if (extra !== undefined) {
      await ctx.db.insert("nodes", {
        workspaceId: f.ws,
        noteId: NOTE_ID(902),
        path: `${path}/${extra}`,
        parentId: folder,
        name: extra,
        kind: "file",
        etag: "e-extra",
        observedAt: 1,
        storageKey: `notes/${NOTE_ID(902)}.md`,
      });
      f.store.seed(`notes/${NOTE_ID(902)}.md`, "# Typed\n");
    }
  });
  f.store.seed(`notes/${NOTE_ID(901)}.md`, renderNewFolderAbout(path));
  // This store has no id layer, so Undo's read of the about note's words, by name, reads the path.
  f.store.seed(`${path}/about.md`, renderNewFolderAbout(path));
}

describe("a keyed trash carries the note's collaboration history with its row", () => {
  test("the head moves to the trash location, and the old name is fenced", async () => {
    const f = await keyedFixture();
    const opened = await readDocument(f.store, KEEP);

    const trashed = (await operate(f, { kind: "trash", path: KEEP })) as Moved;

    expect(headsOf(f)).toContainEqual(expect.objectContaining({ path: trashed.to, status: "active", documentId: opened.documentId }));
    expect(headsOf(f)).toContainEqual(expect.objectContaining({ path: KEEP, status: "moved", destination: trashed.to }));
  });

  test("a note created at the trashed name afterwards starts a document of its own", async () => {
    const f = await keyedFixture();
    const opened = await readDocument(f.store, KEEP);
    await operate(f, { kind: "trash", path: KEEP });

    const reopened = await readDocument(f.store, KEEP);

    expect(reopened.documentId).not.toBe(opened.documentId);
  });

  test("a restore brings the history back to the name", async () => {
    const f = await keyedFixture();
    const opened = await readDocument(f.store, KEEP);
    const trashed = (await operate(f, { kind: "trash", path: KEEP })) as Moved;

    await operate(f, { kind: "restoreTrash", from: trashed.to, to: KEEP });

    expect((await readDocument(f.store, KEEP)).documentId).toBe(opened.documentId);
    expect(headsOf(f)).toContainEqual(expect.objectContaining({ path: KEEP, status: "active", documentId: opened.documentId }));
    expect(await liveAt(f, KEEP)).toBe(true);
  });

  test("a rename that fails leaves the row trash correct, and the history where the restore finds it", async () => {
    const f = await keyedFixture();
    const opened = await readDocument(f.store, KEEP);
    const write = f.store.put.bind(f.store);
    f.store.put = ((key: string, value: Parameters<typeof write>[1], options?: Parameters<typeof write>[2]) => {
      if (key.startsWith(".context/collaboration/")) return Promise.reject(new Error("injected storage failure"));
      return write(key, value, options);
    }) as typeof write;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    let trashed: Moved;
    try {
      trashed = (await operate(f, { kind: "trash", path: KEEP })) as Moved;
      expect(logged).toHaveBeenCalledWith("nodes.trash_history_failed", { code: expect.any(String) });
    } finally {
      f.store.put = write;
      logged.mockRestore();
    }

    expect(trashed.to).toMatch(/^\.context\/trash\/[^/]+\/1-projects\/keep\.md$/);
    expect(await liveAt(f, KEEP)).toBe(false);
    expect(await rowOf(f, trashed.to)).toBeDefined();
    expect(headsOf(f)).toContainEqual(expect.objectContaining({ path: KEEP, status: "active", documentId: opened.documentId }));

    await operate(f, { kind: "restoreTrash", from: trashed.to, to: KEEP });
    expect((await readDocument(f.store, KEEP)).documentId).toBe(opened.documentId);
  });
});

describe("removeNewFolder and a plugin's delete trash the rows in a keyed workspace", () => {
  test("undo of a new folder that holds only its about note trashes the folder, restorably", async () => {
    const f = await keyedFixture();
    await addNewFolder(f, "2-areas/hiring");

    const removed = (await operate(f, { kind: "removeNewFolder", path: "2-areas/hiring" })) as Deleted;

    expect(removed.kind).toBe("deleted");
    expect(removed.paths.length).toBe(1);
    expect(removed.paths[0]).toMatch(/^\.context\/trash\/[^/]+\/2-areas\/hiring$/);
    expect(await liveAt(f, "2-areas/hiring")).toBe(false);
    expect(await liveAt(f, "2-areas/hiring/about.md")).toBe(false);
    expect((await treeOf(f)).some((row) => row.path === removed.paths[0] && row.kind === "folder")).toBe(true);
  });

  test("undo of a new folder that holds anything else is still kept, and nothing moves", async () => {
    const f = await keyedFixture();
    await addNewFolder(f, "2-areas/hiring", "notes.md");
    const before = await treeOf(f);

    await expect(operate(f, { kind: "removeNewFolder", path: "2-areas/hiring" })).rejects.toMatchObject({
      data: { code: "FOLDER_NOT_EMPTY" },
    });

    expect(await treeOf(f)).toEqual(before);
  });

  test("a plugin's delete of a keyed file trashes its row, and a stale version is refused", async () => {
    const f = await keyedFixture();
    const row = await rowOf(f, KEEP);

    const deleted = (await operate(f, { kind: "pluginDelete", path: KEEP, expectedEtag: row.etag as string })) as Deleted;

    expect(deleted.kind).toBe("deleted");
    expect(deleted.paths[0]).toMatch(/^\.context\/trash\/[^/]+\/1-projects\/keep\.md$/);
    expect(await liveAt(f, KEEP)).toBe(false);
    expect(await rowOf(f, deleted.paths[0])).toMatchObject({ _id: row._id, noteId: row.noteId, storageKey: row.storageKey });

    const before = await treeOf(f);
    await expect(
      operate(f, { kind: "pluginDelete", path: "1-projects/launch/brief.md", expectedEtag: "stale-version" }),
    ).rejects.toMatchObject({ data: { code: "CONFLICT" } });
    expect(await treeOf(f)).toEqual(before);
    expect(await liveAt(f, "1-projects/launch/brief.md")).toBe(true);
  });
});
