/**
 * What a push notification does to a connection: mark one product pending and
 * make the connection due soon. Nothing else — the pass that follows is the
 * ordinary scheduled pass, claimed by the ordinary sweep, behind every gate it
 * already has.
 */

import { internal } from "../../../_generated/api";
import type { Doc } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";

export type PushProduct = "gmail" | "calendar" | "chat";

/**
 * The shortest gap between the end of one pass and a push-started next one.
 * A burst of mail is a burst of notifications; this folds it into one pass a
 * little later rather than a pass per message.
 */
export const PUSH_MIN_GAP_MS = 30_000;

type Pending = NonNullable<NonNullable<Doc<"googleConnections">["push"]>["pending"]>;

export function pendingProducts(row: Pick<Doc<"googleConnections">, "push">): PushProduct[] {
  const pending = row.push?.pending ?? {};
  return (["gmail", "calendar", "chat"] as const).filter((product) => pending[product] !== undefined);
}

/**
 * Mark `product` pending on `row` and bring its next pass forward.
 *
 * A connection that is failing keeps its backoff: a notification is not a
 * reason to hammer a grant Google is refusing, and the pending mark is still
 * served when the backoff ends. A pass already running is not overtaken
 * either; `settlePending` sees the mark when that pass reports.
 */
export async function markPushPending(
  ctx: MutationCtx,
  row: Doc<"googleConnections">,
  product: PushProduct,
  now: number,
): Promise<void> {
  if (row.disconnectedAt !== undefined || !row.products.includes(product)) return;
  if (row.health === "reconnect_required") return;
  const pending: Pending = { ...(row.push?.pending ?? {}) };
  const alreadyPending = pending[product] !== undefined;
  pending[product] = now;
  const failing = (row.syncFailures ?? 0) > 0;
  const earliest = Math.max(now, (row.lastSyncAt ?? 0) + PUSH_MIN_GAP_MS);
  const nextSyncAt =
    failing || (row.nextSyncAt !== undefined && row.nextSyncAt <= earliest) ? row.nextSyncAt : earliest;
  await ctx.db.patch(row._id, {
    push: { ...(row.push ?? {}), pending, lastPushAt: now },
    nextSyncAt,
  });
  // One sweep per burst: later notifications before the pass only move the
  // timestamp. A failing row waits for the five-minute cron like any other.
  if (!alreadyPending && !failing) {
    const delayMs = Math.max(0, (nextSyncAt ?? now) - now);
    await ctx.scheduler.runAfter(delayMs, internal.functions.googleSync.sweepDueGoogleSyncs, {});
  }
}

/**
 * After a pass of `product` that was claimed at `claimedAt`: clear the mark
 * if nothing arrived since the claim (a pass with no claim on record covers
 * whatever was marked, rather than leaving a mark nothing can clear). Answers the pending marks that remain,
 * which the caller turns into a near next pass.
 */
export function settlePending(
  row: Pick<Doc<"googleConnections">, "push">,
  product: PushProduct,
  claimedAt: number | undefined,
): Pending | undefined {
  const pending: Pending = { ...(row.push?.pending ?? {}) };
  const markedAt = pending[product];
  if (markedAt !== undefined && (claimedAt === undefined || markedAt <= claimedAt)) {
    delete pending[product];
  }
  return Object.keys(pending).length === 0 ? undefined : pending;
}

/**
 * The push half of a successful pass's report: clear what it covered, and if
 * a notification arrived while it ran, make the connection due again after the
 * gap and queue the sweep that will claim it. Answers the row's new `push` and
 * the earliest the next pass is due because of it (`Infinity` when nothing is
 * left pending).
 */
export async function settlePushAfterPass(
  ctx: MutationCtx,
  row: Doc<"googleConnections">,
  product: PushProduct,
  now: number,
  catchUp: boolean,
): Promise<{ push: Doc<"googleConnections">["push"]; dueAt: number }> {
  if (row.push === undefined) return { push: undefined, dueAt: Infinity };
  const pending = settlePending(row, product, row.syncStartedAt);
  if (pending !== undefined && !catchUp) {
    await ctx.scheduler.runAfter(PUSH_MIN_GAP_MS, internal.functions.googleSync.sweepDueGoogleSyncs, {});
  }
  return { push: { ...row.push, pending }, dueAt: pending === undefined ? Infinity : now + PUSH_MIN_GAP_MS };
}
