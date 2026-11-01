import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import { setupTest } from "./fixtures.helpers";

/**
 * REPEAT REVIEWS' SCORE ROWS ARE DROPPED BY THE MINUTE THEY WERE FILED IN (2026-11-01;
 * `functions/texReviewScoresRebuild.ts` `dropRepeatScores`).
 *
 * Sabotage record: matching on the minute alone, whatever the kind → "only that kind, only those minutes" fails;
 * deleting on a dry run → "a dry run drops nothing" fails.
 */

const at = (iso: string) => Date.parse(iso);
const row = (iso: string, kind: "one" | "group") => ({ day: iso.slice(0, 10), at: at(iso), kind, reason: "ended", goal: 3, independence: 3, turns: 3, friendly: 3, calm: 3 });

describe("dropping repeat review scores", () => {
  test("only that kind, only those minutes, and a dry run drops nothing", async () => {
    const t = setupTest();
    await t.run(async (ctx) => {
      for (const entry of [
        row("2026-11-01T00:36:12.000Z", "group"),
        row("2026-11-01T00:36:40.000Z", "one"),
        row("2026-11-01T00:45:00.000Z", "group"),
        row("2026-11-01T05:26:59.000Z", "group"),
        row("2026-10-31T05:26:00.000Z", "group"),
      ]) {
        await ctx.db.insert("texReviewScores", entry);
      }
    });
    const ask = { day: "2026-11-01", kind: "group" as const, minutes: ["0036", "0526"] };
    expect(await t.mutation(internal.functions.texReviewScoresRebuild.dropRepeatScores, { ...ask, dryRun: true })).toEqual({ matched: 2, dropped: 0 });
    expect(await t.run(async (ctx) => (await ctx.db.query("texReviewScores").collect()).length)).toBe(5);
    expect(await t.mutation(internal.functions.texReviewScoresRebuild.dropRepeatScores, { ...ask, dryRun: false })).toEqual({ matched: 2, dropped: 2 });
    const left = await t.run(async (ctx) => (await ctx.db.query("texReviewScores").collect()).map((entry) => `${new Date(entry.at).toISOString()} ${entry.kind}`).sort());
    expect(left).toEqual(["2026-10-31T05:26:00.000Z group", "2026-11-01T00:36:40.000Z one", "2026-11-01T00:45:00.000Z group"]);
  });

  test("a minute that is not HHMM is refused", async () => {
    const t = setupTest();
    await expect(t.mutation(internal.functions.texReviewScoresRebuild.dropRepeatScores, { day: "2026-11-01", kind: "group", minutes: ["00:36"], dryRun: true })).rejects.toThrow();
  });
});
