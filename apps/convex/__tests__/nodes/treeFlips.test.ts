/**
 * A workspace builds its paths from parents only after a walk finds every row where its parents put it
 * (`functions/treeFlips.ts`, `lib/nodes/flipCheck.ts`; `paths-on-read.md`, "The flip").
 *
 * Sabotage, each run as a temporary local edit and reverted, and each failing here:
 *  - flip whatever the walk found: a row its parents misplace is shown somewhere else;
 *  - drop the check that the tree finds the row at its name: one of two live rows at a name vanishes;
 *  - drop the row-move check: a paged move stops halfway with its rows at the old name.
 */

import { describe, expect, test } from "vitest";
import { internal } from "../../_generated/api";
import { pathsBuilt } from "../../functions/lib/nodes/paths";
import { keyedFixture, rowOf } from "./keyedFixture.helpers";
import type { Fixture } from "./moveFixture.helpers";
import { storedPathsOnly } from "./treeRows.helpers";

// The flip is the way from stored paths to built ones.
storedPathsOnly();

async function walk(f: Fixture, now = Date.now()) {
  await f.t.mutation(internal.functions.treeFlips.flipWorkspace, { workspaceId: f.ws, now });
}

async function stateOf(f: Fixture) {
  return await f.t.run(async (ctx) => await ctx.db.query("treeFlips").withIndex("by_workspace", (q) => q.eq("workspaceId", f.ws)).unique());
}

async function built(f: Fixture): Promise<boolean> {
  return await f.t.run(async (ctx) => await pathsBuilt(ctx.db, f.ws));
}

describe("a workspace flips to built paths", () => {
  test("after a walk that finds every row where its parents put it", async () => {
    const f = await keyedFixture();
    expect(await built(f)).toBe(false);
    await f.t.mutation(internal.functions.treeFlips.flipDue, {});
    await f.t.finishAllScheduledFunctions(() => {});
    expect(await built(f)).toBe(true);
    expect(await stateOf(f)).toMatchObject({ walks: 1, mismatches: 0 });
    expect((await stateOf(f))?.flippedAt).toBeDefined();
    expect(await f.t.query(internal.functions.treeFlips.report, {})).toMatchObject({ keyedWorkspaces: 1, built: 1, flipped: 1, mismatches: 0 });
  });

  test("not while a row stands where its parents do not put it, and then once it is set right", async () => {
    const f = await keyedFixture();
    const brief = await rowOf(f, "1-projects/launch/brief.md");
    const resources = await rowOf(f, "3-resources");
    await f.t.run(async (ctx) => await ctx.db.patch(brief._id, { parentId: resources._id }));

    await walk(f);
    expect(await built(f)).toBe(false);
    expect(await stateOf(f)).toMatchObject({ walks: 1, mismatches: 1 });
    expect(await f.t.query(internal.functions.treeFlips.report, {})).toMatchObject({ waitingWithMismatches: 1, mismatches: 1 });

    const launch = await rowOf(f, "1-projects/launch");
    await f.t.run(async (ctx) => await ctx.db.patch(brief._id, { parentId: launch._id }));
    await walk(f);
    expect(await built(f)).toBe(true);
  });

  test("not while two live rows hold one name", async () => {
    const f = await keyedFixture();
    const keep = await rowOf(f, "1-projects/keep.md");
    await f.t.run(async (ctx) => {
      const { _id, _creationTime, ...copy } = (await ctx.db.get(keep._id))!;
      void _id;
      void _creationTime;
      await ctx.db.insert("nodes", { ...copy, noteId: "0190a000-0000-7000-8000-00000000ffff" });
    });
    await walk(f);
    expect(await built(f)).toBe(false);
    expect(await stateOf(f)).toMatchObject({ mismatches: 1 });
  });

  test("not while a row move is in flight, and at the next walk after it", async () => {
    const f = await keyedFixture();
    const move = await f.t.run(
      async (ctx) =>
        await ctx.db.insert("rowMoves", {
          workspaceId: f.ws,
          from: "1-projects/launch",
          to: "elsewhere",
          trash: false,
          state: "moving",
          scope: "private",
          grantedNames: [],
          privacyEtag: null,
          pass: 1,
          moved: 0,
          left: 1,
          now: 1,
          createdAt: 1,
          updatedAt: Date.now(),
        } as never),
    );
    await walk(f);
    expect(await built(f)).toBe(false);
    expect(await stateOf(f)).toMatchObject({ mismatches: 0, heldByMove: true });
    expect(await f.t.query(internal.functions.treeFlips.report, {})).toMatchObject({ waitingOnMove: 1 });

    await f.t.run(async (ctx) => await ctx.db.delete(move));
    await walk(f);
    expect(await built(f)).toBe(true);
  });

  test("an unkeyed workspace never starts, and a limit of none starts nothing", async () => {
    const f = await keyedFixture();
    await f.t.mutation(internal.functions.treeFlips.flipDue, { limit: 0 });
    await f.t.finishAllScheduledFunctions(() => {});
    expect(await stateOf(f)).toBeNull();

    await f.t.run(async (ctx) => {
      const copies = (await ctx.db.query("noteIdCopies").withIndex("by_workspace", (q) => q.eq("workspaceId", f.ws)).unique())!;
      await ctx.db.patch(copies._id, { keyedAt: undefined });
    });
    await f.t.mutation(internal.functions.treeFlips.flipDue, {});
    await f.t.finishAllScheduledFunctions(() => {});
    expect(await stateOf(f)).toBeNull();
    expect(await built(f)).toBe(false);
  });
});
