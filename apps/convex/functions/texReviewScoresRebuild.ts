/**
 * Rebuild one day's Tex scores note from the anonymous score rows
 * (`texReviews.ts`), for a day whose note fell behind them.
 *
 * The note is a rendering of the rows and every review rewrites it whole, so a
 * day whose rewrites failed (2026-10-24 and 25: the second rewrite of a note
 * that had become a collaboration document always conflicted, `bugNotes.ts`
 * `fileTeamNote`) is repaired by rendering it once more. Run by hand through
 * the "Tex scores rebuild" workflow, which prints only the counts this answers:
 * the repository and its job logs are public.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, internalQuery } from "../_generated/server";
import { fileTeamNote } from "./bugNotes";
import { renderScoresNote, reviewFolder, scoresNotePath } from "./lib/feedback/texReviewNote";
import { folderJobsOf } from "./lib/nodes/folderJobs";
import { pinnedContextWorkspace } from "./lib/pinnedContext";
import { guestNamesIn } from "./lib/pinnedReaders";
import { MAX_SCORES_PER_DAY } from "./texReviews";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const dayScores = internalQuery({
  args: { day: v.string() },
  handler: async (ctx, { day }) => {
    const pinned = await pinnedContextWorkspace(ctx);
    if (pinned === null) return null;
    const rows = await ctx.db
      .query("texReviewScores")
      .withIndex("by_day", (q) => q.eq("day", day))
      .take(MAX_SCORES_PER_DAY);
    return {
      destination: {
        workspaceId: pinned._id,
        folder: reviewFolder((await folderJobsOf(ctx.db, pinned._id)).jobs.areas ?? null),
        pinReaders: await guestNamesIn(ctx, pinned._id),
      },
      rows: rows
        .sort((a, b) => a.at - b.at)
        .map(({ at, kind, reason, goal, independence, turns, friendly, calm }) => ({ at, kind, reason, goal, independence, turns, friendly, calm })),
    };
  },
});

/** `{ rows, written }`: how many rows the day has, and whether its note now shows them. */
export const rebuildScoresNote = internalAction({
  args: { day: v.string() },
  returns: v.object({ rows: v.number(), written: v.boolean() }),
  handler: async (ctx, { day }) => {
    if (!DAY.test(day)) throw new Error("day must be YYYY-MM-DD");
    const found = await ctx.runQuery(internal.functions.texReviewScoresRebuild.dayScores, { day });
    if (found === null || found.rows.length === 0) return { rows: found?.rows.length ?? 0, written: false };
    const written = await fileTeamNote(
      ctx,
      found.destination,
      scoresNotePath(found.destination.folder, day),
      renderScoresNote(day, found.rows),
      "tex_scores_note",
      { replace: true },
    );
    return { rows: found.rows.length, written };
  },
});

