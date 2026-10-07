/**
 * What the app asks about a routine note, and the two things it may change:
 * "run it now", and the time zone a person's routines fall back to.
 */

import { ConvexError } from "convex/values";
import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import { callerId, personalNameFor } from "../filesFns/access";
import { requireWorkspaceAccess, requireWorkspaceRole } from "../workspaceAuth";
import { isTimeZone, scheduleFromNote } from "./model";

export type RoutineView = {
  cadence: { unit: "minute" | "hour" | "day" | "week" | "month"; every: number };
  at: { hour: number; minute: number } | null;
  days: number[] | null;
  monthDay: number | null;
  timeZone: string | null;
  paused: boolean;
  send: "text" | "note" | "both";
  to: string[];
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastOutcome: string | null;
  writer: string | null;
};

/**
 * The routine row for a note, for any member of its workspace; `null` when
 * the note is not a routine (or not one yet). A non-member is refused exactly
 * as for a workspace that does not exist.
 */
export async function routineForNoteHandler(
  ctx: QueryCtx,
  args: { workspaceId: Id<"workspaces">; path: string },
): Promise<RoutineView | null> {
  const userId = await callerId(ctx);
  await requireWorkspaceAccess(ctx, args.workspaceId, userId);
  if (scheduleFromNote(args.path, "") === null) return null;
  const row = await ctx.db
    .query("routines")
    .withIndex("by_workspace_path", (q) => q.eq("workspaceId", args.workspaceId).eq("path", args.path))
    .unique();
  if (row === null) return null;
  return {
    cadence: row.cadence,
    at: row.at ?? null,
    days: row.days ?? null,
    monthDay: row.monthDay ?? null,
    timeZone: row.timeZone ?? null,
    paused: row.paused,
    send: row.send,
    to: row.to,
    nextRunAt: row.nextRunAt,
    lastRunAt: row.lastRunAt ?? null,
    lastOutcome: row.lastOutcome ?? null,
    writer: await personalNameFor(ctx, row.writerUserId),
  };
}

/** Run a routine at the next poll. Editors and owners only; a paused one stays paused. */
export async function runRoutineNowHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces">; path: string },
): Promise<boolean> {
  const userId = await callerId(ctx);
  await requireWorkspaceRole(ctx, args.workspaceId, userId, "editor");
  const row = await ctx.db
    .query("routines")
    .withIndex("by_workspace_path", (q) => q.eq("workspaceId", args.workspaceId).eq("path", args.path))
    .unique();
  if (row === null || row.paused || row.nextRunAt === null) return false;
  await ctx.db.patch(row._id, { nextRunAt: Date.now(), updatedAt: Date.now() });
  return true;
}

/** The zone a person's routines run in when the file names none. */
export async function setMyTimeZoneHandler(
  ctx: MutationCtx,
  args: { timeZone: string },
): Promise<null> {
  const userId = await callerId(ctx);
  if (!isTimeZone(args.timeZone)) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "That isn't a time zone. Use a name like America/New_York.",
    });
  }
  const existing = await ctx.db
    .query("accountTimeZones")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  const now = Date.now();
  if (existing.length === 0) {
    await ctx.db.insert("accountTimeZones", { userId, timeZone: args.timeZone, updatedAt: now });
  } else {
    await ctx.db.patch(existing[0]!._id, { timeZone: args.timeZone, updatedAt: now });
    for (const extra of existing.slice(1)) await ctx.db.delete(extra._id);
  }
  return null;
}

/** Account deletion: the zone goes with the person. */
export async function deleteAccountTimeZoneOf(ctx: MutationCtx, userId: Id<"users">): Promise<void> {
  const rows = await ctx.db
    .query("accountTimeZones")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const row of rows) await ctx.db.delete(row._id);
}

/** Workspace deletion: its routine rows and any pending scan. The notes stay in the bucket. */
export async function deleteWorkspaceRoutines(ctx: MutationCtx, workspaceId: Id<"workspaces">): Promise<void> {
  const rows = await ctx.db
    .query("routines")
    .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const row of rows) await ctx.db.delete(row._id);
  const pending = await ctx.db
    .query("routineReconciles")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const row of pending) await ctx.db.delete(row._id);
}
