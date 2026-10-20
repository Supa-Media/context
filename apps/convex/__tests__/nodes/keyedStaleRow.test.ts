/**
 * A keyed note whose row's version fell behind its key still moves, trashes
 * and archives against the version a reader was given (`lib/nodes/rowCatchUp.ts`,
 * `docs/decisions/storage-and-credentials/notes-by-id.md`).
 *
 * A reader gets the key's etag (`idLayout.js`). A row move compared it with
 * the row's, and a key rewritten with no row told (the managed-encryption walk
 * sealing it, a write whose report was lost) left every archive, trash and
 * offline delete of that note refused as "changed".
 *
 * Sabotage, each confirmed to fail a case here:
 *  - drop the catch-up from `startRowMove`: the move and archive cases are refused;
 *  - drop it from `startRowTrash`: the offline delete case is refused;
 *  - drop it from `startRowMoveBatch`: the batch case is refused;
 *  - take any version the caller names, not only the key's: the "a version that
 *    is neither" case moves a note nobody read.
 */

import { describe, expect, test } from "vitest";
import { startQueuedMove } from "../../functions/lib/nodes/moveStart";
import { startRowMoveBatch } from "../../functions/lib/nodes/rowMoveBatch";
import { startRowTrash } from "../../functions/lib/nodes/rowTrash";
import { OWNER, type Fixture } from "./moveFixture.helpers";
import { keyedFixture, liveAt, rowOf, treeOf } from "./keyedFixture.helpers";

const NOTE = "1-projects/keep.md";

/** A keyed note whose key was rewritten under its row: the row keeps its old version, the key has a new one. */
async function staleRow(f: Fixture, path = NOTE): Promise<{ keyEtag: string; rowEtag: string }> {
  const row = await rowOf(f, path);
  f.store.seed(row.storageKey as string, `sealed bytes of ${path}\n`);
  const keyEtag = (await f.store.get(row.storageKey as string))!.etag as string;
  expect(keyEtag).not.toBe(row.etag);
  return { keyEtag, rowEtag: row.etag as string };
}

const move = (f: Fixture, from: string, to: string, expectedEtag: string) =>
  startQueuedMove(f.ctx, { workspaceId: f.ws, store: f.store, from, to, clearance: OWNER, now: Date.now(), expectedEtag });

describe("a stale keyed row catches up to its key when the caller holds the key's version", () => {
  test("a move against the key's version moves the note, and the row takes the key's version", async () => {
    const f = await keyedFixture();
    const { keyEtag } = await staleRow(f);

    await expect(move(f, NOTE, "1-projects/kept.md", keyEtag)).resolves.toMatchObject({ rowed: true });

    expect(await liveAt(f, NOTE)).toBe(false);
    expect(await rowOf(f, "1-projects/kept.md")).toMatchObject({ etag: keyEtag });
  });

  test("an archive (a move into Archive) against the key's version lands", async () => {
    const f = await keyedFixture();
    const { keyEtag } = await staleRow(f);

    await expect(move(f, NOTE, "4-archive/keep.md", keyEtag)).resolves.toMatchObject({ rowed: true });

    expect(await liveAt(f, "4-archive/keep.md")).toBe(true);
  });

  test("an offline delete against the key's version goes to the trash", async () => {
    const f = await keyedFixture();
    const { keyEtag } = await staleRow(f);

    const trashed = await startRowTrash(f.ctx, { workspaceId: f.ws, store: f.store, path: NOTE, clearance: OWNER, now: Date.now(), expectedEtag: keyEtag });

    expect(trashed?.to).toMatch(/^\.context\/trash\/[^/]+\/1-projects\/keep\.md$/);
    expect(await liveAt(f, NOTE)).toBe(false);
  });

  test("a batch against the keys' versions moves every note", async () => {
    const f = await keyedFixture();
    const keep = await staleRow(f);
    const brief = await staleRow(f, "1-projects/launch/brief.md");

    await startRowMoveBatch(f.ctx, {
      workspaceId: f.ws,
      store: f.store,
      moves: [
        { from: NOTE, to: "1-projects/kept.md", expectedEtag: keep.keyEtag },
        { from: "1-projects/launch/brief.md", to: "1-projects/brief.md", expectedEtag: brief.keyEtag },
      ],
      clearance: OWNER,
      now: Date.now(),
    });

    expect(await liveAt(f, "1-projects/kept.md")).toBe(true);
    expect(await liveAt(f, "1-projects/brief.md")).toBe(true);
  });

  test("a version that is neither the row's nor the key's is still refused, and nothing changes", async () => {
    const f = await keyedFixture();
    const { rowEtag } = await staleRow(f);
    const before = await treeOf(f);

    await expect(move(f, NOTE, "1-projects/kept.md", "someone-elses-version")).rejects.toMatchObject({ code: "CONFLICT" });

    expect(await treeOf(f)).toEqual(before);
    expect((await rowOf(f, NOTE)).etag).toBe(rowEtag);
  });

  test("the row's own version still moves the note, as it always did", async () => {
    const f = await keyedFixture();
    const { rowEtag } = await staleRow(f);

    await expect(move(f, NOTE, "1-projects/kept.md", rowEtag)).resolves.toMatchObject({ rowed: true });
  });
});
