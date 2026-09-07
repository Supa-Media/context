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
import type { Outbox, OutboxKind } from "./outbox.ts";
import { postEntry } from "./client.ts";
import type { GatewayConfig } from "./client.ts";

/**
 * How often the queue drains on its own.
 *
 * Lives here rather than in `main/index.ts`, where it was, because it is half of
 * an invariant whose other half is `SEGMENT_MS` — and the suite cannot load a
 * file that imports Electron, so a constant kept there is a constant no check
 * can see. `sessionOrder.test.mjs` compares the two.
 */
export const DRAIN_INTERVAL_MS = 30_000;

/** When a queued write has to reach the gateway. See `drainUrgency`. */
export type DrainUrgency = "await" | "now" | "timer";

/**
 * HOW SOON THIS WRITE HAS TO LEAVE, WHICH IS NOT THE SAME QUESTION FOR ALL FOUR.
 *
 * The timer is the default and it is the right default: a meeting is meant to
 * be sent in one pass, and draining on every `segments` write would be a
 * request per twenty seconds of audio against somebody's own gateway. Two kinds
 * are exceptions, for two different reasons.
 *
 * **`session` cannot wait, and the arithmetic is the whole of the argument.**
 * Chunks of audio rotate every `SEGMENT_MS` (20 s) and this timer fires every
 * `DRAIN_INTERVAL_MS` (30 s). A session write that waits for the timer is
 * therefore *always* later than the first chunk it exists to make legal, and
 * `POST /meetings/sessions/:id/transcribe` answers a session it has never heard
 * of with a 404 — which the recorder read as permanent and used to give up the
 * entire meeting on. **Every desktop recording was transcription-dead from its
 * first chunk**, deterministically, because 20 < 30. `now` is a fire-and-forget
 * drain: it starts the request immediately, it does not block the press of
 * Record or the microphone opening, and the chained `drain()` means at most one
 * pass is ever in flight.
 *
 * **`finalize` is awaited** because its answer is the one fact the caller does
 * not already have — where the note landed — and until it has that, the page
 * may not draw the meeting as saved. See `main/index.ts`'s
 * `writeMeetingFromConsole`.
 *
 * The `session` rule is belt to `permanent()`'s braces in `main/transcribe.ts`,
 * not a substitute for it: this makes the session row *early*, and that makes a
 * late one survivable. Either alone still loses meetings.
 */
export function drainUrgency(kind: OutboxKind): DrainUrgency {
  if (kind === "finalize") return "await";
  if (kind === "session") return "now";
  return "timer";
}

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
