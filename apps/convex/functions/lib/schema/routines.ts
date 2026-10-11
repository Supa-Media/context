import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Routines: the control plane's half (`docs/decisions/routines.md`).
 *
 * A routine is a note at `routines/<how-often>/<name>.md` in the customer's
 * bucket, and the note is the whole truth: what it says to do, how often, who
 * it texts. What is kept here is only what is needed to wake it on time — a
 * path, a schedule read off the folder and front matter, who it runs as, and
 * when it next runs — so the rows can be thrown away and rebuilt from the
 * bucket at any moment (`reconcileRoutines`).
 *
 * METADATA ONLY, and each omission is deliberate:
 *  - no body: the instruction is note content;
 *  - no `until:` text: it is a sentence the person wrote, so it is content too;
 *  - no problem sentences: they quote the note's own lines back;
 *  - no answer, ever: a run's outcome is a short code from a closed list
 *    (`ROUTINE_OUTCOMES`), and what it said lives in the person's bucket under
 *    `.context/agent/routines/`.
 */
export const routineTables = {
  routines: defineTable({
    workspaceId: v.id("workspaces"),
    /** Bucket-relative, exactly as listed: `routines/daily/standup.md`. */
    path: v.string(),
    /**
     * Who it runs as: the person who last wrote the file, while they can still
     * write here. Re-checked against live membership at the moment it runs.
     */
    writerUserId: v.id("users"),
    /**
     * How the writer was chosen. `signal`: someone who could write here was
     * seen writing the file. `fallback`: the file was found with no known
     * writer and runs as the owner, and then its `to:` is ignored and only the
     * owner is texted. Otherwise anyone able to put a file in `routines/`
     * without a signal could have the owner's private reach texted to them.
     */
    writerSource: v.union(v.literal("signal"), v.literal("fallback")),
    cadence: v.object({
      unit: v.union(
        v.literal("minute"),
        v.literal("hour"),
        v.literal("day"),
        v.literal("week"),
        v.literal("month"),
      ),
      every: v.number(),
    }),
    at: v.optional(v.object({ hour: v.number(), minute: v.number() })),
    /** Day numbers, 0 = Sunday. */
    days: v.optional(v.array(v.number())),
    /** Day of the month, -1 for the last. */
    monthDay: v.optional(v.number()),
    /** The file's own `timezone:` line, when it has one. */
    timeZone: v.optional(v.string()),
    paused: v.boolean(),
    send: v.union(v.literal("text"), v.literal("note"), v.literal("both")),
    /** Handles only, lower-case, without the `@`. */
    to: v.array(v.string()),
    /** Null when paused, when its writer is gone, or when it never runs. */
    nextRunAt: v.union(v.number(), v.null()),
    lastRunAt: v.optional(v.number()),
    /** A code from `ROUTINE_OUTCOMES` or `writer_gone`. Never text. */
    lastOutcome: v.optional(v.string()),
    /** The lease: when a run was handed out, and the id its result names. */
    claimedAt: v.optional(v.number()),
    runId: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_workspace_path", ["workspaceId", "path"])
    .index("by_nextRunAt", ["nextRunAt"])
    .index("by_run_id", ["runId"]),

  /**
   * A reconcile waiting to run, one per workspace, so a burst of saves shares
   * one scan. `writers` are the people the signals named for each path, kept
   * only until the scan that applies them.
   */
  routineReconciles: defineTable({
    workspaceId: v.id("workspaces"),
    writers: v.array(v.object({ path: v.string(), userId: v.id("users") })),
    scheduledAt: v.number(),
  }).index("by_workspace", ["workspaceId"]),

  /**
   * The time zone a person chose, for a routine whose file names none.
   *
   * Its own row rather than a field on `users`, which the auth framework
   * declares; one IANA name and a time. Deleted with the account
   * (`personalRows.ts`).
   */
  accountTimeZones: defineTable({
    userId: v.id("users"),
    timeZone: v.string(),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),
};
