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
import { type JevRefusal, type UsageDelta, estimateTokens } from "./meter";
import { type JevAnswers, type JevRequest, type JevTransport, workerTransport } from "./worker";

export type { JevAnswers, JevRequest } from "./worker";

export interface JevSession {
  /** Ask once. `null` means no answer: failed, refused, or the cap was reached mid-run. */
  decide(request: JevRequest): Promise<JevAnswers | null>;
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

export async function withJev<T>(
  ctx: JevCtx,
  options: WithJevOptions,
  work: (jev: JevSession | null, refusal: JevRefusal | "unconfigured" | null) => Promise<T>,
): Promise<T> {
  const { feature, workspaceId } = options;
  const delta: UsageDelta = { calls: 0, failed: 0, refused: 0, questions: 0, tokens: 0, ms: 0 };
  const flush = async () => {
    if (delta.calls + delta.failed + delta.refused === 0) return;
    await ctx.runMutation(internal.functions.jev.recordUsage, { feature, workspaceId, ...delta });
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
      delta.tokens += estimateTokens(request.state.length + JSON.stringify(request.questions).length);
      return answers;
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
