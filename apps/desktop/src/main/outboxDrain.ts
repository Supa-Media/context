/**
 * The queue's drain: one pass at a time, reconciled against the queue as it is
 * *now*, and every refusal written to the log with the gateway's reason.
 *
 * Moved from `main()` verbatim. The timer, the controller's session write and
 * the console's finalize all call `drain()`; this is the one chain they share.
 */

import { reconcileDrain } from "../core/sync/outbox.ts";
import { drainOnce } from "../core/sync/drain.ts";
import type { MainActions, MainContext } from "./context.ts";

export function createOutboxDrain(ctx: MainContext): Pick<MainActions, "drain"> {
  const { connection, store, notePaths } = ctx;
  // Late-bound: these live in other modules and are read from `ctx` at call time.
  const push: MainActions["push"] = () => ctx.push();

  /**
   * The drain in flight, so there is never more than one.
   *
   * Two overlapping drains post the same head entry twice and then race to
   * assign the queue, and there are two callers now: the fifteen-second timer
   * and every finalize the console hands over. Chained rather than skipped —
   * a finalize that joined a drain which started *before* its entry was queued
   * would be told "queued" about a request nobody made, which is the one answer
   * this path may not give.
   */
  let draining: Promise<void> = Promise.resolve();

  function drain(): Promise<void> {
    draining = draining.then(drainNow, drainNow);
    return draining;
  }

  async function drainNow(): Promise<void> {
    /*
      The base URL is the connection's, not the settings file's.

      Both existed, and settings never had one: `gatewayBaseUrl` defaulted to
      null with nothing on the machine able to set it, so this returned on its
      first line and the queue never drained at all. It is one value now, minted
      by the OAuth flow beside the credential it belongs to — which also means a
      token cannot be posted to a gateway other than the one it was minted for,
      because the two are read from the same record.
    */
    const baseUrl = connection.baseUrl();
    if (baseUrl === null) return;
    /*
      The queue does not stand still for the round trip.

      A segment is spoken, somebody types, the console hands over a write — all
      of them synchronous, all of them landing on `outbox` while this awaits.
      Assigning `report.outbox` over the top drops every one of them, and the
      dropped write has already been answered as accepted. So the outcome is
      re-applied to the queue as it is *now*. See `reconcileDrain`.
    */
    const before = ctx.outbox;
    const report = await drainOnce(
      before,
      {
        baseUrl,
        token: () => connection.token(),
        // Not the scope this app asked for: the one the grant came back with.
        // `postEntry` holds a meeting rather than let the gateway file it at a
        // visibility the person did not choose. See `grantCoversMeetings`.
        scope: () => connection.scope(),
      },
      () => Date.now(),
    );
    ctx.outbox = reconcileDrain(before, report.outbox, ctx.outbox);
    /*
      WHAT THE GATEWAY REFUSED, IN THE LOG, WITH THE REASON IT GAVE.

      Nothing logged this. A refused write recorded `lastError` on its own queue
      entry and stopped there, so the only way to find out why a meeting had not
      landed was to open the queue file on somebody's disk — which is how an
      evening of meetings was actually diagnosed. The status alone was useless
      as well: `postEntry` read the gateway's `message` field and this gateway
      sends `error_description`, so every refusal in this app's history read
      "gateway answered 400" and nothing more.

      Session id, kind, status, contract code and the gateway's own sentence.
      **No content**: not a segment, not a note, not a title, and never the
      credential — `docs/decisions/` calls that out and `client.ts` composes
      these strings so a `fetch` failure's URL can never reach one.
    */
    for (const refusal of report.refusals) {
      console.warn(
        `meeting_write_refused session=${refusal.sessionId} kind=${refusal.kind} ` +
          `status=${refusal.status ?? "none"} code=${refusal.code} ` +
          `${refusal.parked ? "parked" : "retrying"}: ${refusal.message}`,
      );
    }
    for (const landed of report.written) notePaths.set(landed.sessionId, landed.notePath);
    await store.writeOutbox(ctx.outbox);
    push();
  }

  return { drain };
}
