/**
 * People let in by phone before Let in texted anyone (Dev2, 2026-10-12:
 * "Text them once"). Until PR #1557 a phone row was let in silently, since
 * the "You're in" mail had no address to go to. This finds those rows and
 * texts each one once, through the same claim as `admitRow`.
 *
 * A row is untold when it is let in, joined with a phone (no email), has no
 * `admittedTextAt`, and no account holds its phone yet: somebody who already
 * signed in found out on their own and is not texted.
 *
 * Handlers only; `functions/admin.ts` authorizes with `requireAdmin` inline.
 */

import { internal } from "../../../_generated/api";
import type { Doc } from "../../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import { WAITLIST_BATCH } from "./waitlist";

/** Let-in rows read per call; the backlog is days of phone sign-ups, far below this. */
const SCAN_LIMIT = 10_000;

async function untoldRows(ctx: QueryCtx): Promise<Doc<"waitlist">[]> {
  const admitted = await ctx.db
    .query("waitlist")
    .withIndex("by_status_joinedAt", (q) => q.eq("status", "admitted"))
    .take(SCAN_LIMIT);
  const untold: Doc<"waitlist">[] = [];
  for (const row of admitted) {
    if (row.phone === undefined || row.email !== undefined || row.admittedTextAt !== undefined) continue;
    const holder = await ctx.db
      .query("users")
      .withIndex("by_phone", (q) => q.eq("phone", row.phone!))
      .first();
    if (holder === null) untold.push(row);
  }
  return untold;
}

export async function untoldCountHandler(ctx: QueryCtx): Promise<number> {
  return (await untoldRows(ctx)).length;
}

/** Claim and schedule one text per untold row, at most `WAITLIST_BATCH` a press. */
export async function textUntoldHandler(ctx: MutationCtx): Promise<{ texted: number; left: number }> {
  const rows = await untoldRows(ctx);
  const now = Date.now();
  const batch = rows.slice(0, WAITLIST_BATCH);
  for (const row of batch) {
    await ctx.db.patch(row._id, { admittedTextAt: now });
    await ctx.scheduler.runAfter(0, internal.functions.waitlistText.sendAdmitted, { waitlistId: row._id });
  }
  return { texted: batch.length, left: rows.length - batch.length };
}
