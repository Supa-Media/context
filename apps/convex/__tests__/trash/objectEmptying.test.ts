/**
 * Emptying the trash where a workspace's notes live in its object (`functions/lib/trash/objectErase.ts`, and the
 * branch `eraseWorkspaceTrash` takes when `workspaceObjectHomes` says `object`; decided by the owner, 2026-11-02;
 * `docs/decisions/storage-and-credentials/background-tree-writers.md`).
 *
 * The object is the writer of the rows: the due stamp folder is erased by `ws.write.erase` (a fake here), a page at a
 * time, and Convex's rows follow through the mirror (the fake deletes them, as the mirror would). Each page's keys are
 * recorded for the bucket half, and the folder's last page writes its audit line. No mark is opened.
 *
 * Sabotage (temporary local edit, reverted): make `eraseWorkspaceTrash` ignore the home, so it always takes the old
 * claim path → "the object is asked to erase exactly the due folder" fails, and so does every other case that
 * expects the object to be called.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../../_generated/api";
import { executeOperation } from "../../functions/lib/filesFns/executeOperation";
import { attachQueueMove } from "../../functions/lib/nodes/moveBarrier";
import { nodePaths } from "../../functions/lib/nodes/paths";
import { stampFolderOf } from "../../functions/lib/trash/bin";
import { eraseWorkspaceTrash } from "../../functions/lib/trash/erase";
import { keysOf, eraseInObject, type ObjectEraser } from "../../functions/lib/trash/objectErase";
import { OWNER, type Fixture } from "../nodes/moveFixture.helpers";
import { keyedFixture, rowOf } from "../nodes/keyedFixture.helpers";

const DAY = 24 * 60 * 60 * 1000;
type Moved = { kind: "moved"; from: string; to: string };
type FileOut = { noteId: string | null; storageKey: string | null };

afterEach(() => {
  vi.restoreAllMocks();
});

/** Trash `path` as the console does, at `now`, with the trail the console writes (copied from `emptying.test.ts`). */
async function trash(f: Fixture, path: string, now = Date.now()): Promise<string> {
  const args = { workspaceId: f.ws, scope: OWNER.scope, operation: { kind: "trash" } };
  attachQueueMove(f.ctx, args, f.store, f.store);
  const moved = (await executeOperation(f.store, OWNER, { kind: "trash", path }, now)) as Moved;
  await f.t.run(async (ctx) => {
    await ctx.db.insert("auditEvents", {
      workspaceId: f.ws,
      actorUserId: f.ownerId,
      action: "file.archive",
      paths: [path, moved.to],
      at: now + 50,
      details: { files: 1, recoverable: true, trash: true },
    });
  });
  return moved.to;
}

async function setHome(f: Fixture, home: "object" | "bucket" = "object") {
  await f.t.run(async (ctx) => {
    await ctx.db.insert("workspaceObjectHomes", { workspaceId: f.ws, home, since: Date.now() });
  });
}

/** The file rows beneath a trashed folder or note's stamp folder: what the object would list as erased. */
async function filesUnder(f: Fixture, folder: string): Promise<FileOut[]> {
  return await f.t.run(async (ctx) => {
    const paths = await nodePaths(ctx.db, f.ws);
    const rows = await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", f.ws)).collect();
    const out: FileOut[] = [];
    for (const row of rows) {
      if (row.kind !== "file" || row.goneAt !== undefined) continue;
      const path = await paths.pathOf(row);
      if (path !== null && path.startsWith(`${folder}/`)) out.push({ noteId: row.noteId ?? null, storageKey: row.storageKey ?? null });
    }
    return out;
  });
}

/** The mirror: the object removed these rows, so Convex's copy of them goes too (the folder is gone with its files). */
async function mirrorErase(f: Fixture, folder: string) {
  await f.t.run(async (ctx) => {
    const paths = await nodePaths(ctx.db, f.ws);
    const rows = await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", f.ws)).collect();
    for (const row of rows) {
      const path = await paths.pathOf(row);
      if (path === folder || (path !== null && path.startsWith(`${folder}/`))) await ctx.db.delete(row._id);
    }
  });
}

/** The page's answer as the object would give it: `ok` with the page, or `MIRROR_PENDING` beside it. */
const page = (files: FileOut[], more: boolean) => ({ ok: true, count: files.length, more, files });

/**
 * A fake `ws.write.erase`. Each call takes the next reply: an Error is thrown, anything else is the answer. A reply
 * that ends the folder (`more: false`, or `MIRROR_PENDING` with one) also has the mirror delete the folder's rows.
 */
function objectOf(f: Fixture, replies: Array<unknown | Error>) {
  const calls: Array<{ path: string }> = [];
  const client: ObjectEraser = {
    write: {
      erase: async (body) => {
        calls.push(body);
        const answer = replies[calls.length - 1];
        if (answer instanceof Error) throw answer;
        const held = answer as { ok?: unknown; more?: unknown; answer?: { more?: unknown } } | null;
        const finalPage = held?.ok === true ? held.more === false : held?.answer?.more === false;
        if (finalPage) await mirrorErase(f, body.path);
        return answer;
      },
    },
  };
  return { client, calls };
}

/** The keyed trash's bucket half, where the keys' bytes are seeded so a deletion is visible. */
function seedBytes(f: Fixture, files: FileOut[]) {
  for (const file of files) if (file.storageKey) f.store.seed(file.storageKey, `bytes of ${file.storageKey}\n`);
}

const failingOpen = async () => {
  throw Object.assign(new Error("down"), { code: "STORAGE_UNAVAILABLE" });
};

const audits = (f: Fixture, action: string) =>
  f.t.run(async (ctx) => (await ctx.db.query("auditEvents").collect()).filter((event) => event.action === action));

const erasures = (f: Fixture) => f.t.run(async (ctx) => await ctx.db.query("trashErasures").collect());

const marks = (f: Fixture) => f.t.run(async (ctx) => await ctx.db.query("workspaceObjectMarks").collect());
const unmarked = (f: Fixture) => f.t.run(async (ctx) => await ctx.db.query("workspaceObjectUnmarked").collect());

describe("emptying the trash where the notes live in the object", () => {
  test("a due stamp folder is erased by the object, and the bucket half finishes its keys", async () => {
    const f = await keyedFixture();
    const key = await trash(f, "1-projects/keep.md", Date.now() - 31 * DAY);
    const folder = stampFolderOf(key)!;
    const [file] = await filesUnder(f, folder);
    expect(file.storageKey).toBeTruthy();
    seedBytes(f, [file]);
    await setHome(f);
    const { client, calls } = objectOf(f, [page([file], false)]);

    // The bucket is down the first time: the object has removed the rows, so the erasure must be recorded and kept.
    const failed = await eraseWorkspaceTrash(f.ctx, f.ws, failingOpen, async () => client);
    expect(failed).toEqual({ claimed: 1, finished: 0, failed: 1 });
    expect(calls).toEqual([{ path: folder }]);
    expect(await erasures(f)).toMatchObject([{ folder, path: folder, keys: [file.storageKey], histories: [], attempts: 1 }]);
    expect(f.store.snapshot()[file.storageKey!]).toBeDefined();

    // The next pass finishes it, and the object is not asked again: the mirror has taken the folder away.
    expect(await eraseWorkspaceTrash(f.ctx, f.ws, async () => f.store, async () => client)).toEqual({ claimed: 0, finished: 1, failed: 0 });
    expect(calls).toEqual([{ path: folder }]);
    expect(f.store.snapshot()[file.storageKey!]).toBeUndefined();
    expect(await erasures(f)).toEqual([]);
    expect(await f.t.run(async (ctx) => (await ctx.db.query("nodes").collect()).some((row) => row.goneAt === undefined && row.kind === "folder" && row.name === folder.slice(folder.lastIndexOf("/") + 1)))).toBe(false);

    // No mark is opened and nothing is recorded as unmarked: the object was told by being the one that writes.
    expect(await marks(f)).toEqual([]);
    expect(await unmarked(f)).toEqual([]);

    const deletes = await audits(f, "file.delete");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toMatchObject({ workspaceId: f.ws, paths: [folder], details: { files: 1, erasedFromTrash: true } });
  });

  test("a folder the object pages is erased page by page: the same folder is asked again, and both pages' keys go", async () => {
    const f = await keyedFixture();
    const key = await trash(f, "1-projects/launch", Date.now() - 31 * DAY);
    const folder = stampFolderOf(key)!;
    const files = await filesUnder(f, folder);
    expect(files.length).toBeGreaterThanOrEqual(2);
    seedBytes(f, files);
    await setHome(f);
    const first = files.slice(0, 1);
    const second = files.slice(1);
    const { client, calls } = objectOf(f, [page(first, true), page(second, false)]);

    // Two object pages, one record for the folder (`trashObject.begin`), finished once.
    expect(await eraseWorkspaceTrash(f.ctx, f.ws, async () => f.store, async () => client)).toEqual({ claimed: 2, finished: 1, failed: 0 });

    expect(calls).toEqual([{ path: folder }, { path: folder }]);
    for (const file of files) expect(f.store.snapshot()[file.storageKey!]).toBeUndefined();
    expect(await erasures(f)).toEqual([]);
    // One audit line for the folder, on its last page, counting every file of both pages.
    const deletes = await audits(f, "file.delete");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toMatchObject({ paths: [folder], details: { files: files.length, erasedFromTrash: true } });
  });

  test("a page the mirror is behind on (MIRROR_PENDING, with the answer beside it) still records and deletes its keys", async () => {
    const f = await keyedFixture();
    const key = await trash(f, "1-projects/keep.md", Date.now() - 31 * DAY);
    const folder = stampFolderOf(key)!;
    const [file] = await filesUnder(f, folder);
    seedBytes(f, [file]);
    await setHome(f);
    const pending = { ok: false, code: "MIRROR_PENDING", answer: page([file], false) };
    const { client, calls } = objectOf(f, [pending]);

    const failed = await eraseWorkspaceTrash(f.ctx, f.ws, failingOpen, async () => client);
    expect(failed).toEqual({ claimed: 1, finished: 0, failed: 1 });
    expect(await erasures(f)).toMatchObject([{ folder, keys: [file.storageKey] }]);

    expect(await eraseWorkspaceTrash(f.ctx, f.ws, async () => f.store, async () => client)).toEqual({ claimed: 0, finished: 1, failed: 0 });
    expect(calls).toEqual([{ path: folder }]);
    expect(f.store.snapshot()[file.storageKey!]).toBeUndefined();
    expect(await erasures(f)).toEqual([]);
    expect(await audits(f, "file.delete")).toHaveLength(1);
  });

  test("a refusal deletes nothing and audits nothing, its record held back from the bucket half; a thrown error does the same", async () => {
    const f = await keyedFixture();
    const key = await trash(f, "1-projects/keep.md", Date.now() - 31 * DAY);
    const folder = stampFolderOf(key)!;
    const [file] = await filesUnder(f, folder);
    seedBytes(f, [file]);
    await setHome(f);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    const refused = objectOf(f, [{ ok: false, code: "NOT_FOUND" }]);
    expect(await eraseWorkspaceTrash(f.ctx, f.ws, async () => f.store, async () => refused.client)).toEqual({ claimed: 0, finished: 0, failed: 0 });
    expect(refused.calls).toEqual([{ path: folder }]);

    const thrown = objectOf(f, [Object.assign(new Error("down"), { name: "TypeError" })]);
    expect(await eraseWorkspaceTrash(f.ctx, f.ws, async () => f.store, async () => thrown.client)).toEqual({ claimed: 0, finished: 0, failed: 0 });
    expect(thrown.calls).toEqual([{ path: folder }]);
    expect(log).toHaveBeenCalledWith("trash.object_erase_failed", expect.anything());

    // The record made before the object was asked stays held back: the folder is still in the mirror, so nothing
    // says it was erased, and its bytes stay for a restore.
    expect(await erasures(f)).toMatchObject([{ folder, objectPending: true }]);
    expect(f.store.snapshot()[file.storageKey!]).toBeDefined();
    expect(await audits(f, "file.delete")).toEqual([]);
    // The trash is still there and still due: the next pass asks the object again.
    expect(await rowOf(f, key)).toMatchObject({ kind: "file" });
    expect(await marks(f)).toEqual([]);
  });

  test("a run that dies after the object erased, before it recorded, loses no key: the next pass finds the folder gone and deletes the bytes", async () => {
    const f = await keyedFixture();
    const key = await trash(f, "1-projects/keep.md", Date.now() - 31 * DAY);
    const folder = stampFolderOf(key)!;
    const [file] = await filesUnder(f, folder);
    seedBytes(f, [file]);
    await setHome(f);
    vi.spyOn(console, "error").mockImplementation(() => {});
    // The object took the erase and the mirror landed, but the answer never reached the run.
    const dying: ObjectEraser = {
      write: {
        erase: async ({ path }) => {
          await mirrorErase(f, path);
          throw Object.assign(new Error("the run stopped"), { name: "AbortError" });
        },
      },
    };
    await eraseWorkspaceTrash(f.ctx, f.ws, async () => f.store, async () => dying);
    expect(f.store.snapshot()[file.storageKey!]).toBeDefined();

    // Nothing is due any more; the record made before the call still holds the key, and the folder is gone.
    const idle = objectOf(f, []);
    expect(await eraseWorkspaceTrash(f.ctx, f.ws, async () => f.store, async () => idle.client)).toEqual({ claimed: 0, finished: 1, failed: 0 });
    expect(idle.calls).toEqual([]);
    expect(f.store.snapshot()[file.storageKey!]).toBeUndefined();
    expect(await erasures(f)).toEqual([]);
  });

  test("a record stays held while anything lives under its folder, even with the folder's own row gone", async () => {
    const f = await keyedFixture();
    const key = await trash(f, "1-projects/keep.md", Date.now() - 31 * DAY);
    const folder = stampFolderOf(key)!;
    const [file] = await filesUnder(f, folder);
    seedBytes(f, [file]);
    await setHome(f);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const dying: ObjectEraser = { write: { erase: async () => { throw new Error("the run stopped"); } } };
    await eraseWorkspaceTrash(f.ctx, f.ws, async () => f.store, async () => dying);
    // The mirror holds no row for the folder itself, only the file under it: the erase has not finished.
    await f.t.run(async (ctx) => {
      const paths = await nodePaths(ctx.db, f.ws);
      for (const row of await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", f.ws)).collect()) {
        if ((await paths.pathOf(row)) === folder) await ctx.db.delete(row._id);
      }
    });
    expect(await f.t.mutation(internal.functions.trashObject.settle, { workspaceId: f.ws })).toBe(0);
    expect((await erasures(f)).map((row) => row.objectPending)).toEqual([true]);
    expect(f.store.snapshot()[file.storageKey!]).toBeDefined();
  });

  test("a file with no storage key is erased at its note's key, and a bad note id is dropped", async () => {
    const f = await keyedFixture();
    const key = await trash(f, "1-projects/keep.md", Date.now() - 31 * DAY);
    const folder = stampFolderOf(key)!;
    const noteId = (await rowOf(f, key)).noteId!;
    const { client } = objectOf(f, [page([{ noteId, storageKey: null }], false)]);
    await setHome(f);

    expect(await eraseWorkspaceTrash(f.ctx, f.ws, async () => f.store, async () => client)).toEqual({ claimed: 1, finished: 1, failed: 0 });
    expect(await audits(f, "file.delete")).toMatchObject([{ paths: [folder] }]);
  });

  test("a workspace whose notes are in the bucket never calls the object: the old claim path empties it", async () => {
    const f = await keyedFixture();
    const key = await trash(f, "1-projects/keep.md", Date.now() - 31 * DAY);
    const storageKey = (await rowOf(f, key)).storageKey!;
    const { client, calls } = objectOf(f, []);

    expect(await eraseWorkspaceTrash(f.ctx, f.ws, async () => f.store, async () => client)).toEqual({ claimed: 1, finished: 1, failed: 0 });

    expect(calls).toEqual([]);
    expect(f.store.snapshot()[storageKey]).toBeUndefined();
    expect(await erasures(f)).toEqual([]);
  });

  test("nothing due: the object is never asked, and nothing is erased", async () => {
    const f = await keyedFixture();
    const key = await trash(f, "1-projects/keep.md", Date.now() - 2 * DAY);
    await setHome(f);
    const { client, calls } = objectOf(f, []);

    expect(await eraseWorkspaceTrash(f.ctx, f.ws, async () => f.store, async () => client)).toEqual({ claimed: 0, finished: 0, failed: 0 });

    expect(calls).toEqual([]);
    expect(await rowOf(f, key)).toMatchObject({ kind: "file" });
    expect(await erasures(f)).toEqual([]);
    expect(await audits(f, "file.delete")).toEqual([]);
  });
});

describe("the keys the bucket half deletes for an object's files", () => {
  test("a file's own key, its note's key when it has none, each once, and nothing a note id could not name", () => {
    expect(keysOf([{ noteId: "0190a000-0000-7000-8000-000000000001", storageKey: null }])).toEqual(["notes/0190a000-0000-7000-8000-000000000001.md"]);
    expect(keysOf([{ noteId: "n1", storageKey: "files/n1.png" }])).toEqual(["files/n1.png"]);
    expect(keysOf([{ noteId: "n1", storageKey: "notes/n1.md" }, { noteId: "n1", storageKey: null }])).toEqual(["notes/n1.md"]);
    expect(keysOf([{ noteId: "../x", storageKey: null }, { noteId: "a/b", storageKey: "" }, { noteId: null, storageKey: null }])).toEqual([]);
  });

  test("a page whose files name a bad note id records only the good keys", async () => {
    const f = await keyedFixture();
    const key = await trash(f, "1-projects/keep.md", Date.now() - 31 * DAY);
    const folder = stampFolderOf(key)!;
    await setHome(f);
    const { client } = objectOf(f, [page([{ noteId: "../x", storageKey: null }, { noteId: "good-id", storageKey: null }], false)]);

    // Through the real loop: the bad id is dropped from the recorded keys, the good one is kept.
    const taken = await eraseInObject(f.ctx, f.ws, client, 25);
    expect(taken).toBe(1);
    // Beside the keys the mirror held under the folder when the record was made.
    const [recorded] = await erasures(f);
    expect(recorded).toMatchObject({ folder });
    expect(recorded!.keys).toContain("notes/good-id.md");
    expect(recorded!.keys.some((k: string) => k.includes(".."))).toBe(false);
  });
});
