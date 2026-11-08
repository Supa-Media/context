/**
 * MAIL COPIED INTO NOTES AGAIN, FOR THE PEOPLE A FLAG NAMES.
 *
 * Copying stopped for everyone on 2026-10-21 (`docs/decisions/communications/
 * live-not-copied.md`), and with it the one thing that started a check-in when
 * mail arrived: `lookSoonForMail` is called only when a Gmail pass writes a day
 * (`googleSync.recordGoogleForwardSyncPass`). On 2026-11-07 an airline email
 * that needed action sat until the next fixed check-in slot while another
 * assistant texted about it at once. The owner, 2026-11-08: "bring back that
 * functionality, but gate behind a flag".
 *
 * So, for a person with the `mail.in-notes` feature flag on, and nobody else:
 *
 *  - every minute this looks at each flagged person's personal workspace and
 *    starts a Gmail pass on any connection that is due, exactly as the old
 *    sweep did, and only for Gmail (never Calendar or Chat days);
 *  - the pass is the old one, unchanged: it writes the day notes, renews the
 *    Gmail push watch, and a pass that wrote mail brings the check-in forward;
 *  - the pass itself asks the flag again before it opens a credential
 *    (`forwardSyncJob.ts`), so turning the flag off stops the copying at the
 *    next pass even if one was already queued.
 *
 * The global sweep (`googleSync.sweepDueGoogleSyncs`) stays unscheduled;
 * `__tests__/copiesStopped.test.ts` still fails if anything runs it.
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import { internal } from "../../../_generated/api";
import { mailConnectEnabled } from "../googleConnect/config";
import { recordedDestinations } from "../googleConnect/rowPatches";
import { SYNC_STALL_MS, isDue, syncIntervalMinutesOf } from "../googleSchedule";
import { flagOnFor, peopleWithFlag } from "../featureFlags";

/** The feature flag that turns copying back on for one person. */
export const MAIL_IN_NOTES_FLAG = "mail.in-notes";

/** Gmail connections one person's workspace may hold that a look reads. */
const MAX_CONNECTIONS_A_PERSON = 10;

/** People, or connections when the flag is on for everyone, one look serves. */
export const MAX_FLAGGED = 50;

/** Whether `userId` has mail copied into their notes. */
export async function mailInNotesFor(ctx: QueryCtx, userId: Id<"users">): Promise<boolean> {
  return await flagOnFor(ctx, userId, "mail.in-notes");
}

/** The personal workspace `userId` owns, or null. */
async function personalWorkspace(ctx: QueryCtx, userId: Id<"users">): Promise<Doc<"workspaces"> | null> {
  const memberships = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(100);
  for (const membership of memberships) {
    if (membership.role !== "owner") continue;
    const workspace = await ctx.db.get(membership.workspaceId);
    if (workspace !== null && workspace.kind === "personal" && workspace.createdBy === userId) return workspace;
  }
  return null;
}

/** A Gmail connection this look may start a pass on now. */
export function gmailDue(row: Doc<"googleConnections">, now: number): boolean {
  if (row.disconnectedAt !== undefined || row.gmail === undefined) return false;
  if (!row.products.includes("gmail")) return false;
  if (row.health === "reconnect_required") return false;
  // A pass still running is never overtaken; a lost one is picked up after the stall.
  if (row.syncStartedAt !== undefined && now - row.syncStartedAt < SYNC_STALL_MS) return false;
  if (row.nextSyncAt !== undefined && row.nextSyncAt > now) return false;
  return isDue({ ...row, products: ["gmail"] }, now);
}

/**
 * One look: start a Gmail pass for every due connection of every flagged
 * person. Holds no decision the pass does not ask again.
 */
export async function startFlaggedMailPasses(ctx: MutationCtx, now: number): Promise<{ started: number }> {
  if (!mailConnectEnabled()) return { started: 0 };
  let started = 0;
  for (const row of await candidates(ctx, now)) {
    if (!gmailDue(row, now)) continue;
    await ctx.db.patch(row._id, {
      ...recordedDestinations(row),
      syncStartedAt: now,
      // Claimed: the next look finds it not due even if this pass never reports.
      nextSyncAt: now + syncIntervalMinutesOf(row) * 60_000,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.functions.files.runFileOperation, {
      workspaceId: row.workspaceId,
      scope: "private",
      operation: { kind: "googleForwardSync", connectionId: row._id, only: "gmail" },
    });
    started += 1;
  }
  return { started };
}

/** The connections a look considers: the flagged people's own, or every due one when it is on for everyone. */
async function candidates(ctx: MutationCtx, now: number): Promise<Doc<"googleConnections">[]> {
  const people = await peopleWithFlag(ctx, "mail.in-notes");
  if (people.everyone) {
    // The pass asks the flag again, and a claim moves a row out of this range.
    return await ctx.db
      .query("googleConnections")
      .withIndex("by_sync_due", (q) => q.eq("disconnectedAt", undefined).lte("nextSyncAt", now))
      .take(MAX_FLAGGED);
  }
  const rows: Doc<"googleConnections">[] = [];
  for (const userId of people.userIds.slice(0, MAX_FLAGGED)) {
    const workspace = await personalWorkspace(ctx, userId);
    if (workspace === null) continue;
    rows.push(
      ...(await ctx.db
        .query("googleConnections")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
        .take(MAX_CONNECTIONS_A_PERSON)),
    );
  }
  return rows;
}
