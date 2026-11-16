/**
 * One driver at a time for a person's or a chat's browser (Dev2, 2026-11-16).
 *
 * The Browserbase browser is one live session per owner tag (./browserbase.ts
 * `findSession`), and Browserbase lets any number of clients connect to one
 * session with no lock of its own, so the lock is ours. On 2026-11-16 two
 * passes of one background job typed into one sign-in form together and the
 * site answered that the password was wrong. A gateway question (a chat turn,
 * a job's pass) names itself with a `holder` on every /browse call; the
 * per-owner object (./idle.ts) gives the browser to one holder at a time, and
 * anyone else is answered 409 `{ busy: true }` with nothing run.
 *
 * The lease is short and refreshed by every call: `LEASE_MS` (90 seconds)
 * past a holder's last step, so one that died or disconnected frees the
 * browser by itself soon after. While a call runs it lasts `RUN_LEASE_MS`,
 * longer than the gateway lets one browse call take (160 s), so a slow step
 * is never taken over mid-run. A holder that finishes lets it go at once
 * (/browse/release). The lease is about who drives, never the browser itself:
 * whoever takes it next finds the same running browser by the owner tag,
 * with its page and sign-ins, as every call does. Holding the browser up for
 * the person (./idle.ts `HOLD_MS`) is a separate, longer clock.
 *
 * A call with no holder (a gateway from before this) neither takes nor
 * checks the lease, so either side can deploy first. Without the binding (a
 * self-hoster, a test) there is no lease and every call runs. When the object
 * cannot be reached the call runs too: a lost lock is the old behaviour,
 * never a browser nobody can use.
 *
 * Logged by the owner tag (an HMAC that names nobody) and the holder (a
 * random id): taken, refreshed, taken over after it expired, refused, released.
 */

import { idleStub, type IdleNamespace } from "./idle";

/** How long the browser stays a holder's after its last step. */
export const LEASE_MS = 90 * 1000;
/** How long it is theirs while a call runs: longer than the gateway lets one browse call take (160 s). */
export const RUN_LEASE_MS = 3 * 60 * 1000;

const HOLDER = /^[A-Za-z0-9-]{8,64}$/;

/** The caller's holder id, or null for a caller that sent none (or one that is not an id). */
export function holderOf(body: unknown): string | null {
  const holder = (body as { holder?: unknown })?.holder;
  return typeof holder === "string" && HOLDER.test(holder) ? holder : null;
}

const stub = idleStub;

const logLease = (outcome: string, owner: string, holder: string) =>
  console.log(JSON.stringify({ event: "site_shots_lease", outcome, owner, holder }));

/** Takes or refreshes the lease. `busy` only when another live holder has it. */
export async function claimLease(
  namespace: IdleNamespace | undefined,
  owner: string,
  holder: string,
  ms: number,
): Promise<{ busy: false } | { busy: true; leftMs: number }> {
  if (!namespace) return { busy: false };
  try {
    const object = stub(namespace, owner);
    if (typeof object.claim !== "function") return { busy: false };
    const answer = await object.claim(holder, ms);
    if (!answer.ok) {
      logLease("refused", owner, holder);
      return { busy: true, leftMs: answer.leftMs };
    }
    // A refresh is every call's; only a change of hands is logged.
    if (answer.took !== "refreshed") logLease(answer.took === "free" ? "taken" : "expired_taken", owner, holder);
    return { busy: false };
  } catch (error) {
    console.log(JSON.stringify({ event: "site_shots_lease_failed", error: error instanceof Error ? error.name : "unknown" }));
    return { busy: false };
  }
}

/** Lets the lease go, when this holder has it. Never fails. */
export async function releaseLease(namespace: IdleNamespace | undefined, owner: string, holder: string): Promise<boolean> {
  if (!namespace) return false;
  try {
    const object = stub(namespace, owner);
    const released = typeof object.release === "function" ? await object.release(holder) : false;
    if (released) logLease("released", owner, holder);
    return released;
  } catch {
    return false;
  }
}
