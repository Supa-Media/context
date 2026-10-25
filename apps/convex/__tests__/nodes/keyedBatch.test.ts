/**
 * A batch of moves in a keyed workspace (`move_notes` applied, `functions/lib/nodes/rowMoveBatch.ts`)
 * lands whole or not at all. Each move is a row change (`rowMove.ts`) and the
 * batch is one mutation (`nodeRowMoves.rowMoveBatch`): a move that is refused
 * throws, and the transaction takes back every move before it. The rules each
 * note carries are written before the rows move, once for the batch, and taken
 * back if the batch is refused.
 *
 * Each case fails if its guard is removed:
 *  - the throw on a refused move (a refusal that returns, not throws, keeps the moves before it);
 *  - the batch's total row cap (`too_large` across moves, each within the cap);
 *  - the per-move etag check (a stale version refuses the batch);
 *  - the privacy carry for each move (a private note moved into a team folder widens);
 *  - the visibility check (a team caller moving a note it cannot see);
 *  - the barrier's operation (`nodesMoveBatch`) answering the same batch.
 */

import { describe, expect, test } from "vitest";
import { internal } from "../../_generated/api";
import { startRowMoveBatch } from "../../functions/lib/nodes/rowMoveBatch";
import { runMoveOperation } from "../../functions/lib/nodes/moveBarrier";
import { PRIVACY_KEY } from "../../functions/lib/privacy";
import { OWNER, TEAM, listed, type Fixture } from "./moveFixture.helpers";
import {
  bigFolder,
  bytesOf,
  keyedFixture,
  liveAt,
  rowOf,
  treeOf,
} from "./keyedFixture.helpers";
import { storedPathsOnly } from "./treeRows.helpers";

type Move = { from: string; to: string; expectedEtag?: string };

const batch = (f: Fixture, moves: Move[], clearance = OWNER) =>
  startRowMoveBatch(f.ctx, { workspaceId: f.ws, store: f.store, moves, clearance, now: Date.now() });

describe("a batch of moves in a keyed workspace lands whole", () => {
  test("every note moves as its row: each keeps its id, key and bytes, and nothing is copied", async () => {
    const f = await keyedFixture();
    const keep = await rowOf(f, "1-projects/keep.md");
    const r = await rowOf(f, "3-resources/r.md");
    const bytesBefore = bytesOf(f);

    const moved = await batch(f, [
      { from: "1-projects/keep.md", to: "1-projects/kept.md" },
      { from: "3-resources/r.md", to: "1-projects/r.md" },
    ]);

    expect(moved.map((move) => [move.from, move.to])).toEqual([
      ["1-projects/keep.md", "1-projects/kept.md"],
      ["3-resources/r.md", "1-projects/r.md"],
    ]);
    expect(await rowOf(f, "1-projects/kept.md")).toMatchObject({ _id: keep._id, noteId: keep.noteId, storageKey: keep.storageKey });
    expect(await rowOf(f, "1-projects/r.md")).toMatchObject({ _id: r._id, noteId: r.noteId });
    expect(await liveAt(f, "1-projects/keep.md")).toBe(false);
    expect(await liveAt(f, "3-resources/r.md")).toBe(false);
    expect(bytesOf(f)).toEqual(bytesBefore);
    expect(await f.t.query(internal.functions.nodeRowMoves.drawn, { workspaceId: f.ws })).toEqual([]);
  });

  test("the barrier answers a batch with the same moves", async () => {
    const f = await keyedFixture();

    const answer = await runMoveOperation(
      f.ctx,
      {
        workspaceId: f.ws,
        scope: "private",
        operation: { kind: "nodesMoveBatch", moves: [{ from: "1-projects/keep.md", to: "1-projects/kept.md" }] },
      },
      f.store,
    );

    expect(answer).toMatchObject({ kind: "moveBatch", ok: true, moves: [{ from: "1-projects/keep.md", to: "1-projects/kept.md" }] });
    expect(await listed(f.owner, f.ws, "1-projects")).toContain("1-projects/kept.md");
  });
});

describe("a batch that one move cannot make true changes nothing", () => {
  test("a move onto a live note is refused, and the moves before it are not applied", async () => {
    const f = await keyedFixture();
    const before = await treeOf(f);
    const rulesBefore = f.store.snapshot()[PRIVACY_KEY];

    await expect(
      batch(f, [
        { from: "1-projects/keep.md", to: "1-projects/kept.md" },
        { from: "3-resources/r.md", to: "1-projects/launch/brief.md" },
      ]),
    ).rejects.toMatchObject({ code: "DESTINATION_EXISTS" });

    expect(await treeOf(f)).toEqual(before);
    expect(f.store.snapshot()[PRIVACY_KEY]).toBe(rulesBefore);
  });

  test("a note whose version is out of date refuses the batch, and the current versions are not moved either", async () => {
    const f = await keyedFixture();
    const before = await treeOf(f);
    const keep = await rowOf(f, "1-projects/keep.md");

    await expect(
      batch(f, [
        { from: "1-projects/keep.md", to: "1-projects/kept.md", expectedEtag: keep.etag },
        { from: "3-resources/r.md", to: "1-projects/r.md", expectedEtag: "not-the-etag" },
      ]),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(await treeOf(f)).toEqual(before);
  });

  test("the mutation itself takes back every move before a refused one", async () => {
    const f = await keyedFixture();
    const before = await treeOf(f);

    await expect(
      f.t.mutation(internal.functions.nodeRowMoves.rowMoveBatch, {
        workspaceId: f.ws,
        moves: [
          { from: "1-projects/keep.md", to: "1-projects/kept.md" },
          { from: "3-resources/r.md", to: "1-projects/launch/brief.md" },
        ],
        privacyEtag: await f.t.run(async (ctx) => {
          const mirror = await ctx.db.query("nodePrivacy").withIndex("by_workspace", (q) => q.eq("workspaceId", f.ws)).unique();
          return mirror?.etag ?? null;
        }),
        now: Date.now(),
      }),
    ).rejects.toThrow();

    expect(await treeOf(f)).toEqual(before);
  });
});

describe("the batch's row cap is the sum over its moves", () => {
  // A cap exists only on stored paths: a built-path move of any size is one row change.
  storedPathsOnly();
  test("two folders, each within the cap, that together exceed it are refused as too large, and nothing moves", async () => {
    const f = await keyedFixture();
    await bigFolder(f, "2-areas/a", 300, 1000);
    await bigFolder(f, "2-areas/b", 300, 2000);
    const before = await treeOf(f);

    await expect(
      batch(f, [
        { from: "2-areas/a", to: "3-resources/a" },
        { from: "2-areas/b", to: "3-resources/b" },
      ]),
    ).rejects.toMatchObject({ code: "FOLDER_TOO_LARGE" });

    expect(await treeOf(f)).toEqual(before);
  });

  test("the mutation counts the total too: a batch over the cap throws and moves nothing", async () => {
    const f = await keyedFixture();
    await bigFolder(f, "2-areas/a", 300, 1000);
    await bigFolder(f, "2-areas/b", 300, 2000);
    const before = await treeOf(f);

    await expect(
      f.t.mutation(internal.functions.nodeRowMoves.rowMoveBatch, {
        workspaceId: f.ws,
        moves: [
          { from: "2-areas/a", to: "3-resources/a" },
          { from: "2-areas/b", to: "3-resources/b" },
        ],
        privacyEtag: null,
        now: Date.now(),
      }),
    ).rejects.toThrow();

    expect(await treeOf(f)).toEqual(before);
  });
});

describe("what a batch carries with each of its notes", () => {
  test("a private note moved into a team folder in a batch stays private for a team member", async () => {
    const f = await keyedFixture();

    await batch(f, [
      { from: "1-projects/secret/codes.md", to: "3-resources/codes.md" },
      { from: "1-projects/keep.md", to: "3-resources/kept.md" },
    ]);

    expect(await liveAt(f, "3-resources/codes.md")).toBe(true);
    expect(await listed(f.member, f.ws, "3-resources")).not.toContain("3-resources/codes.md");
    expect(await listed(f.owner, f.ws, "3-resources")).toContain("3-resources/codes.md");
  });

  test("a note the caller cannot see is not found, and the batch moves nothing", async () => {
    const f = await keyedFixture();
    const before = await treeOf(f);

    await expect(
      batch(f, [
        { from: "1-projects/keep.md", to: "1-projects/kept.md" },
        { from: "1-projects/secret/codes.md", to: "3-resources/codes.md" },
      ], TEAM),
    ).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });

    expect(await treeOf(f)).toEqual(before);
  });
});
