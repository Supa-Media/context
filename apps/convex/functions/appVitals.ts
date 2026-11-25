/**
 * THE APP'S OWN VITALS, for the Context usage source: how long the app took to start on a phone and to load in a
 * browser or the desktop app, and whether each session ran without an error (decided by the owner, 2026-11-25: the
 * app reports Start time, Load time and Clean sessions itself, rather than reading Sentry).
 *
 * The app sends one row per session per kind (`apps/mobile/features/observability/vitals.ts`), only while the person
 * is signed in and has Crash reports on. What is kept is the platform, the kind, the milliseconds and a random
 * session id the app made at launch: never the account, a device id, a screen or an error's words. `exportRows` is
 * what the gateway's hourly usage run reads (`/gateway/usage/export`) into the owners-only `app.csv` sheet.
 */

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalQuery } from "../_generated/server";
import { internalMutation, mutation } from "./lib/rowWatch/mutations";
import { getAuthUserId } from "./lib/signedIn";
import { tryConsumeRateLimit } from "./lib/rateLimit";

export const VITAL_PLATFORMS = ["web", "desktop", "ios", "android"] as const;
export const VITAL_KINDS = ["start", "load", "session", "error"] as const;
/** A session id as the app makes one: 16 lower-case hex. */
const SESSION = /^[0-9a-f]{16}$/;
/** A timing past ten minutes is a tab left in the background, not a start. */
export const MAX_VITAL_MS = 600_000;
/** Kept as long as the sheet keeps them. */
export const VITALS_RETENTION_DAYS = 30;
/** A few sessions an hour is a person; more is a loop or someone filling the sheet. */
export const VITALS_PER_HOUR = 40;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 86_400_000;
const PRUNE_BATCH = 500;
export const MAX_VITAL_EXPORT_ROWS = 20_000;

const platform = v.union(v.literal("web"), v.literal("desktop"), v.literal("ios"), v.literal("android"));
const kind = v.union(v.literal("start"), v.literal("load"), v.literal("session"), v.literal("error"));

/** Whether a report is one the sheet keeps: a session id, and milliseconds only on a timing and only in range. */
export function vitalShape(args: { kind: string; ms?: number; session: string }): boolean {
  if (!SESSION.test(args.session)) return false;
  const timed = args.kind === "start" || args.kind === "load";
  if (!timed) return args.ms === undefined;
  return typeof args.ms === "number" && Number.isFinite(args.ms) && args.ms >= 0 && args.ms <= MAX_VITAL_MS;
}

/** One vital from the signed-in app. Signed out, malformed, a repeat or over the hour's budget: dropped, quietly. */
export const report = mutation({
  args: { platform, kind, ms: v.optional(v.number()), session: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const userId = (await getAuthUserId(ctx)) as Id<"users"> | null;
    if (userId === null || !vitalShape(args)) return false;
    const seen = await ctx.db
      .query("appVitals")
      .withIndex("by_session_kind", (q) => q.eq("session", args.session).eq("kind", args.kind))
      .first();
    if (seen !== null) return false;
    if (!(await tryConsumeRateLimit(ctx, { key: `app.vitals:${userId}`, limit: VITALS_PER_HOUR, windowMs: HOUR_MS }))) return false;
    const ms = args.ms === undefined ? undefined : Math.round(args.ms);
    await ctx.db.insert("appVitals", { at: Date.now(), platform: args.platform, kind: args.kind, session: args.session, ...(ms === undefined ? {} : { ms }) });
    return true;
  },
});

/** Rows past their retention, a batch at a time (`crons.ts`). */
export const prune = internalMutation({
  args: { at: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const cutoff = (args.at ?? Date.now()) - VITALS_RETENTION_DAYS * DAY_MS;
    const old = await ctx.db
      .query("appVitals")
      .withIndex("by_at", (q) => q.lt("at", cutoff))
      .take(PRUNE_BATCH);
    for (const row of old) await ctx.db.delete(row._id);
    return { deleted: old.length };
  },
});

export interface VitalsExport {
  vitals: { at: number; platform: string; kind: string; ms: number | null; session: string }[];
  cut: boolean;
}

/** Every vital since `since` (ms), oldest first. */
export const exportRows = internalQuery({
  args: { since: v.number() },
  handler: async (ctx, args): Promise<VitalsExport> => {
    const rows = await ctx.db
      .query("appVitals")
      .withIndex("by_at", (q) => q.gte("at", args.since))
      .take(MAX_VITAL_EXPORT_ROWS + 1);
    return {
      vitals: rows.slice(0, MAX_VITAL_EXPORT_ROWS).map((row) => ({ at: row.at, platform: row.platform, kind: row.kind, ms: row.ms ?? null, session: row.session })),
      cut: rows.length > MAX_VITAL_EXPORT_ROWS,
    };
  },
});
