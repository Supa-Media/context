/**
 * PKCE (RFC 7636) for the OAuth connect flows: a verifier we keep and the
 * challenge that travels through the browser. Pure functions; no provider
 * specifics live here.
 */

/**
 * Bytes of entropy behind a verifier.
 *
 * 32 bytes base64url-encode to exactly 43 characters, which is RFC 7636 §4.1's
 * minimum. The RFC's floor and a 256-bit secret coincide here, so there is
 * nothing to trade off: this is the shortest legal verifier and it is already
 * as strong as the digest that stands in for it.
 */
const VERIFIER_BYTES = 32;

/** RFC 7636 §4.1: 43–128 characters from the unreserved set. */
const MIN_VERIFIER_LENGTH = 43;
const MAX_VERIFIER_LENGTH = 128;

/** A PKCE pair. The verifier is a secret; the challenge is not. */
export interface PkcePair {
  /** Kept server-side, spent once at the exchange. Never sent to a browser. */
  verifier: string;
  /** `base64url(SHA-256(verifier))`. Safe to put in a URL — that is the point. */
  challenge: string;
}

/** Bytes → base64url, unpadded. */
function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  // `btoa` is the one base64 primitive present in all three runtimes this code
  // has to work in: the Convex action runtime, the Workers gateway, and
  // `@edge-runtime/vm` under vitest. `Buffer` is in none of them reliably.
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The `code_challenge` for a given verifier.
 *
 * Exported because it is the only way to check this transformation against
 * something other than itself: `createPkcePair` alone can only be tested for
 * self-consistency, and a self-consistent wrong hash is exactly the bug this
 * closes. The test feeds it RFC 7636 §4.6's published verifier and asserts the
 * RFC's published challenge.
 *
 * The length bounds are checked here rather than only at generation, because
 * this is also the function a caller would reach for if it ever wanted to
 * re-derive a challenge for a verifier that came from somewhere else.
 */
export async function pkceChallengeFor(verifier: string): Promise<string> {
  if (
    typeof verifier !== "string" ||
    verifier.length < MIN_VERIFIER_LENGTH ||
    verifier.length > MAX_VERIFIER_LENGTH
  ) {
    // Says nothing about the value, which is a secret, and everything about the
    // rule it broke.
    throw new Error(
      `A PKCE code verifier must be ${MIN_VERIFIER_LENGTH}–${MAX_VERIFIER_LENGTH} characters (RFC 7636 §4.1)`,
    );
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    // ASCII, per RFC 7636 §4.2. The verifiers this module generates are
    // base64url so the encoding is moot for them, but it is not moot for a
    // verifier that came from anywhere else.
    new TextEncoder().encode(verifier) as BufferSource,
  );
  return base64Url(new Uint8Array(digest));
}

/**
 * A fresh PKCE pair.
 *
 * `crypto.getRandomValues` rather than `Math.random`, for the same reason
 * `randomOpaqueToken` in `gatewayAuth.ts` uses it: `Math.random` is seeded per
 * transaction in the Convex runtime and is not a CSPRNG. A guessable verifier
 * is a PKCE flow with no PKCE in it.
 */
export async function createPkcePair(): Promise<PkcePair> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(VERIFIER_BYTES)));
  return { verifier, challenge: await pkceChallengeFor(verifier) };
}
