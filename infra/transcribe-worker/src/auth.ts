/**
 * The one credential this Worker has, and the one thing a wrong guess may learn.
 *
 * ============================================================================
 * WHY THIS IS THE WHOLE OF THE AUTHORIZATION STORY
 * ============================================================================
 *
 * `context-transcribe` has exactly one caller — the control plane — and no
 * concept of a user, a workspace, or a grant. It is a pure function with a
 * shared secret in front of it: audio in, text out, nothing kept. That is
 * deliberate and it is what keeps this Worker outside the tenancy model
 * entirely. It cannot read a bucket, cannot name a context, and holds no
 * credential that opens one, so a compromise of `TRANSCRIBE_WORKER_SECRET` buys
 * inference on somebody else's account and nothing else.
 *
 * Which means the bar here is not "prove who you are", it is "prove you are the
 * one caller" — and the only two properties that matter are that nothing else
 * opens the door, and that a failed attempt teaches the caller nothing.
 *
 * ============================================================================
 * CONSTANT-TIME, AND LENGTH-BLIND
 * ============================================================================
 *
 * Both sides are hashed to fixed-width digests before they are compared, and
 * the digests are compared with a branch-free XOR accumulation. Hashing is not
 * for storage — the secret is a shared value both parties hold in the clear —
 * it is what removes the length side channel: comparing the raw strings would
 * let a caller learn the secret's length from a timing difference before it
 * learned anything about its bytes.
 *
 * This is the same construction, for the same reason, as
 * `apps/convex/functions/lib/gatewayAuth.ts` on the control-plane side. Two
 * halves of one handshake that disagreed about how to compare a secret would be
 * a strange thing to explain later.
 *
 * ============================================================================
 * THE REFUSAL SAYS NOTHING
 * ============================================================================
 *
 * `isAuthorized` returns a boolean. Not a reason, not a distinction between "no
 * header", "wrong scheme" and "wrong secret" — the caller gets a bare 401 with
 * no body, and the Worker's own log records that a request was refused without
 * recording what it carried. An error string is the easiest place in a system
 * for a secret to escape, so there is no error string.
 */

/** SHA-256 of a UTF-8 string. Fixed width, which is the entire point. */
async function digest(value: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(value);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

/**
 * Compare two secrets without leaking their length or their bytes through
 * timing.
 *
 * Empty strings are refused outright rather than compared: an empty secret is
 * an unconfigured deployment, and "unconfigured" must never mean "open".
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const [left, right] = await Promise.all([digest(a), digest(b)]);
  // Both are SHA-256 digests, so the lengths are equal by construction. Folding
  // the length into the accumulator rather than branching on it keeps that a
  // fact about the code instead of an assumption about the caller.
  let difference = left.length ^ right.length;
  const width = Math.min(left.length, right.length);
  for (let index = 0; index < width; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

/**
 * The token out of an `Authorization: Bearer <token>` header, or `null`.
 *
 * One shape, exactly. No fallback to "the last whitespace-separated word", no
 * accepting a bare token, no `Basic`: every widening here is a second way in,
 * and this Worker needs one.
 *
 * The scheme is matched case-insensitively because RFC 7235 §2.1 says it is
 * case-insensitive, and a client that sends `bearer` is not an attacker.
 */
export function bearerToken(header: string | null | undefined): string | null {
  if (typeof header !== "string") return null;
  const match = /^Bearer[ ]+([^ ]+)$/i.exec(header.trim());
  return match ? match[1]! : null;
}

/**
 * Is this request carrying the secret this deployment was configured with?
 *
 * A boolean and nothing else. An unset (or whitespace-only) secret authorizes
 * nobody — `wrangler secret put` failing quietly is a real deploy outcome, and
 * a Worker that transcribed for anyone in that state would be worse than one
 * that transcribed for no one.
 *
 * The configured value is trimmed, and only the configured value. A GitHub
 * secret set from a file keeps its trailing newline, which is a mistake the
 * email worker's deploy pipeline has a whole paragraph about — and unlike that
 * one, this side can simply absorb it, because a newline cannot appear in an
 * `Authorization` header at all and so cannot be what a caller sent.
 */
export async function isAuthorized(
  header: string | null | undefined,
  secret: string | undefined,
): Promise<boolean> {
  const expected = typeof secret === "string" ? secret.trim() : "";
  if (!expected) return false;
  const provided = bearerToken(header);
  if (provided === null) return false;
  return timingSafeEqual(provided, expected);
}
