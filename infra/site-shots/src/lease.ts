/**
 * One driver at a time for a person's or a chat's browser (Dev2, 2026-11-16).
 *
 * The Browserbase browser is one live session per owner tag (./browserbase.ts
 * `findSession`), so two callers sending steps at once drive the same page:
 * on 2026-11-16 two passes of one background job typed into one sign-in form
 * together and the site answered that the password was wrong. A gateway
 * question (a chat turn, a job's pass) names itself with a `holder` on every
 * /browse call; the per-owner object (./idle.ts) gives the browser to one
 * holder at a time, and anyone else is answered 409 `{ busy: true }` with
 * nothing run.
 *
 * The lease lasts `RUN_LEASE_MS` while a call runs and `LEASE_MS` past its
 * last step, so a holder that crashed frees the browser by itself; one that
 * finishes lets it go at once (/browse/release). A call with no holder (a
 * gateway from before this) neither takes nor checks the lease, so either
 * side can deploy first. Without the binding (a self-hoster, a test) there is
 * no lease and every call runs, as before. When the object cannot be reached
 * the call runs too: a lost lock is the old behaviour, never a browser nobody
 * can use.
 */

import type { IdleNamespace } from "./idle";

/** How long the browser stays a holder's after its last step. */
export const LEASE_MS = 2 * 60 * 1000;
/** How long it is theirs while a call runs: longer than any one call takes. */
export const RUN_LEASE_MS = 5 * 60 * 1000;

const HOLDER = /^[A-Za-z0-9-]{8,64}$/;

/** The caller's holder id, or null for a caller that sent none (or one that is not an id). */
export function holderOf(body: unknown): string | null {
  const holder = (body as { holder?: unknown })?.holder;
  return typeof holder === "string" && HOLDER.test(holder) ? holder : null;
}

function stub(namespace: IdleNamespace, owner: string) {
  return namespace.get(namespace.idFromName(owner), { locationHint: "enam" });
}

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
    return answer.ok ? { busy: false } : { busy: true, leftMs: answer.leftMs };
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
    return typeof object.release === "function" ? await object.release(holder) : false;
  } catch {
    return false;
  }
}
