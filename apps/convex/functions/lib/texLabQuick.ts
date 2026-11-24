/**
 * A quick Lab run (Dev2, 2026-11-23: "close the loop to 10 minutes"; `functions/texLabRuns.ts` startRun): a draft's Dev
 * run that tests only the steps the draft changed (`scripts/tex-lab-run.mjs` scope), read against
 * main's newest Dev run on the same models, on the rows both scored. Decision: `docs/decisions/testing/lab-runs.md`.
 */

import type { Id } from "../../_generated/dataModel";
import { internal } from "../../_generated/api";
import type { MutationCtx } from "../../_generated/server";

/** A run open longer than this no longer counts as main's base on its way (`texLabRuns.ts` STALE_MS). */
const OPEN_MS = 3 * 60 * 60 * 1000;

/** Why a run's `quick` is refused, or null: it is a draft's Dev run, not aimed at a preview. */
export function quickRefusal(a: Record<string, unknown>, kind: unknown, versionId: string): string | null {
  if (a.quick === undefined) return null;
  if (typeof a.quick !== "boolean") return "quick is true or false";
  if (!a.quick) return null;
  if (kind !== "dev" || versionId === "main") return "a quick run is a draft's Dev run (kind dev): it tests the steps the draft changed against main";
  if (a.target !== undefined && a.target !== null) return "a quick run is not aimed at a preview";
  return null;
}

/**
 * A quick run always ends in a verdict: when main has no Dev run on the same models for this set, finished or on its
 * way, one starts beside it on main's code, so `vsMain` has a base by the time the draft's run is done: its id, if so.
 */
export async function quickBase(ctx: MutationCtx, who: { userId: Id<"users">; via: string }, set: "training" | undefined, models: "gw" | "cc", repeats: number, now: number): Promise<{ baseRunId?: Id<"texLabRuns"> }> {
  const mains = await ctx.db
    .query("texLabRuns")
    .withIndex("by_version", (q) => q.eq("versionId", "main"))
    .order("desc")
    .take(50);
  const open = (r: { stage: string; startedAt: number }) => (r.stage === "queued" || r.stage === "running") && now - r.startedAt < OPEN_MS;
  if (mains.some((r) => r.kind === "dev" && r.models === models && (r.set ?? "dev") === (set ?? "dev") && !r.code && (r.stage === "done" || open(r)))) return {};
  const baseRunId = await ctx.db.insert("texLabRuns", { versionId: "main", kind: "dev", ...(set ? { set } : {}), models, repeats, stage: "queued", by: who.userId, via: who.via.slice(0, 60), startedAt: now });
  await ctx.scheduler.runAfter(0, internal.functions.texLabRuns.dispatch, { runId: baseRunId });
  return { baseRunId };
}
