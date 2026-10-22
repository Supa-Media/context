/**
 * Nudging a stopped chunked move of a built-in folder (`functions/folderNumbersNudge.ts`):
 * a move whose pages stopped is found, one page runs, and the watchdog has it
 * again. What it prints never carries a path or quoted text.
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
