/**
 * How often an owner may ask for a probe, and how much one sweep may queue.
 *
 * Split out of `functions/storage.ts`, which keeps every registered storage
 * function; this module registers none and opens no credential.
 */

/**
 * How often one workspace may ask us to talk to its bucket again.
 *
 * The endpoint is a URL a customer typed, and re-verifying makes us issue an
 * outbound HTTPS request to it. Unlimited, that is a request amplifier pointed
 * at somebody else's infrastructure with our egress IP on it, and a way to keep
 * an action runtime busy for `REQUEST_TIMEOUT_MS` at a time.
 *
 * Keyed by **workspace**, not by user, because the workspace is what has an
 * endpoint. Keying it to the person would let two owners of a shared context
 * double the rate against one bucket, and would throttle an owner of five
 * contexts for checking each of them once.
 *
 * A handful an hour is far more than a person clicking "check again" needs, and
 * far less than a useful probe rate. `lib/rateLimit.ts` counts successful
 * mutations in a fixed window, so the true worst case is `limit * 2` across a
 * window boundary; at this size that does not matter.
 */
export const REVERIFY_LIMIT = 6;
export const REVERIFY_WINDOW_MS = 60 * 60 * 1000;

/**
 * The guard above spends itself after one success, so this is only ever the
 * ceiling on *unsuccessful* probes — a bucket that will not answer, asked
 * again by a console that mounted again. Low, because nobody is waiting on it:
 * it is a background reconcile, and the cost of a refusal is that a notice
 * somebody can already dismiss stays up a while longer.
 */
export const OBSERVE_LAYOUT_LIMIT = 4;
export const OBSERVE_LAYOUT_WINDOW_MS = 60 * 60 * 1000;

/** Bindings one sweep may re-probe. Matches the other sweeps in `crons.ts`. */
export const CAPABILITY_SWEEP_BATCH = 20;
