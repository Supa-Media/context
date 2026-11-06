/**
 * Search by meaning's rows, counted, never named (2026-11-04: @seyi's meaning
 * search had been silent for two days and nothing an agent can read said why).
 *
 * Counts of rows by status, error code and cause, and the standing of the
 * largest rows by notes indexed: their status, codes, switch and how long ago
 * they changed. Never a workspace id, a slug, an index name or a path: this
 * repository is public, and so is the log of the `Meaning index census`
 * workflow that runs it. Internal only.
 */

import { v } from "convex/values";
import { internalQuery } from "../_generated/server";

const ROWS = 4000;
const LARGEST = 5;

const largestValidator = v.object({
  notesIndexed: v.number(),
  status: v.string(),
  enabled: v.boolean(),
  optedOut: v.boolean(),
  errorCode: v.union(v.string(), v.null()),
  errorCause: v.union(v.string(), v.null()),
  hoursSinceUpdate: v.number(),
});

export const run = internalQuery({
  args: {},
  returns: v.object({
    rows: v.number(),
    byState: v.record(v.string(), v.number()),
    largest: v.array(largestValidator),
    truncated: v.boolean(),
  }),
  handler: async (ctx) => {
    const rows = await ctx.db.query("meaningIndexes").take(ROWS + 1);
    const truncated = rows.length > ROWS;
    const kept = rows.slice(0, ROWS);
    const byState: Record<string, number> = {};
    for (const row of kept) {
      // Our own closed sets only (`lib/vectorize.ts`), never a provider's text.
      const key = [row.status, row.enabled ? "on" : "disabled", row.optedOut ? "opted_out" : "", row.errorCode ?? "", row.errorCause ?? ""]
        .filter((part) => part !== "")
        .join("/");
      byState[key] = (byState[key] ?? 0) + 1;
    }
    const now = Date.now();
    const largest = [...kept]
      .sort((a, b) => (b.notesIndexed ?? 0) - (a.notesIndexed ?? 0))
      .slice(0, LARGEST)
      .map((row) => ({
        notesIndexed: row.notesIndexed ?? 0,
        status: row.status,
        enabled: row.enabled,
        optedOut: row.optedOut === true,
        errorCode: row.errorCode ?? null,
        errorCause: row.errorCause ?? null,
        hoursSinceUpdate: Math.round(((now - row.updatedAt) / 3_600_000) * 10) / 10,
      }));
    return { rows: kept.length, byState, largest, truncated };
  },
});
