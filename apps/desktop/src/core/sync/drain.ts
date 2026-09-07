/**
 * One pass of the queue.
 *
 * Separated from the outbox reducer and from the HTTP client so that the thing
 * with the loop in it has no rules in it: `nextDrain` decides what goes next,
 * `postEntry` performs it, `applyDrain` records what happened, and this
 * function is the three of them in a `while`.
 *
 * `maxRequests` bounds one pass so a full queue on a returning connection does
 * not fire two hundred requests in a burst; the next pass picks up the rest.
 */

import { nextDrain, applyDrain, recoverStaleFinalize } from "./outbox.ts";
import type { Outbox } from "./outbox.ts";
import { postEntry } from "./client.ts";
import type { GatewayConfig } from "./client.ts";

export interface DrainReport {
  outbox: Outbox;
  sent: number;
  failed: number;
  parked: number;
  /**
   * The meetings whose note reached the bucket in this pass.
   *
   * Only a `finalize` produces one, and only when the gateway answered with a
   * path. It is reported rather than folded in because there is nothing in the
   * queue to fold it into — a successful entry is removed — and because the
   * caller is the only thing that knows who is waiting to hear it: on the
   * console path, a page whose meeting must not be drawn as saved until this
   * arrives.
   */
  written: { sessionId: string; notePath: string }[];
}

export async function drainOnce(
  outbox: Outbox,
  config: GatewayConfig,
  now: () => number,
  maxRequests = 25,
): Promise<DrainReport> {
  /*
    Before anything is sent: a `finalize` that has been stuck since before this
    pass — since before this launch, on the very first pass after one — is
    retried once or turned into a queued `fail`, never left to read
    "Finalizing" forever. See `recoverStaleFinalize`'s own header for why this
    single call point covers both "a drain runs periodically" and "on app
    launch", which is the same code path here.
  */
  let current = recoverStaleFinalize(outbox, now());
  let sent = 0;
  let failed = 0;
  const written: { sessionId: string; notePath: string }[] = [];

  for (let i = 0; i < maxRequests; i += 1) {
    const entry = nextDrain(current, now());
    if (!entry) break;
    const result = await postEntry(config, entry);
    current = applyDrain(current, entry.id, result, now());
    if (result.ok) {
      sent += 1;
      if (entry.kind === "finalize" && typeof result.notePath === "string") {
        written.push({ sessionId: entry.sessionId, notePath: result.notePath });
      }
    } else failed += 1;
  }

  return {
    outbox: current,
    sent,
    failed,
    parked: current.entries.filter((entry) => entry.state === "parked").length,
    written,
  };
}
