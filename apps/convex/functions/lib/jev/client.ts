/**
 * `withJev`: the only way a feature asks Jev anything.
 *
 *     await withJev(ctx, { feature: "organizer", workspaceId }, async (jev) => {
 *       if (!jev) return;                 // switched off, not Premium, over the cap, or no Worker
 *       const answers = await jev.decide({ state, questions });
 *       if (!answers) return;             // failed or refused: treat as "no opinion"
 *     });
 *
 * On the way in it asks the gate (kill switches, plan, daily cap). Every
 * `decide` is counted; on the way out, however the callback ends, the counts
 * are written to `jevUsage` in one mutation. A feature cannot skip the meter
 * because it never holds the transport.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import type { JevFeatureName } from "./features";
import { type JevRefusal, type UsageDelta, costMicroUsd, estimateTokens, writingCostMicroUsd } from "./meter";
import { CLEF_MODEL, GEMMA_MODEL, GLM_MODEL } from "./models";
import {
  type JevAnswers,
  type JevRequest,
  type JevTransport,
  type JevWriteRequest,
  type JevWritten,
  workerTransport,
} from "./worker";

export type { JevAnswers, JevRequest, JevWriteRequest, JevWritten } from "./worker";

export interface JevSession {
  /** Ask once. `null` means no answer: failed, refused, or the cap was reached mid-run. */
  decide(request: JevRequest): Promise<JevAnswers | null>;
  /**
   * Have the writing model answer in the given JSON shape. Counted against the
   * same cap as `decide`, and priced from the model's own token counts.
   * `null` is no answer, as above; the caller re-checks every field.
   */
  write(request: JevWriteRequest): Promise<JevWritten | null>;
  /** Requests left today before the cap, as of now. */
  readonly remaining: number;
}

export interface WithJevOptions {
  feature: JevFeatureName;
  workspaceId: Id<"workspaces">;
  /** Tests only: a transport that is not the Worker. */
  transport?: JevTransport | null;
}

/** What `withJev` needs from an action: a query and a mutation, nothing else. */
export type JevCtx = Pick<ActionCtx, "runQuery" | "runMutation">;

/** One model's answered requests in a run, as `recordUsage` takes them. */
interface ModelTotals {
  model: string;
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costMicroUsd: number;
}

/** Adds one answered request's share to its model's running total. */
function addToModel(totals: Map<string, ModelTotals>, model: string, share: Omit<ModelTotals, "model">) {
  const row = totals.get(model) ?? { model, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costMicroUsd: 0 };
  row.calls += share.calls;
  row.input += share.input;
  row.output += share.output;
  row.cacheRead += share.cacheRead;
  row.cacheWrite += share.cacheWrite;
  row.costMicroUsd += share.costMicroUsd;
  totals.set(model, row);
}

export async function withJev<T>(
  ctx: JevCtx,
  options: WithJevOptions,
  work: (jev: JevSession | null, refusal: JevRefusal | "unconfigured" | null) => Promise<T>,
): Promise<T> {
  const { feature, workspaceId } = options;
  const delta: Required<UsageDelta> = { calls: 0, failed: 0, refused: 0, questions: 0, tokens: 0, ms: 0, writtenMicroUsd: 0, writtenTokens: 0 };
  /** The same answered requests as `delta`, split by model. Failed and refused requests add nothing here. */
  const models = new Map<string, ModelTotals>();
  const flush = async () => {
    if (delta.calls + delta.failed + delta.refused === 0) return;
    // Clef's cost is priced once over the run's total read tokens, as `addUsage` prices them,
    // so the rows sum to the same micro-dollars as `jevUsage`. Per-call rounding would drift.
    const clef = models.get(CLEF_MODEL);
    if (clef) clef.costMicroUsd = costMicroUsd(clef.input);
    await ctx.runMutation(internal.functions.jev.recordUsage, { feature, workspaceId, ...delta, models: [...models.values()] });
  };

  const gate = await ctx.runQuery(internal.functions.jev.gate, { feature, workspaceId });
  if (!gate.allowed) {
    delta.refused += 1;
    try {
      return await work(null, gate.reason);
    } finally {
      await flush();
    }
  }
  const transport = options.transport !== undefined ? options.transport : await workerTransport(workspaceId);
  if (!transport) return await work(null, "unconfigured");

  let remaining = gate.remaining;
  const session: JevSession = {
    get remaining() {
      return remaining;
    },
    async decide(request) {
      if (remaining <= 0) {
        delta.refused += 1;
        return null;
      }
      remaining -= 1;
      const started = Date.now();
      const answers = await transport.send(request);
      delta.ms += Date.now() - started;
      if (answers === null) {
        delta.failed += 1;
        return null;
      }
      delta.calls += 1;
      delta.questions += Object.keys(request.questions).length;
      const tokens = estimateTokens(request.state.length + JSON.stringify(request.questions).length);
      delta.tokens += tokens;
      // Cost is set at flush, over the total; see there.
      addToModel(models, CLEF_MODEL, { calls: 1, input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, costMicroUsd: 0 });
      return answers;
    },
    async write(request) {
      if (remaining <= 0 || !transport.write) {
        delta.refused += 1;
        return null;
      }
      remaining -= 1;
      const started = Date.now();
      const written = await transport.write(request);
      delta.ms += Date.now() - started;
      if (written === null) {
        delta.failed += 1;
        return null;
      }
      delta.calls += 1;
      const spent = written.usage.input + written.usage.output;
      const cost = writingCostMicroUsd(written.usage);
      delta.tokens += spent;
      delta.writtenTokens += spent;
      delta.writtenMicroUsd += cost;
      addToModel(models, request.model === "gemma" ? GEMMA_MODEL : GLM_MODEL, {
        calls: 1,
        input: written.usage.input,
        output: written.usage.output,
        cacheRead: 0,
        cacheWrite: 0,
        costMicroUsd: cost,
      });
      return written;
    },
  };
  try {
    return await work(session, null);
  } finally {
    await flush();
  }
}

/** Run `work` over `items`, at most `limit` at a time. For fanning questions out. */
export async function eachLimited<T>(items: T[], limit: number, work: (item: T, index: number) => Promise<void>) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const at = next;
      next += 1;
      await work(items[at] as T, at);
    }
  });
  await Promise.all(lanes);
}
