/**
 * Who is spending our inference, and how much of it they may spend.
 *
 * ============================================================================
 * WHAT THIS FIXES, AND WHY IT IS HERE RATHER THAN IN THE CONTROL PLANE
 * ============================================================================
 *
 * Until this file existed, `functions/meetings/transcribe.ts` said in its own
 * header that a signed-in account was the only thing between a caller and this
 * account's Workers AI budget — and that was true. Sign-up is open email OTP
 * with no invite gate and `api.auth.signIn` is public, so "signed in" is a
 * barrier of approximately zero; each request may carry 8 MiB of audio; and
 * the body posted here carried no caller identifier at all, so a surprising
 * bill had no account behind it to find.
 *
 * The control plane could not fix it on its own. `lib/rateLimit.ts` there needs
 * a `MutationCtx` and writes a `rateLimits` row, and that action deliberately
 * has no `ctx.db`, `ctx.storage`, `ctx.scheduler` or `ctx.runMutation` — the
 * row next to `rateLimits` is the one that would hold a transcript, and a test
 * sweeping every table in the schema exists to keep it that way. So the limit
 * lives here, where it costs no database at all, and the control plane's only
 * new job is to say *who* is asking.
 *
 * The Workers native rate limiting binding is what makes that cheap:
 * `wrangler.jsonc` declares it and there is nothing to provision — no KV
 * namespace, no D1 database, no Durable Object, no account resource of any
 * kind. That matters beyond convenience. This Worker's whole auditability
 * claim (see the header of `src/index.ts`) is that there is nowhere here for
 * audio to be kept even by accident, and a rate-limit KV would have been the
 * first storage binding to undermine it.
 *
 * ============================================================================
 * THE KEY IS OPAQUE, AND THAT IS THE POINT TWICE OVER
 * ============================================================================
 *
 * The control plane sends `HMAC-SHA256(TRANSCRIBE_WORKER_SECRET, "…" + userId)`
 * as hex, never the user id. So:
 *
 *   - this Worker still holds no account identifier, no session, no workspace
 *     and no position in a recording — it learns that two chunks came from the
 *     same caller and nothing else about who that is;
 *   - anyone who intercepts the header learns nothing they could look up;
 *   - and the control plane, which holds both the secret and the users table,
 *     can recompute the value for any account and so **name** the one behind a
 *     bill. `functions/meetings/transcribe.ts` documents that recomputation
 *     step, because an attribution nobody knows how to invert is not one.
 *
 * ============================================================================
 * FAIL CLOSED
 * ============================================================================
 *
 * `checkRateLimit` answers `unavailable` — never `allowed` — when the binding
 * is absent, throws, rejects, or answers something it cannot read. All three
 * of those are real states: `wrangler deploy` succeeds with the binding
 * removed from `wrangler.jsonc` exactly as it does with Workers AI
 * unprovisioned, which is the failure shape `deploy-email-worker.yml`'s header
 * records hours lost to. A limiter that returned "allowed" when broken would
 * restore unlimited inference silently, on a green deploy, with nothing in any
 * log to say when it started.
 *
 * `unavailable` is kept distinct from `refused` for the log alone: the caller
 * gets the same 429 either way, and an operator gets to tell "somebody is
 * hammering us" apart from "the limiter is down and nobody can transcribe".
 */

/**
 * The header the caller identifier travels in.
 *
 * A header rather than a body field for a reason that is structural, not
 * stylistic: the limit has to be enforced **before the body is read**, so that
 * an over-limit caller cannot make this Worker buffer 8 MiB first. A key that
 * lived in the body could only be read after the thing it was meant to bound.
 *
 * And not a query parameter, for the reason CLAUDE.md gives about URLs: they
 * end up in every log and proxy between here and there.
 */
export const CALLER_HEADER = "x-caller-hash";

/**
 * Exactly the shape the control plane mints: a hex SHA-256 HMAC, lowercase.
 *
 * Anchored and fixed-width on purpose. This header is attacker-controlled the
 * moment `TRANSCRIBE_WORKER_SECRET` is, and two things follow from that: an
 * unbounded header is an unbounded string handed to the rate limiter, and a
 * caller free to send *any* key can mint a fresh bucket per request, which is
 * no limit at all. Neither is prevented by a limit whose key is not bounded.
 */
const CALLER_PATTERN = /^[0-9a-f]{64}$/;

/**
 * How many requests one caller may make in `RATE_LIMIT_PERIOD_SECONDS`.
 *
 * Justified against the real workload rather than picked round.
 * `apps/mobile/features/meetings/capture/segments.ts` rotates a chunk every 20
 * seconds, so ONE live recording is **3 requests a minute**, and a person
 * plausibly recording on two devices at once is **6**. Nothing amplifies that:
 * this path has no retry by design, because retrying would mean keeping the
 * audio.
 *
 * 20 is over three times the two-device rate — a real user would need seven
 * simultaneous recordings to reach it — while an abuser scripting the endpoint
 * reaches it in seconds and is capped from then on at 20 chunks a minute
 * instead of as many as they can upload.
 *
 * Two honest caveats, neither of which changes the choice:
 *
 *  - Cloudflare's limiter is **per-location and eventually consistent**, so a
 *    caller spread across colos gets a multiple of this. It is a ceiling on
 *    the blast radius, not an accounting system, and the documentation says so
 *    outright.
 *  - It is per **identifier**, so somebody willing to open many accounts still
 *    gets many buckets. That is a signup-gate problem — an open email OTP with
 *    no invite — and it is not this Worker's to solve.
 */
export const RATE_LIMIT_REQUESTS = 20;

/** The window. Cloudflare's binding permits 10 or 60 seconds, and nothing else. */
export const RATE_LIMIT_PERIOD_SECONDS = 60;

/**
 * The binding, declared structurally rather than as `RateLimit` from
 * `@cloudflare/workers-types`, so the handler can be driven from a plain object
 * in tests with no runtime and no account — the same reason `Env.AI` is
 * declared this way.
 */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** Allowed, over the limit, or the limiter could not answer. */
export type RateLimitVerdict = "allowed" | "refused" | "unavailable";

/**
 * The caller identifier out of a header value, or `null`.
 *
 * Trimmed before matching only because `Headers.get` already strips the
 * optional whitespace HTTP permits and belt-and-braces here costs nothing. It
 * widens nothing: what survives must still be exactly 64 lowercase hex
 * characters.
 */
export function readCaller(header: string | null | undefined): string | null {
  if (typeof header !== "string") return null;
  const value = header.trim();
  return CALLER_PATTERN.test(value) ? value : null;
}

/**
 * May this caller buy another transcription?
 *
 * Never throws: every failure of the limiter is `unavailable`, which the
 * handler treats exactly as it treats `refused`.
 */
export async function checkRateLimit(
  limiter: RateLimiter | undefined,
  caller: string,
): Promise<RateLimitVerdict> {
  if (!limiter || typeof limiter.limit !== "function") return "unavailable";
  let outcome: unknown;
  try {
    outcome = await limiter.limit({ key: caller });
  } catch {
    // No detail is kept. The limiter's own error is an upstream's message, and
    // this Worker forwards none of those — see the header of `src/index.ts`.
    return "unavailable";
  }
  if (typeof outcome !== "object" || outcome === null) return "unavailable";
  const { success } = outcome as { success?: unknown };
  // A shape change in the binding is a limiter that cannot answer, not a yes.
  if (typeof success !== "boolean") return "unavailable";
  return success ? "allowed" : "refused";
}
