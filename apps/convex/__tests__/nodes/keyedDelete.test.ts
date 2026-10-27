/**
 * Deleting a note in a keyed workspace (`notes-by-id.md`, `lib/fileOps/deleting.ts`,
 * `lib/nodes/rowTrash.ts`). A delete is a trash: the row moves into
 * `.context/trash/` with its bytes at their key. Nothing in an ordinary delete
 * retires a keyed row, because that is what emptying the trash may do.
 *
 * Each case fails if its guard is removed:
 *  - the keyed branch in `trashPath` (an offline delete with a version went the old
 *    way: the row was tombstoned and the bytes discarded by the gateway's retire);
 *  - the row move's version check (a stale offline delete trashes a newer note);
 *  - the keyed refusal in `deletePath` (a permanent delete retires the row and key).
 */

import { describe, expect, test } from "vitest";
import { executeOperation } from "../../functions/lib/filesFns/executeOperation";
import { attachQueueMove } from "../../functions/lib/nodes/moveBarrier";
import { OWNER, type Fixture } from "./moveFixture.helpers";
import { bytesOf, keyedFixture, liveAt, rowOf, treeOf } from "./keyedFixture.helpers";

type Moved = { kind: "moved"; from: string; to: string; paths: string[]; queued?: number };

function operate(f: Fixture, operation: Parameters<typeof executeOperation>[2]) {
  const args = { workspaceId: f.ws, scope: OWNER.scope, operation: { kind: operation.kind } };
  attachQueueMove(f.ctx, args, f.store, f.store);
  // The barrier attaches the keyed question to every operation's store (`fileOperationBarrier.ts`).
  return executeOperation(f.store, OWNER, operation, Date.now());
}

describe("an offline delete (one made against a version) in a keyed workspace is a row trash", () => {
  test("a delete against the current version trashes the note's row, with its bytes at their key", async () => {
    const f = await keyedFixture();
    const before = await rowOf(f, "1-projects/keep.md");
    const bytesBefore = bytesOf(f);

    const result = (await operate(f, {
      kind: "trash",
      path: "1-projects/keep.md",
      expectedEtag: before.etag,
    })) as Moved;

    expect(result).toMatchObject({ kind: "moved", from: "1-projects/keep.md" });
    expect(result.to).toMatch(/^\.context\/trash\/[^/]+\/1-projects\/keep\.md$/);
    expect(await rowOf(f, result.to)).toMatchObject({ _id: before._id, noteId: before.noteId, storageKey: before.storageKey });
    expect(await liveAt(f, "1-projects/keep.md")).toBe(false);
    expect(bytesOf(f)).toEqual(bytesBefore);
  });

  test("a delete against an older version is refused as a conflict, and the tree is as it was", async () => {
    const f = await keyedFixture();
    const before = await treeOf(f);
    const bytesBefore = bytesOf(f);

    await expect(
      operate(f, { kind: "trash", path: "1-projects/keep.md", expectedEtag: "stale-version" }),
    ).rejects.toMatchObject({ data: { code: "CONFLICT" } });

    expect(await treeOf(f)).toEqual(before);
    expect(bytesOf(f)).toEqual(bytesBefore);
    expect(await liveAt(f, "1-projects/keep.md")).toBe(true);
  });
});

describe("a permanent delete in a keyed workspace is refused", () => {
  test("nothing is removed: the row stays live, its key keeps its bytes, and the tree is unchanged", async () => {
    const f = await keyedFixture();
    const before = await treeOf(f);
    const bytesBefore = bytesOf(f);
    const row = await rowOf(f, "1-projects/keep.md");

    await expect(
      operate(f, { kind: "delete", path: "1-projects/keep.md", confirmation: "permanently delete" }),
    ).rejects.toMatchObject({ data: { code: "KEYED_WORKSPACE" } });

    expect(await treeOf(f)).toEqual(before);
    expect(bytesOf(f)).toEqual(bytesBefore);
    expect(await rowOf(f, "1-projects/keep.md")).toMatchObject({ _id: row._id, storageKey: row.storageKey });
    expect(await liveAt(f, "1-projects/keep.md")).toBe(true);
  });

  test("a folder is refused the same way, and no row under it is retired", async () => {
    const f = await keyedFixture();
    const before = await treeOf(f);

    await expect(
      operate(f, { kind: "delete", path: "1-projects/launch", confirmation: "permanently delete" }),
    ).rejects.toMatchObject({ data: { code: "KEYED_WORKSPACE" } });

    expect(await treeOf(f)).toEqual(before);
  });
});
