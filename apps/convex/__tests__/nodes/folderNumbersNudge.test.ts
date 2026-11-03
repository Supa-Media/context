/**
 * Nudging a stopped chunked move of a built-in folder (`functions/folderNumbersNudge.ts`):
 * a move whose pages stopped is found, one page runs, and the watchdog has it
 * again. What it prints never carries a path or quoted text.
 *
 * Sabotage (temporary local edits, reverted): dropping the object-home check in `nudge` → "a stopped move in a
 * workspace whose notes live in its object is left as it is" fails (its page runs and its row is touched).
 */

import { describe, expect, test } from "vitest";
import { internal } from "../../_generated/api";
import { errorWords } from "../../functions/lib/nodes/folderNumbers";
import { keyedFixture } from "./keyedFixture.helpers";

const HOUR = 60 * 60_000;

describe("nudging a stopped built-in folder move", () => {
  test("a move stopped for an hour gets a page, and one that is moving along is left alone", async () => {
    const f = await keyedFixture();
    const base = {
      workspaceId: f.ws,
      trash: false,
      state: "moving",
      scope: "private",
      grantedNames: [],
      privacyEtag: null,
      pass: 1,
      moved: 1,
      left: 0,
      now: 1,
      createdAt: 1,
    };
    await f.t.run(async (ctx) => {
      await ctx.db.insert("rowMoves", {
        ...base,
        from: "4-archive",
        to: "archive",
        updatedAt: Date.now() - HOUR,
      } as never);
      await ctx.db.insert("rowMoves", {
        ...base,
        from: "2-areas",
        to: "areas",
        updatedAt: Date.now(),
      } as never);
      await ctx.db.insert("rowMoves", {
        ...base,
        from: "my-own",
        to: "archive",
        updatedAt: Date.now() - HOUR,
      } as never);
    });

    const looked = await f.t.action(
      internal.functions.folderNumbersNudge.nudge,
      { dryRun: true },
    );
    expect(looked.moves).toEqual([
      { from: "4-archive", to: "archive", result: "stopped" },
    ]);

    const nudged = await f.t.action(
      internal.functions.folderNumbersNudge.nudge,
      { dryRun: false },
    );
    expect(nudged.moves).toHaveLength(1);
    expect(nudged.moves[0].result).toMatch(/^(moving|done)/);
    const after = await f.t.run(async (ctx) =>
      (await ctx.db.query("rowMoves").collect()).find(
        (move) => move.from === "4-archive",
      ),
    );
    expect(Date.now() - (after?.updatedAt ?? 0)).toBeLessThan(HOUR);
  });

  test("a stopped move in a workspace whose notes live in its object is left as it is", async () => {
    const f = await keyedFixture();
    await f.t.run(async (ctx) => {
      await ctx.db.insert("workspaceObjectHomes", { workspaceId: f.ws, home: "object", since: Date.now() });
      await ctx.db.insert("rowMoves", {
        workspaceId: f.ws,
        from: "4-archive",
        to: "archive",
        trash: false,
        state: "moving",
        scope: "private",
        grantedNames: [],
        privacyEtag: null,
        pass: 1,
        moved: 1,
        left: 0,
        now: 1,
        createdAt: 1,
        updatedAt: Date.now() - HOUR,
      } as never);
    });
    const before = await f.t.run(async (ctx) => (await ctx.db.query("rowMoves").collect())[0].updatedAt);

    const nudged = await f.t.action(internal.functions.folderNumbersNudge.nudge, { dryRun: false });

    expect(nudged.moves).toEqual([{ from: "4-archive", to: "archive", result: "left, object" }]);
    const after = await f.t.run(async (ctx) => (await ctx.db.query("rowMoves").collect())[0].updatedAt);
    expect(after).toBe(before);
  });

  test("an error's words lose their paths and quoted text", () => {
    const words = errorWords(
      new Error(
        'Uncaught Error: no row at "0-inbox/secret.md" in 1-projects/plan.md at handler (../functions/x.ts:3:1)',
      ),
    );
    expect(words).not.toContain("secret");
    expect(words).not.toContain("plan.md");
    expect(words).not.toContain("functions/x.ts");
    expect(words).toContain("Uncaught Error: no row at");
  });
});
