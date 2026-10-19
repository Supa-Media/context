/**
 * Why the Google sweep is or is not starting passes, as counts only.
 *
 * Run from the `Google sync health` workflow against production, whose log is
 * public: so this answers with numbers and our own status codes, and never a
 * row id, an address, a workspace or a timestamp that belongs to a person.
 *
 * It replays `sweepDueGoogleSyncs`'s decision for the rows the sweep would
 * read next, so "nothing is syncing" can be told apart from "the sweep's batch
 * is full of rows it skips", "a workspace's lock is held" and "a claim never
 * reported".
 */

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalQuery, type QueryCtx } from "../_generated/server";
import { calendarConnectEnabled } from "./calendarConnect";
import { mailConnectEnabled } from "./googleConnect";
import { isDue, productBackingOff, SYNC_STALL_MS, syncableProductsOf } from "./lib/googleSchedule";

/** The sweep's own batch size (`googleSync.ts`). */
const SWEEP_BATCH = 50;
/** How far past the batch to count due rows, so a backlog's size is visible. */
const DUE_SCAN = 1_000;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function bump(counts: Record<string, number>, key: string) {
  counts[key] = (counts[key] ?? 0) + 1;
}

/** Where a workspace's check-in stands, as one of a few fixed words. */
async function checkInState(ctx: QueryCtx, workspaceId: Id<"workspaces">, now: number): Promise<string> {
  const beat = await ctx.db
    .query("texHeartbeats")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .first();
  if (beat === null) return "noCheckIns";
  const ran = (
    await ctx.db
      .query("auditEvents")
      .withIndex("by_workspace_at", (q) => q.eq("workspaceId", workspaceId).gte("at", now - HOUR))
      .take(500)
  ).some((event) => event.action === "heartbeat.run");
  if (ran) return "ranLastHour";
  if (beat.nextBeatAt === null) return "waitingForText";
  if (beat.nextBeatAt <= now) return "overdue";
  return beat.nextBeatAt - now < HOUR ? "dueWithinHour" : "dueLater";
}

export const report = internalQuery({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    const now = Date.now();
    const due = await ctx.db
      .query("googleConnections")
      .withIndex("by_sync_due", (q) => q.eq("disconnectedAt", undefined).lte("nextSyncAt", now))
      .take(DUE_SCAN);

    // What the sweep would do with each row of its next batch.
    const batch: Record<string, number> = {};
    for (const row of due.slice(0, SWEEP_BATCH)) {
      const products = syncableProductsOf(row).filter((product) =>
        product === "calendar" ? calendarConnectEnabled() : mailConnectEnabled(),
      );
      if (products.length === 0) {
        bump(batch, "noEnabledProduct");
        continue;
      }
      if (!isDue({ ...row, products }, now)) {
        bump(batch, products.every((product) => productBackingOff(row, product, now)) ? "notDueAllBackingOff" : "notDue");
        continue;
      }
      if (row.products.includes("chat") || row.products.includes("calendar")) {
        const claims = await ctx.db
          .query("googleConnections")
          .withIndex("by_workspace_sync_started", (q) =>
            q.eq("workspaceId", row.workspaceId).gte("syncStartedAt", now - SYNC_STALL_MS + 1),
          )
          .take(SWEEP_BATCH + 1);
        if (claims.some((other) => other._id !== row._id && (other.products.includes("chat") || other.products.includes("calendar")))) {
          bump(batch, "workspaceLocked");
          continue;
        }
      }
      if (row.syncStartedAt !== undefined && now - row.syncStartedAt < SYNC_STALL_MS) {
        bump(batch, "claimedRecently");
        continue;
      }
      bump(batch, "claimable");
    }

    // Every live row: how long its Gmail has gone without a pass that read mail, and why.
    const rows = await ctx.db.query("googleConnections").take(DUE_SCAN);
    const live = rows.filter((row) => row.disconnectedAt === undefined);
    const gmailIdle: Record<string, number> = {};
      const gmailFailure: Record<string, number> = {};
    const gmailWroteLastHour: Record<string, number> = {};
    // For a mailbox that wrote lately: whether its owner's check-in was brought forward and ran (`lib/heartbeats/mail.ts`).
    const checkInAfterMail: Record<string, number> = {};
    let openClaims = 0;
    let staleClaims = 0;
    let pushPending = 0;
    for (const row of live) {
      if (row.syncStartedAt !== undefined) {
        if (now - row.syncStartedAt < SYNC_STALL_MS) openClaims += 1;
        else staleClaims += 1;
      }
      if (row.push?.pending !== undefined && Object.keys(row.push.pending).length > 0) pushPending += 1;
      if (!row.products.includes("gmail") || row.gmail === undefined) continue;
      const idle = row.gmail.lastSyncedAt === undefined ? Infinity : now - row.gmail.lastSyncedAt;
      bump(gmailIdle, idle < 15 * 60 * 1000 ? "under15m" : idle < HOUR ? "15mTo1h" : idle < 6 * HOUR ? "1to6h" : idle < 24 * HOUR ? "6to24h" : "over24h");
      // Whether its passes wrote anything into the bucket lately, from the pass's own audit row.
      const wrote = (
        await ctx.db
          .query("auditEvents")
          .withIndex("by_workspace_at", (q) => q.eq("workspaceId", row.workspaceId).gte("at", now - HOUR))
          .take(500)
      ).filter((event) => event.action === "google_sync_wrote" && event.details?.connectionId === row._id && event.details?.product === "gmail");
      bump(gmailWroteLastHour, wrote.length === 0 ? "none" : wrote.length < 4 ? "1to3" : "4plus");
      if (wrote.length > 0) bump(checkInAfterMail, await checkInState(ctx, row.workspaceId, now));
      if (row.gmail.lastFailureCode !== undefined) bump(gmailFailure, row.gmail.lastFailureCode);
      if (row.gmail.lastFailureReason !== undefined) bump(gmailFailure, `reason:${row.gmail.lastFailureReason}`);
      if (productBackingOff(row, "gmail", now)) {
        bump(gmailFailure, "backingOffNow");
        const wait = row.gmail.retryAt! - now;
        bump(gmailFailure, wait < 5 * MINUTE ? "retryIn:under5m" : wait < HOUR ? "retryIn:5mTo1h" : "retryIn:over1h");
      }
    }

    return {
      liveRows: live.length,
      dueRows: due.length,
      dueOverdueOver1h: due.filter((row) => row.nextSyncAt !== undefined && now - row.nextSyncAt > HOUR).length,
      sweepBatch: batch,
      openClaims,
      staleClaims,
      pushPending,
      gmailIdle,
      gmailFailure,
      gmailWroteLastHour,
      checkInAfterMail,
      health: Object.fromEntries(
        Object.entries(
          live.reduce<Record<string, number>>((counts, row) => {
            bump(counts, row.health ?? "unset");
            return counts;
          }, {}),
        ),
      ),
    };
  },
});
