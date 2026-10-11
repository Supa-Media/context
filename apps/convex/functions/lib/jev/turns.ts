/**
 * The shared half of a gateway-run model call: resolve the grant, count the
 * call before anything is spent, and meter the tokens the gateway reports
 * afterwards. Used by the built-in model (`functions/builtinModel.ts`) and
 * meeting summaries (`functions/meetingSummary.ts`). Which clients may call,
 * and what a model defaults to, stay with each caller.
 *
 * Nothing here sees text: the gateway reports counts only.
 */

import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { resolveGrantByAccessTokenHandler } from "../controlPlane/session";
import { CLEF_MODEL } from "./models";
import { addModelUsage, addUsage, costMicroUsd, gate, type JevRefusal, MODEL_NAME, writingCostMicroUsd } from "./meter";
import type { JevFeatureName } from "./features";

/** Largest token count one report may carry; a turn is at most eight model calls. */
export const MAX_REPORTED_TOKENS = 2_000_000;

/** The grant behind a hashed token, if it is live and reaches the expected workspace. */
export async function resolveTurn(
  ctx: MutationCtx,
  hashedAccessToken: string,
  expectedWorkspaceId: string | null,
): Promise<{ clientId: string; workspaceId: Id<"workspaces"> } | null> {
  const session = await resolveGrantByAccessTokenHandler(ctx, { hashedAccessToken });
  if (session === null) return null;
  const wanted = expectedWorkspaceId ?? session.workspaceId;
  if (wanted !== session.workspaceId) return null;
  return { clientId: session.clientId, workspaceId: session.workspaceId };
}

export type TurnVerdict = { allowed: true; remaining: number } | { allowed: false; reason: JevRefusal };

/**
 * May this turn run? Counts it as one call when it may, or as a refusal when
 * it may not, so the cap is enforced before anything is spent.
 */
export async function countTurn(
  ctx: MutationCtx,
  feature: JevFeatureName,
  workspaceId: Id<"workspaces">,
  now: number,
): Promise<TurnVerdict> {
  const verdict = await gate(ctx, feature, workspaceId, now);
  const counts = { failed: 0, questions: 0, tokens: 0, ms: 0 };
  if (!verdict.allowed) {
    await addUsage(ctx, feature, workspaceId, { ...counts, calls: 0, refused: 1 }, now);
    return verdict;
  }
  await addUsage(ctx, feature, workspaceId, { ...counts, calls: 1, refused: 0 }, now);
  return { allowed: true, remaining: verdict.remaining - 1 };
}

/** A count as the gateway reports it: whole, non-negative, and never above `MAX_REPORTED_TOKENS`. */
export function clampTokens(n: number): number {
  return Number.isFinite(n) ? Math.min(MAX_REPORTED_TOKENS, Math.max(0, Math.floor(n))) : 0;
}

/** A model name as the gateway reports it, when it is well formed; undefined otherwise. */
export function reportedModel(raw: unknown): string | undefined {
  return typeof raw === "string" && MODEL_NAME.test(raw) ? raw : undefined;
}

/** What a finished model call reported, as the gateway sends it. Counts only, never text. */
export interface TurnReport {
  inputTokens: number;
  outputTokens: number;
  /** Prompt tokens read from the provider's cache, priced at its cache-read rate. */
  cacheReadTokens?: number;
  /** Prompt tokens written to the provider's cache, priced at its cache-write rate. */
  cacheWriteTokens?: number;
  /**
   * Tokens the turn read through Clef, the decision model. Priced at Clef's
   * rate, never the writing model's. Only the built-in model reports these.
   */
  decisionTokens?: number;
  /** The model that answered. Absent: `defaultModel`. Malformed: priced as `defaultModel`, with no model row. */
  model?: string;
  failed: boolean;
  ms: number;
}

/**
 * Meter a finished call: the same figures go to `jevUsage` (through `addUsage`)
 * and, split by model, to `aiModelUsage`, so the two tables always agree.
 * `defaultModel` is the model the feature runs on, used for a missing or
 * malformed model name.
 */
export async function recordTurn(
  ctx: MutationCtx,
  feature: JevFeatureName,
  workspaceId: Id<"workspaces">,
  report: TurnReport,
  defaultModel: string,
  now: number,
): Promise<void> {
  const usage = {
    input: clampTokens(report.inputTokens),
    output: clampTokens(report.outputTokens),
    cacheRead: clampTokens(report.cacheReadTokens ?? 0),
    cacheWrite: clampTokens(report.cacheWriteTokens ?? 0),
  };
  const model = reportedModel(report.model) ?? defaultModel;
  // Cache tokens are written tokens too: priced at their own rates, so they must
  // not be priced again at Clef's rate for `decisionTokens`.
  const written = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  const decision = clampTokens(report.decisionTokens ?? 0);
  const writtenMicroUsd = writingCostMicroUsd({ ...usage, model });
  await addUsage(
    ctx,
    feature,
    workspaceId,
    {
      // A failed call moves its call to `failed`, so the cap still counts it once.
      calls: report.failed ? -1 : 0,
      failed: report.failed ? 1 : 0,
      refused: 0,
      questions: 0,
      tokens: written + decision,
      ms: Number.isFinite(report.ms) ? Math.max(0, Math.floor(report.ms)) : 0,
      writtenTokens: written,
      writtenMicroUsd,
    },
    now,
  );
  // A missing model is the feature's default; a malformed one is passed on as it is,
  // and `addModelUsage` ignores it, so it has no row (its cost stays in `jevUsage`).
  await addModelUsage(
    ctx,
    feature,
    workspaceId,
    report.model ?? defaultModel,
    { calls: report.failed ? 0 : 1, ...usage, costMicroUsd: writtenMicroUsd },
    now,
  );
  if (decision > 0) {
    await addModelUsage(
      ctx,
      feature,
      workspaceId,
      CLEF_MODEL,
      { calls: 0, input: decision, output: 0, cacheRead: 0, cacheWrite: 0, costMicroUsd: costMicroUsd(decision) },
      now,
    );
  }
}
