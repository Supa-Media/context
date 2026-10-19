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
 * It re-arms only an import that has not run since the fix, so running it
 * again changes nothing once the re-armed imports finish. Run from the `Gmail
 * day repair` workflow against production, whose log is public: it answers
 * with counts and never a row id, an address or a workspace.
 */

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

/** Imports that finished before this (the owner's "Repair now", 2026-10-19) ran on a frozen day. */
export const GMAIL_DAY_REPAIR_CUTOFF = Date.parse("2026-10-19T15:40:00.000Z");
/** A bound on the loop, not on any deployment we have. */
const REPAIR_ROWS = 1_000;

export const rearmRecentImports = internalMutation({
  args: {},
  returns: v.object({ rearmed: v.number(), alreadyPending: v.number(), repairedSinceFix: v.number(), truncated: v.boolean() }),
  handler: async (ctx) => {
    const now = Date.now();
    const counts = { rearmed: 0, alreadyPending: 0, repairedSinceFix: 0, truncated: false };
    let seen = 0;
    for await (const row of ctx.db.query("googleConnections")) {
      if (row.disconnectedAt !== undefined || row.gmail === undefined) continue;
      if (seen === REPAIR_ROWS) {
        counts.truncated = true;
        break;
      }
      seen += 1;
      const current = row.gmail.recentImport;
      if (current?.status === "pending") {
        counts.alreadyPending += 1;
        continue;
      }
      if (current?.completedAt !== undefined && current.completedAt >= GMAIL_DAY_REPAIR_CUTOFF) {
        counts.repairedSinceFix += 1;
        continue;
      }
      await ctx.db.patch(row._id, {
        gmail: { ...row.gmail, recentImport: { status: "pending", attempts: 0 } },
        nextSyncAt: Math.min(row.nextSyncAt ?? now, now),
      });
      counts.rearmed += 1;
    }
    return counts;
  },
});
