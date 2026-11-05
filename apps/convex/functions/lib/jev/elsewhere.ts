/**
 * Metering for a decision the gateway asked of Clef itself (decide and the
 * last look, Dev2's pick 2026-11-05: decide moves into the gateway and keeps
 * its daily cap and usage rows). The gate is `withJev`'s own (`jev.gate`);
 * this writes the usage row `withJev` would have written, priced the same way:
 * read tokens estimated from the characters Clef read, one Clef row.
 *
 * Here, in `lib/jev/`, because nothing else in the control plane may name the
 * decision model (`__tests__/jev.test.ts`).
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { costMicroUsd, estimateTokens } from "./meter";
import { CLEF_MODEL } from "./models";

/** What one Worker report carries: counts and characters, never words. */
export type DecidedElsewhere = { calls: number; failed: number; refused: number; questions: number; chars: number; ms: number };

/** Write the usage row for decisions the gateway made, as `withJev` would have; nothing when the report is empty. */
export async function recordDecidedElsewhere(ctx: Pick<ActionCtx, "runMutation">, workspaceId: Id<"workspaces">, report: DecidedElsewhere): Promise<void> {
  if (report.calls + report.failed + report.refused === 0) return;
  const tokens = report.calls > 0 ? estimateTokens(report.chars) : 0;
  await ctx.runMutation(internal.functions.jev.recordUsage, {
    feature: "textDecide",
    workspaceId,
    calls: report.calls,
    failed: report.failed,
    refused: report.refused,
    questions: report.questions,
    tokens,
    ms: report.ms,
    models: report.calls > 0 ? [{ model: CLEF_MODEL, calls: report.calls, input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, costMicroUsd: costMicroUsd(tokens) }] : [],
  });
}
