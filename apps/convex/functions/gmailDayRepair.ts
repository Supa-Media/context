/**
 * The one-time repair of Gmail days that froze before #1923, as counts only.
 *
 * Until #1923 a day note someone had opened kept only what it held when it was
 * first opened: every later pass's mail was written and then undone by the
 * collaboration document (`lib/filesFns/gmailDayStore.ts`). #1926 rebuilds
 * today and yesterday on every pass; older days stayed short. The owner chose
 * "Repair now" on 2026-10-19: every live Gmail connection reads its last fifty
 * messages again, through the same first-connect import
 * (`lib/filesFns/gmailRecentImport.ts`), which rebuilds each day those
 * messages land on from Gmail's live state.
 *
 * It also ends a Gmail rate-limit wait longer than the short ladder (#1929)
 * allows: those were set on the old one, up to six hours, and would otherwise
 * hold the row past the repair. A daily quota keeps its wait.
 *
 * It re-arms only an import that has not run since the fix, so running it
 * again changes nothing once the re-armed imports finish. Run from the `Gmail
 * day repair` workflow against production, whose log is public: it answers
 * with counts and never a row id, an address or a workspace.
 */

import { v } from "convex/values";
import { internalMutation } from "./lib/rowWatch/mutations";
import { DAILY_LIMIT_REASONS, SYNC_FAILURE_BACKOFF_MS } from "./lib/googleSchedule";
import { REPAIR_MAX_DAYS, repairDaysSince } from "./lib/googleSync/repairDays";

/** Imports that finished before this (the owner's "Repair now", 2026-10-19) ran on a frozen day. */
export const GMAIL_DAY_REPAIR_CUTOFF = Date.parse("2026-10-19T15:40:00.000Z");
/** A bound on the loop, not on any deployment we have. */
const REPAIR_ROWS = 1_000;

export const rearmRecentImports = internalMutation({
  args: {},
  returns: v.object({ rearmed: v.number(), alreadyPending: v.number(), repairedSinceFix: v.number(), waitsShortened: v.number(), truncated: v.boolean() }),
  handler: async (ctx) => {
    const now = Date.now();
    const counts = { rearmed: 0, alreadyPending: 0, repairedSinceFix: 0, waitsShortened: 0, truncated: false };
    let seen = 0;
    for await (const row of ctx.db.query("googleConnections")) {
      if (row.disconnectedAt !== undefined || row.gmail === undefined) continue;
      if (seen === REPAIR_ROWS) {
        counts.truncated = true;
        break;
      }
      seen += 1;
      let gmail = row.gmail;
      if (
        gmail.lastFailureCode === "GOOGLE_RATE_LIMITED" &&
        !(gmail.lastFailureReason !== undefined && DAILY_LIMIT_REASONS.has(gmail.lastFailureReason)) &&
        gmail.retryAt !== undefined &&
        gmail.retryAt > now + SYNC_FAILURE_BACKOFF_MS
      ) {
        gmail = { ...gmail, retryAt: now };
        await ctx.db.patch(row._id, { gmail, nextSyncAt: Math.min(row.nextSyncAt ?? now, now) });
        counts.waitsShortened += 1;
      }
      const current = gmail.recentImport;
      if (current?.status === "pending") {
        counts.alreadyPending += 1;
        continue;
      }
      if (current?.completedAt !== undefined && current.completedAt >= GMAIL_DAY_REPAIR_CUTOFF) {
        counts.repairedSinceFix += 1;
        continue;
      }
      await ctx.db.patch(row._id, {
        gmail: { ...gmail, recentImport: { status: "pending", attempts: 0 } },
        nextSyncAt: Math.min(row.nextSyncAt ?? now, now),
      });
      counts.rearmed += 1;
    }
    return counts;
  },
});

/**
 * The window repair: every live Gmail connection rebuilds each day from
 * `since` to today from Gmail's live state, a few days per forward pass
 * (`lib/googleSync/repairDays.ts`). The owner asked for it on 2026-10-19 when
 * the last fifty messages reached only two days back on a busy mailbox. A
 * row that still owes days is left as it is, so running it twice changes
 * nothing. Counts only, for the same public log.
 */
export const queueDayRepair = internalMutation({
  args: { since: v.string() },
  returns: v.object({ queued: v.number(), alreadyQueued: v.number(), days: v.number(), truncated: v.boolean() }),
  handler: async (ctx, { since }) => {
    const now = Date.now();
    const days = repairDaysSince(since, now);
    if (days === null) throw new Error(`since must be a UTC date within the last ${REPAIR_MAX_DAYS} days.`);
    const counts = { queued: 0, alreadyQueued: 0, days: days.length, truncated: false };
    if (days.length === 0) return counts;
    let seen = 0;
    for await (const row of ctx.db.query("googleConnections")) {
      if (row.disconnectedAt !== undefined || row.gmail === undefined) continue;
      if (seen === REPAIR_ROWS) {
        counts.truncated = true;
        break;
      }
      seen += 1;
      if ((row.gmail.repairDays?.length ?? 0) > 0) {
        counts.alreadyQueued += 1;
        continue;
      }
      // Due now: the flag a walk that ran out of pages sets, and cleared the same way.
      await ctx.db.patch(row._id, { gmail: { ...row.gmail, repairDays: days }, syncCatchUp: true });
      counts.queued += 1;
    }
    return counts;
  },
});
