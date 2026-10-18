/**
 * PKCE (RFC 7636) for the connect flows, as pure functions.
 *
 * The one property here that cannot be checked by reading the code: the
 * challenge must be the exact transformation the RFC defines. A challenge that
 * is plain base64, or hex, or the SHA-1 of the verifier, produces a
 * working-looking authorize URL and fails at the token exchange with an
 * `invalid_grant` — indistinguishable from a code that expired. So it is pinned
 * to the published vector in RFC 7636 §4.6 rather than to itself.
 *
 * Every value here is obviously fake except the RFC's own published vector.
 * This repository is public.
 */

import { describe, expect, test } from "vitest";
import { createPkcePair, pkceChallengeFor } from "../functions/lib/pkce";

/** RFC 7636 §4.6, verbatim. The one thing here that is not ours to choose. */
const RFC7636_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC7636_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

describe("PKCE", () => {
  /**
   * SHA-256 of the ASCII verifier, base64url, no padding. Get any link in that
   * chain wrong — hash the wrong bytes, keep the `=`, keep `+` and `/` — and
   * the pair is still internally consistent, still produces a URL the provider
   * accepts, and fails only at the exchange.
   */
  test("challenge matches the RFC 7636 §4.6 vector", async () => {
    expect(await pkceChallengeFor(RFC7636_VERIFIER)).toBe(RFC7636_CHALLENGE);
  });

  test("a generated pair is self-consistent", async () => {
    const pair = await createPkcePair();
    expect(await pkceChallengeFor(pair.verifier)).toBe(pair.challenge);
  });

  test("the verifier is RFC-legal and unreserved", async () => {
    const { verifier } = await createPkcePair();
    // RFC 7636 §4.1: 43–128 characters from the unreserved set.
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  test("verifiers differ across calls", async () => {
    const pairs = await Promise.all(Array.from({ length: 16 }, () => createPkcePair()));
    const verifiers = new Set(pairs.map((pair) => pair.verifier));
    expect(verifiers.size).toBe(pairs.length);
    // And the challenge is not a constant either, which a hardcoded return
    // would satisfy the test above with.
    expect(new Set(pairs.map((pair) => pair.challenge)).size).toBe(pairs.length);
  });

  test("a challenge is base64url with no padding", async () => {
    const { challenge } = await createPkcePair();
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("a verifier outside the RFC's length bounds is refused", async () => {
    await expect(pkceChallengeFor("too-short")).rejects.toThrow();
    await expect(pkceChallengeFor("a".repeat(129))).rejects.toThrow();
  });
});
