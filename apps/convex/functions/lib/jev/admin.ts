/**
 * Staff views of Jev: usage and cost per feature, and the kill switches.
 * Registered in `functions/admin.ts`, behind `requireAdmin`.
 */

import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import { ALL_JEV_FEATURES, JEV_FEATURES, type JevFeatureName, isJevFeature } from "./features";
import { disabledByEnv, featureIsOn, usdPerMtok, utcDay } from "./meter";

const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_REPORT_DAYS = 90;

export interface JevFeatureReport {
  feature: string;
  label: string;
  on: boolean;
  disabledByEnv: boolean;
  dailyCallsPerWorkspace: number;
  workspaces: number;
  calls: number;
  failed: number;
  refused: number;
  questions: number;
  tokens: number;
  costUsd: number;
  days: Array<{ day: string; calls: number; failed: number; refused: number; tokens: number; costUsd: number }>;
}

export async function jevUsageReportHandler(
  ctx: QueryCtx,
  args: { days?: number },
): Promise<{ usdPerMtok: number; allOff: boolean; features: JevFeatureReport[] }> {
  const days = Math.max(1, Math.min(MAX_REPORT_DAYS, Math.floor(args.days ?? 30)));
  const since = utcDay(Date.now() - (days - 1) * DAY_MS);
  const allSwitch = await ctx.db
    .query("jevSwitches")
    .withIndex("by_feature", (q) => q.eq("feature", ALL_JEV_FEATURES))
    .unique();
  const features: JevFeatureReport[] = [];
  for (const name of Object.keys(JEV_FEATURES) as JevFeatureName[]) {
    const rows = await ctx.db
      .query("jevUsage")
      .withIndex("by_feature_day", (q) => q.eq("feature", name).gte("day", since))
      .collect();
    const byDay = new Map<string, JevFeatureReport["days"][number]>();
    const workspaces = new Set<string>();
    const total = { calls: 0, failed: 0, refused: 0, questions: 0, tokens: 0, cost: 0 };
    for (const row of rows) {
      workspaces.add(row.workspaceId);
      total.calls += row.calls;
      total.failed += row.failed;
      total.refused += row.refused;
      total.questions += row.questions;
      total.tokens += row.tokens;
      total.cost += row.costMicroUsd;
      const day = byDay.get(row.day) ?? { day: row.day, calls: 0, failed: 0, refused: 0, tokens: 0, costUsd: 0 };
      day.calls += row.calls;
      day.failed += row.failed;
      day.refused += row.refused;
      day.tokens += row.tokens;
      day.costUsd += row.costMicroUsd / 1e6;
      byDay.set(row.day, day);
    }
    features.push({
      feature: name,
      label: JEV_FEATURES[name].label,
      on: await featureIsOn(ctx, name),
      disabledByEnv: disabledByEnv(name),
      dailyCallsPerWorkspace: JEV_FEATURES[name].dailyCallsPerWorkspace,
      workspaces: workspaces.size,
      calls: total.calls,
      failed: total.failed,
      refused: total.refused,
      questions: total.questions,
      tokens: total.tokens,
      costUsd: total.cost / 1e6,
      days: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
    });
  }
  return { usdPerMtok: usdPerMtok(), allOff: allSwitch?.off === true, features };
}

/** Flip one feature, or "*" for all of them. `null` clears it back to the registry default. */
export async function setJevSwitchHandler(
  ctx: MutationCtx,
  args: { feature: string; off: boolean | null; reason?: string },
): Promise<{ feature: string; off: boolean | null }> {
  if (args.feature !== ALL_JEV_FEATURES && !isJevFeature(args.feature)) {
    throw new Error(`Unknown Jev feature "${args.feature}".`);
  }
  const row = await ctx.db
    .query("jevSwitches")
    .withIndex("by_feature", (q) => q.eq("feature", args.feature))
    .unique();
  if (args.off === null) {
    if (row) await ctx.db.delete(row._id);
    return { feature: args.feature, off: null };
  }
  const patch = { off: args.off, updatedAt: Date.now(), ...(args.reason ? { reason: args.reason.slice(0, 200) } : {}) };
  if (row) await ctx.db.patch(row._id, patch);
  else await ctx.db.insert("jevSwitches", { feature: args.feature, ...patch });
  return { feature: args.feature, off: args.off };
}
