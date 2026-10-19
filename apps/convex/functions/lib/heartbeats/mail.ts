/**
 * New mail brings the next check-in forward
 * (`docs/decisions/texting-assistant/heartbeat.md`, "New mail").
 *
 * The owner, 2026-10-19, choosing "Yes, on new mail" on "Should a new email
 * that needs you start a check-in right away?": Google's 3:47 am email waited
 * for the 10:00 slot while another assistant texted about it at once. A Gmail
 * pass that wrote mail now moves the person's next look to a couple of minutes
 * away by day, or to 08:00 their time when it lands at night. The look itself
 * is the same check-in: it reads what changed, the model decides whether the
 * mail is worth a text, and most mail is not.
 *
 * Decided here, never by the model: how soon (`MAIL_SETTLE_MS`, so a burst of
 * mail is one look), how often (`MAIL_LOOK_SPACING_MS` after the last look
 * started), and that a person who has had `MAX_CHECK_IN_TEXTS_A_DAY` texts
 * from check-ins today gets no more looks until tomorrow's first slot.
 */

import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { accountTimeZone } from "../routines/access";
import { effectiveTimeZone, nextRunFor } from "../routines/model";
import { QUIET_UNTIL, isQuietHour, localDay } from "../attention/model";
import { HEARTBEAT_LEASE_MS, nextBeatAfter } from "./model";

/** Mail that lands within this of the first is read by the same look. */
export const MAIL_SETTLE_MS = 2 * 60 * 1000;

/** At most one look started by mail an hour: each one runs the model. */
export const MAIL_LOOK_SPACING_MS = 60 * 60 * 1000;

/** Texts from check-ins a person gets in one of their days, slots and mail together. */
export const MAX_CHECK_IN_TEXTS_A_DAY = 3;

/**
 * When a look for mail that arrived at `now` should run: soon by day, spaced
 * after the last look, and at 08:00 their time when it lands at night.
 */
export function mailLookAt(now: number, timeZone: string, lastLookAt: number | undefined): number {
  const soonest = Math.max(now + MAIL_SETTLE_MS, (lastLookAt ?? 0) + MAIL_LOOK_SPACING_MS);
  if (!isQuietHour(soonest, timeZone)) return soonest;
  const morning = nextRunFor({ cadence: { unit: "day", every: 1 }, at: QUIET_UNTIL, paused: false }, timeZone, soonest);
  return morning ?? soonest;
}

/** How many check-in texts the row says reached them on `day`. */
export function textsOn(row: { textedDay?: string; textedCount?: number }, day: string): number {
  return row.textedDay === day ? (row.textedCount ?? 0) : 0;
}

/** The first check-in slot of the person's next day, once today's texts are used up. */
export function firstBeatTomorrow(timeZone: string, now: number): number | null {
  const midnight = nextRunFor({ cadence: { unit: "day", every: 1 }, at: { hour: 0, minute: 0 }, paused: false }, timeZone, now);
  return midnight === null ? null : nextBeatAfter(timeZone, midnight);
}

/**
 * A Gmail pass wrote mail into this workspace: bring its owner's next
 * check-in forward, if they have check-ins and today's texts are not used up.
 * Never pushes a look later than it already was.
 */
export async function lookSoonForMail(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces">; now: number },
): Promise<void> {
  const row = await ctx.db
    .query("texHeartbeats")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .first();
  // No row: not a personal workspace with Tex. Null: waiting for their next text.
  if (row === null || row.nextBeatAt === null) return;
  const zone = effectiveTimeZone(undefined, await accountTimeZone(ctx, row.userId));
  if (textsOn(row, localDay(args.now, zone)) >= MAX_CHECK_IN_TEXTS_A_DAY) return;
  const running = row.claimedAt !== undefined && row.claimedAt + HEARTBEAT_LEASE_MS > args.now ? row.claimedAt : undefined;
  const lastLookAt = Math.max(row.lastBeatAt ?? 0, running ?? 0) || undefined;
  const at = mailLookAt(args.now, zone, lastLookAt);
  if (at >= row.nextBeatAt) return;
  await ctx.db.patch(row._id, { nextBeatAt: at, updatedAt: args.now });
}
