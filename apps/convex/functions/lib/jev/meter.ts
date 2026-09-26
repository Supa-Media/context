/**
 * The meter and the switches, as pure functions and database reads.
 *
 * Kept apart from `client.ts` so the rules are testable without a Worker and
 * without an action: a gate is a query, a record is a mutation.
 */

import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import { planFor, statusOf } from "../billing/plan";
import { planIsPaying } from "../premium";
import { ALL_JEV_FEATURES, JEV_FEATURES, type JevFeatureName } from "./features";

/** Jev's published price: input tokens only, output free (TypeSafe, 2026-09). */
export const DEFAULT_USD_PER_MTOK = 0.042;
/** Four characters a token is the usual English estimate; Jev does not report its count. */
export const CHARS_PER_TOKEN = 4;

export type JevRefusal = "disabled" | "switched_off" | "not_premium" | "daily_cap";

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** Price per million tokens, overridable per deployment without a code change. */
export function usdPerMtok(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.JEV_USD_PER_MTOK);
  return Number.isFinite(raw) && raw >= 0 && env.JEV_USD_PER_MTOK?.trim() ? raw : DEFAULT_USD_PER_MTOK;
}

export function costMicroUsd(tokens: number, env: Record<string, string | undefined> = process.env): number {
  return Math.round(tokens * usdPerMtok(env));
}

/**
 * `JEV_DISABLED` in the deployment's environment: "all" (or "*", "1", "true")
 * stops every feature, or a comma list names some. The hard stop that needs
 * no database write and survives a bad switch row.
 */
export function disabledByEnv(feature: string, env: Record<string, string | undefined> = process.env): boolean {
  const raw = (env.JEV_DISABLED ?? "").trim().toLowerCase();
  if (!raw) return false;
  if (["all", "*", "1", "true", "yes"].includes(raw)) return true;
  return raw.split(",").map((part) => part.trim()).includes(feature.toLowerCase());
}

async function switchRow(ctx: QueryCtx, feature: string) {
  return await ctx.db
    .query("jevSwitches")
    .withIndex("by_feature", (q) => q.eq("feature", feature))
    .unique();
}

/** On or off for everybody, from the env, the "*" switch, the feature's switch, then its default. */
export async function featureIsOn(ctx: QueryCtx, feature: JevFeatureName): Promise<boolean> {
  if (disabledByEnv(feature)) return false;
  const all = await switchRow(ctx, ALL_JEV_FEATURES);
  if (all?.off === true) return false;
  const own = await switchRow(ctx, feature);
  if (own) return !own.off;
  return JEV_FEATURES[feature].onByDefault;
}

export async function usageRow(ctx: QueryCtx, day: string, feature: string, workspaceId: Id<"workspaces">) {
  return await ctx.db
    .query("jevUsage")
    .withIndex("by_day_feature_workspace", (q) => q.eq("day", day).eq("feature", feature).eq("workspaceId", workspaceId))
    .unique();
}

/**
 * May this workspace use this feature right now, and for how many requests?
 * Asked at the moment of use, never cached across a run's start.
 */
export async function gate(
  ctx: QueryCtx,
  feature: JevFeatureName,
  workspaceId: Id<"workspaces">,
  now: number,
): Promise<{ allowed: true; remaining: number } | { allowed: false; reason: JevRefusal }> {
  if (disabledByEnv(feature)) return { allowed: false, reason: "disabled" };
  if (!(await featureIsOn(ctx, feature))) return { allowed: false, reason: "switched_off" };
  if (!planIsPaying(statusOf(await planFor(ctx, workspaceId)))) return { allowed: false, reason: "not_premium" };
  const used = await usageRow(ctx, utcDay(now), feature, workspaceId);
  const remaining = JEV_FEATURES[feature].dailyCallsPerWorkspace - ((used?.calls ?? 0) + (used?.failed ?? 0));
  if (remaining <= 0) return { allowed: false, reason: "daily_cap" };
  return { allowed: true, remaining };
}

export interface UsageDelta {
  calls: number;
  failed: number;
  refused: number;
  questions: number;
  tokens: number;
  ms: number;
}

export async function addUsage(
  ctx: MutationCtx,
  feature: JevFeatureName,
  workspaceId: Id<"workspaces">,
  delta: UsageDelta,
  now: number,
): Promise<void> {
  const day = utcDay(now);
  const cost = costMicroUsd(delta.tokens);
  const row = await usageRow(ctx, day, feature, workspaceId);
  if (row) {
    await ctx.db.patch(row._id, {
      calls: row.calls + delta.calls,
      failed: row.failed + delta.failed,
      refused: row.refused + delta.refused,
      questions: row.questions + delta.questions,
      tokens: row.tokens + delta.tokens,
      costMicroUsd: row.costMicroUsd + cost,
      ms: row.ms + delta.ms,
      updatedAt: now,
    });
    return;
  }
  await ctx.db.insert("jevUsage", { day, feature, workspaceId, ...delta, costMicroUsd: cost, updatedAt: now });
}
