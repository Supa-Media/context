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
import { internalMutation } from "./lib/rowWatch/mutations";
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
        .map(({ at, kind, reason, goal, independence, turns, friendly, calm, task, signals }) => ({ at, kind, reason, goal, independence, turns, friendly, calm, task: task ?? null, signals: signals ?? [] })),
    };
  },
});

type DayScores = {
  destination: Parameters<typeof fileTeamNote>[1] & { folder: string };
  rows: Parameters<typeof renderScoresNote>[1];
};

/** `{ rows, written }`: how many rows the day has, and whether its note now shows them. */
export const rebuildScoresNote = internalAction({
  args: { day: v.string() },
  returns: v.object({ rows: v.number(), written: v.boolean() }),
  handler: async (ctx, { day }): Promise<{ rows: number; written: boolean }> => {
    if (!DAY.test(day)) throw new Error("day must be YYYY-MM-DD");
    // Typed here: an action that reads its own module through `internal` is otherwise circular.
    const found: DayScores | null = await ctx.runQuery(internal.functions.texReviewScoresRebuild.dayScores, { day });
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


const MINUTE = /^\d{4}$/;

/** The UTC `HHMM` a score row was filed in, as its review note is named (`2026-11-01 0036 goal 3 <id>.md`). */
const minuteOf = (at: number) => new Date(at).toISOString().slice(11, 16).replace(":", "");

/**
 * Drop a day's score rows of one kind filed in the given UTC minutes: repeat reviews of a conversation already scored
 * (2026-11-01: one group chat was filed as a full review five more times after the first, because its history kept
 * being rebuilt from a stale note; `docs/decisions/texting-assistant/group-memory-one-copy.md`). `dryRun` counts and
 * drops nothing. Then `rebuildScoresNote` renders the day again. Counts only: the workflow's log is public.
 */
export const dropRepeatScores = internalMutation({
  args: { day: v.string(), kind: v.union(v.literal("one"), v.literal("group")), minutes: v.array(v.string()), dryRun: v.boolean() },
  returns: v.object({ matched: v.number(), dropped: v.number() }),
  handler: async (ctx, { day, kind, minutes, dryRun }) => {
    if (!DAY.test(day) || minutes.length === 0 || minutes.length > 20 || !minutes.every((minute) => MINUTE.test(minute))) throw new Error("day must be YYYY-MM-DD and minutes HHMM");
    const wanted = new Set(minutes);
    const rows = await ctx.db
      .query("texReviewScores")
      .withIndex("by_day", (q) => q.eq("day", day))
      .take(MAX_SCORES_PER_DAY);
    const matched = rows.filter((row) => row.kind === kind && wanted.has(minuteOf(row.at)));
    if (!dryRun) for (const row of matched) await ctx.db.delete(row._id);
    return { matched: matched.length, dropped: dryRun ? 0 : matched.length };
  },
});
