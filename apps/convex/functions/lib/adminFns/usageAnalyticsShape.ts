/**
 * THE USAGE TAB'S SHAPE: what `usageAnalytics.report` returns, in one place so
 * the action and the screen agree. Hosts, days, cleaned routes, fixed button
 * names and counts; never a person or an address. See `./usageAnalytics.ts`.
 */

import { v, type Infer } from "convex/values";

const day = v.object({ day: v.string(), count: v.number() });

const site = v.object({
  host: v.string(),
  /** Sessions on the host in the window. */
  visits: v.number(),
  /** People (PostHog's merged persons) on the host in the window. */
  visitors: v.number(),
  priorVisits: v.number(),
  priorVisitors: v.number(),
  /** Sessions per day, oldest first, every day of the window. */
  daily: v.array(day),
});

const time = v.object({
  sessions: v.number(),
  people: v.number(),
  medianSeconds: v.number(),
  averageSeconds: v.number(),
  totalSeconds: v.number(),
});

const page = v.object({ route: v.string(), views: v.number(), people: v.number() });
const button = v.object({ button: v.string(), clicks: v.number(), people: v.number() });

export const usageAnalyticsValidator = v.union(
  /** No PostHog key on this deployment. */
  v.object({ connected: v.literal(false) }),
  /** PostHog could not be asked; the words are ours, never PostHog's body. */
  v.object({ connected: v.literal(true), error: v.string() }),
  v.object({
    connected: v.literal(true),
    error: v.null(),
    days: v.number(),
    sites: v.array(site),
    /** `null` when no session was counted in that window. */
    time: v.union(time, v.null()),
    priorTime: v.union(time, v.null()),
    /** The most viewed cleaned routes, most first. */
    pages: v.array(page),
    /** The most pressed named buttons, most first. */
    buttons: v.array(button),
  }),
);

export type UsageAnalytics = Infer<typeof usageAnalyticsValidator>;
export type UsageSite = Infer<typeof site>;
export type UsageTime = Infer<typeof time>;
export type UsagePageRow = Infer<typeof page>;
export type UsageButtonRow = Infer<typeof button>;
