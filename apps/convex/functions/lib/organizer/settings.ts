/**
 * Auto-organize's switches, as the control plane keeps them.
 *
 * Premium includes auto-organize and it is **on unless the owner switches it
 * off** (decided by the owner, 2026-09-26). Two paths lead to a first sweep:
 *
 *  - Somebody who upgrades from now on is told at checkout, so the upgrade
 *    itself writes the row and schedules the first sweep
 *    (`startOrganizerOnUpgrade`).
 *  - Somebody already paying on the day this shipped was never told. For them
 *    there is no row, the app shows the one-time notice, and nothing is read
 *    until they have seen it and a day has passed (`acknowledgeNotice`).
 *
 * Nothing here holds note text, a path or a title: see
 * `lib/schema/organizer.ts`.
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import { internal } from "../../../_generated/api";
import { planFor, statusOf } from "../billing/plan";
import { planIsPaying } from "../premium";

export type OrganizerKind = "done" | "archive" | "file";

/** A day between the notice and the first sweep, so "turn it off" is real. */
export const NOTICE_GRACE_MS = 24 * 60 * 60 * 1000;
/** A workspace is swept at most this often by the schedule. */
export const SWEEP_EVERY_MS = 24 * 60 * 60 * 1000;
/** A sweep that has said "running" this long has died; the next may start. */
export const SWEEP_STALE_MS = 30 * 60 * 1000;

export const NO_AUTOPILOT = { done: false, archive: false, file: false } as const;

export async function organizerRow(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
): Promise<Doc<"organizerSettings"> | null> {
  return await ctx.db
    .query("organizerSettings")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
}

export async function workspaceIsPaying(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<boolean> {
  return planIsPaying(statusOf(await planFor(ctx, workspaceId)));
}

/** Write the row, creating it with everything off-by-nothing if it is new. */
export async function patchOrganizerRow(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  patch: Partial<Omit<Doc<"organizerSettings">, "_id" | "_creationTime" | "workspaceId">>,
): Promise<Id<"organizerSettings">> {
  const now = Date.now();
  const row = await organizerRow(ctx, workspaceId);
  if (row) {
    await ctx.db.patch(row._id, { ...patch, updatedAt: now });
    return row._id;
  }
  return await ctx.db.insert("organizerSettings", {
    workspaceId,
    autopilot: { ...NO_AUTOPILOT },
    pending: 0,
    ...patch,
    updatedAt: now,
  });
}

/**
 * Whether a sweep may run now. The question every path asks at the moment it
 * acts (the schedule, a press, the upgrade), because each of them was decided
 * some time before it runs.
 */
export function sweepIsDue(
  row: Doc<"organizerSettings"> | null,
  paying: boolean,
  now: number,
  { ignoreInterval }: { ignoreInterval: boolean },
): boolean {
  if (!paying || !row || row.off === true) return false;
  if (row.startsAt === undefined || row.startsAt > now) return false;
  const sweep = row.sweep;
  if (sweep?.state === "running" && now - sweep.startedAt < SWEEP_STALE_MS) return false;
  if (ignoreInterval || !sweep) return true;
  return now - sweep.startedAt >= SWEEP_EVERY_MS;
}

/**
 * Called from the billing mutations on every plan change. On the move into a
 * paying plan, somebody who was told at checkout gets their first sweep now,
 * which is the "this is so great" moment the feature is on by default for.
 * A returning subscriber keeps whatever they chose last time, off included.
 */
export async function startOrganizerOnUpgrade(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  wasPaying: boolean,
  isPaying: boolean,
): Promise<void> {
  if (wasPaying || !isPaying) return;
  const now = Date.now();
  const row = await organizerRow(ctx, workspaceId);
  if (row?.off === true) return;
  if (!row || row.startsAt === undefined) {
    await patchOrganizerRow(ctx, workspaceId, { noticeAt: now, startsAt: now });
  }
  await ctx.scheduler.runAfter(0, internal.functions.organizer.runSweep, { workspaceId, force: true });
}
