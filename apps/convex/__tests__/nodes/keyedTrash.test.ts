/**
 * Trash and Restore in a keyed workspace are row changes (`notes-by-id`,
 * `functions/lib/nodes/rowTrash.ts`): a note or folder moves into
 * `.context/trash/<stamp>/<path>` as its rows, and Restore moves them back.
 * No byte is copied, deleted or queued, and no privacy rule is written: the
 * trashed note keeps its rules at its own name, as a trash made in one go does.
 *
 * Runs the real functions through `convex-test`, through `executeOperation`
 * with the move barrier's seams attached.
 *
 * Each case fails if its guard is removed:
 *  - the keyed branch in `startRowTrash` (the trash refused or queued as bytes);
 *  - the restore branch in `restoreQueuedTrash` (Restore "not found");
 *  - the name-collision loop (a second trash in the same millisecond is refused);
 *  - a folder over the row cap trashed and restored whole, in pages (`rowMoveChunks.ts`);
 *  - the `trash` flag's own check (a flagged move that is not into or out of the trash);
 *  - the privacy carry skipped for a trash (rules rewritten, or a private note widened);
 *  - the visibility check (a hidden note trashed by a team member).
 */

import { describe, expect, test } from "vitest";
import { internal } from "../../_generated/api";
import { executeOperation } from "../../functions/lib/filesFns/executeOperation";
import type { FileStore } from "../../functions/lib/fileOps";
import { attachQueueMove } from "../../functions/lib/nodes/moveBarrier";
import { mirrorFile } from "../../functions/lib/nodes/privacyMirror";
import { readerMirror } from "../../functions/lib/nodes/readerRules";
import { startRowTrash } from "../../functions/lib/nodes/rowTrash";
import { PRIVACY_KEY } from "../../functions/lib/privacy";
import { OWNER, TEAM, listed, start, type Fixture } from "./moveFixture.helpers";
import { bigFolder, bytesOf, keyedFixture, liveAt, logOf, rowOf, treeOf } from "./keyedFixture.helpers";

type Moved = { kind: "moved"; from: string; to: string; paths: string[]; queued?: number };

/**
 * The store a keyed workspace's operations read in rows mode: `privacy.md` answers with the rows' rules, as the
 * served tree hands it out (`manifestStore.ts`, `mirrorFile`), not with the file the bucket holds, which the
 * rows no longer write. A rule a move wrote on a row (a note's own private access) is then seen by the trash.
 */
async function rowsStore(f: Fixture): Promise<FileStore> {
  const served = mirrorFile(await f.t.run(async (ctx) => await readerMirror(ctx as never, f.ws)));
  return new Proxy(f.store, {
    get(target, key) {
      if (key === "get") return async (path: string) => (path === PRIVACY_KEY ? served : await target.get(path));
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as FileStore;
}

async function operate(
  f: Fixture,
  operation: { kind: "trash"; path: string } | { kind: "restoreTrash"; from: string; to: string },
  clearance = OWNER,
) {
  const store = await rowsStore(f);
  const args = { workspaceId: f.ws, scope: clearance.scope, operation: { kind: operation.kind } };
  attachQueueMove(f.ctx, args, store, store);
  return (await executeOperation(store, clearance, operation, Date.now())) as Moved;
}

describe("trashing a note or folder in a keyed workspace moves its rows", () => {
  test("a note goes into the trash as its own row, and its bytes stay at their key", async () => {
    const f = await keyedFixture();
    const before = await rowOf(f, "1-projects/keep.md");
    const bytesBefore = bytesOf(f);

    const result = await operate(f, { kind: "trash", path: "1-projects/keep.md" });

    expect(result).toMatchObject({ kind: "moved", from: "1-projects/keep.md", queued: 1 });
    expect(result.to).toMatch(/^\.context\/trash\/[^/]+\/1-projects\/keep\.md$/);
    expect(await rowOf(f, result.to)).toMatchObject({
      _id: before._id,
      noteId: before.noteId,
      storageKey: before.storageKey,
      etag: before.etag,
    });
    expect(await liveAt(f, "1-projects/keep.md")).toBe(false);
    expect(bytesOf(f)).toEqual(bytesBefore);
    expect(await f.t.query(internal.functions.nodeRowMoves.drawn, { workspaceId: f.ws })).toEqual([]);
    expect(await listed(f.owner, f.ws, "1-projects")).not.toContain("1-projects/keep.md");
  });

  test("the trash's own folders are never listed: the root shows no .context", async () => {
    const f = await keyedFixture();
    await operate(f, { kind: "trash", path: "1-projects/keep.md" });
    expect((await listed(f.owner, f.ws, "")).some((path) => path.includes(".context"))).toBe(false);
    expect((await listed(f.member, f.ws, "")).some((path) => path.includes(".context"))).toBe(false);
  });

  test("a folder goes into the trash whole, and each row keeps its identity", async () => {
    const f = await keyedFixture();
    const launch = await rowOf(f, "1-projects/launch");
    const deep = await rowOf(f, "1-projects/launch/sub/deep.md");

    const result = await operate(f, { kind: "trash", path: "1-projects/launch" });

    expect(result).toMatchObject({ kind: "moved", from: "1-projects/launch", queued: 4 });
    expect(await rowOf(f, result.to)).toMatchObject({ _id: launch._id, kind: "folder" });
    expect(await rowOf(f, `${result.to}/sub/deep.md`)).toMatchObject({ _id: deep._id, noteId: deep.noteId });
    expect(await liveAt(f, "1-projects/launch")).toBe(false);
    expect(await liveAt(f, "1-projects/launch/sub/deep.md")).toBe(false);
  });

  test("the change log says the note left its path, and nothing is logged under the trash", async () => {
    const f = await keyedFixture();
    const before = (await logOf(f)).length;

    await operate(f, { kind: "trash", path: "1-projects/keep.md" });

    const entries = (await logOf(f)).slice(before);
    expect(entries).toContainEqual({ path: "1-projects/keep.md", gone: true });
    expect(entries.some((entry) => entry.path.startsWith(".context"))).toBe(false);
  });

  test("the trash carries no privacy rule: a private note keeps its rules at its own name", async () => {
    const f = await keyedFixture();
    const rulesBefore = f.store.snapshot()[PRIVACY_KEY];

    await operate(f, { kind: "trash", path: "1-projects/secret/codes.md" });

    expect(f.store.snapshot()[PRIVACY_KEY]).toBe(rulesBefore);
  });

  test("a team member cannot trash a note they cannot see, and the note is not found", async () => {
    const f = await keyedFixture();
    const before = await treeOf(f);

    await expect(operate(f, { kind: "trash", path: "1-projects/secret/codes.md" }, TEAM)).rejects.toMatchObject({
      data: { code: "FILE_NOT_FOUND" },
    });

    expect(await treeOf(f)).toEqual(before);
  });

  test("a folder holding a note the caller cannot see is refused, not trashed without it", async () => {
    const f = await keyedFixture();
    // The private note moves into a team folder and stays private there (`rowMoveStart.ts`).
    await start(f, "1-projects/secret/codes.md", "1-projects/launch/codes.md");
    const before = await treeOf(f);

    await expect(operate(f, { kind: "trash", path: "1-projects/launch" }, TEAM)).rejects.toMatchObject({ data: { code: "CONFLICT" } });

    expect(await treeOf(f)).toEqual(before);
  });

});

describe("the trash destination", () => {
  test("a second note trashed under the same name in the same millisecond takes the next free name", async () => {
    const f = await keyedFixture();
    const now = Date.now();
    const first = await startRowTrash(f.ctx, { workspaceId: f.ws, store: f.store, path: "1-projects/keep.md", clearance: OWNER, now });
    // Another note takes the name the first left, and is trashed in the same millisecond.
    await start(f, "3-resources/r.md", "1-projects/keep.md");
    const second = await startRowTrash(f.ctx, { workspaceId: f.ws, store: f.store, path: "1-projects/keep.md", clearance: OWNER, now });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.to).toMatch(/^\.context\/trash\/[^/]+\/1-projects\/keep\.md$/);
    expect(second!.to).toMatch(/^\.context\/trash\/[^/]+-2\/1-projects\/keep\.md$/);
    expect(await liveAt(f, first!.to)).toBe(true);
    expect(await liveAt(f, second!.to)).toBe(true);
  });

  test("the row move refuses a flagged move that is neither into nor out of the trash", async () => {
    const f = await keyedFixture();
    const answer = await f.t.mutation(internal.functions.nodeRowMoves.rowMove, {
      workspaceId: f.ws,
      from: "1-projects/keep.md",
      to: "1-projects/kept.md",
      privacyEtag: null,
      trash: true,
      now: Date.now(),
    });
    expect(answer).toEqual({ ok: false, reason: "invalid" });
    expect(await liveAt(f, "1-projects/keep.md")).toBe(true);
  });
});

describe("the row cap on a trash", { timeout: 60_000 }, () => {
  test("a folder of exactly the cap in rows, the folder included, is trashed whole", async () => {
    const f = await keyedFixture();
    await bigFolder(f, "2-areas/big", 499);

    const result = await operate(f, { kind: "trash", path: "2-areas/big" });

    expect(result).toMatchObject({ kind: "moved", queued: 499 });
    expect(await liveAt(f, "2-areas/big")).toBe(false);
  });
});

describe("restoring a trashed note or folder in a keyed workspace moves its rows back", () => {
  test("a note returns to its name with its row, its id and its bytes", async () => {
    const f = await keyedFixture();
    const before = await rowOf(f, "1-projects/keep.md");
    const trashed = await operate(f, { kind: "trash", path: "1-projects/keep.md" });
    const bytesBefore = bytesOf(f);

    const restored = await operate(f, { kind: "restoreTrash", from: trashed.to, to: "1-projects/keep.md" });

    expect(restored).toMatchObject({ kind: "moved", to: "1-projects/keep.md" });
    expect(await rowOf(f, "1-projects/keep.md")).toMatchObject({ _id: before._id, noteId: before.noteId, storageKey: before.storageKey });
    expect(await liveAt(f, trashed.to)).toBe(false);
    expect(bytesOf(f)).toEqual(bytesBefore);
  });

  test("one note out of a trashed folder comes back alone, and the folder is made again to hold it", async () => {
    const f = await keyedFixture();
    const trashed = await operate(f, { kind: "trash", path: "1-projects/launch" });

    await operate(f, { kind: "restoreTrash", from: `${trashed.to}/sub/deep.md`, to: "1-projects/launch/sub/deep.md" });

    expect(await liveAt(f, "1-projects/launch/sub/deep.md")).toBe(true);
    expect(await liveAt(f, "1-projects/launch")).toBe(true);
    expect(await liveAt(f, "1-projects/launch/brief.md")).toBe(false);
    expect(await liveAt(f, `${trashed.to}/brief.md`)).toBe(true);
  });

  test("a whole folder returns with every row and its identity, and the trash keeps none of it", async () => {
    const f = await keyedFixture();
    const launch = await rowOf(f, "1-projects/launch");
    const trashed = await operate(f, { kind: "trash", path: "1-projects/launch" });

    await operate(f, { kind: "restoreTrash", from: trashed.to, to: "1-projects/launch" });

    expect(await rowOf(f, "1-projects/launch")).toMatchObject({ _id: launch._id });
    expect(await liveAt(f, "1-projects/launch/sub/deep.md")).toBe(true);
    expect(await liveAt(f, trashed.to)).toBe(false);
  });

  test("a restore onto a name a live row holds is refused, and the trash is as it was", async () => {
    const f = await keyedFixture();
    const trashed = await operate(f, { kind: "trash", path: "1-projects/keep.md" });
    await start(f, "3-resources/r.md", "1-projects/keep.md");
    const before = await treeOf(f);

    await expect(operate(f, { kind: "restoreTrash", from: trashed.to, to: "1-projects/keep.md" })).rejects.toMatchObject({
      data: { code: "DESTINATION_EXISTS" },
    });

    expect(await treeOf(f)).toEqual(before);
  });
});
