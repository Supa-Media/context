/**
 * What the shared secret is allowed to buy, and what a wrong one is allowed to
 * learn.
 *
 * This Worker has exactly one credential and one caller. There is no user
 * token, no OAuth grant and no per-workspace identity here — the caller is the
 * control plane, and `TRANSCRIBE_WORKER_SECRET` is the whole of "this is it".
 * So the only two properties worth testing are that nothing else opens the
 * door, and that a failed attempt teaches the caller nothing at all.
 *
 * Each `describe` is a sabotage target; the comment on it names the edit that
 * would defeat the check and which test catches it.
 */
import { describe, expect, it } from "vitest";
import { bearerToken, isAuthorized, timingSafeEqual } from "./auth";

const SECRET = "s3cret-value-for-tests-only";

describe("reading the Authorization header", () => {
  it("reads a well-formed Bearer token", () => {
    expect(bearerToken(`Bearer ${SECRET}`)).toBe(SECRET);
  });

  it("accepts the scheme case-insensitively, as RFC 7235 requires", () => {
    expect(bearerToken(`bearer ${SECRET}`)).toBe(SECRET);
    expect(bearerToken(`BEARER ${SECRET}`)).toBe(SECRET);
  });

  it("refuses every other shape rather than guessing at one", () => {
    // Sabotage: fall back to "the last whitespace-separated token" and a
    // `Basic` header, a bare secret, or `Bearer` with a space in the value all
    // become candidate credentials.
    for (const header of [
      null,
      undefined,
      "",
      "   ",
      SECRET,
      `Basic ${SECRET}`,
      "Bearer",
      "Bearer ",
      `Bearer ${SECRET} extra`,
      `Token ${SECRET}`,
    ]) {
      expect(bearerToken(header)).toBeNull();
    }
  });
});

/**
 * SABOTAGE: replace the body of `timingSafeEqual` with `a === b`. The three
 * behavioural tests below still pass — a correct comparison and a leaky one
 * agree on every answer, which is the whole difficulty with testing this — and
 * "compares without an early exit on length" goes RED, because it is the only
 * one that reads the implementation rather than its verdict.
 */
describe("the comparison is constant-time and length-blind", () => {
  it("accepts the exact value", async () => {
    await expect(timingSafeEqual(SECRET, SECRET)).resolves.toBe(true);
  });

  it("refuses a value that differs in one character", async () => {
    await expect(timingSafeEqual(SECRET, `${SECRET.slice(0, -1)}X`)).resolves.toBe(false);
  });

  it("refuses values of different lengths, and empty ones", async () => {
    await expect(timingSafeEqual(SECRET, SECRET.slice(0, 5))).resolves.toBe(false);
    await expect(timingSafeEqual(SECRET, `${SECRET}x`)).resolves.toBe(false);
    await expect(timingSafeEqual("", "")).resolves.toBe(false);
    await expect(timingSafeEqual(SECRET, "")).resolves.toBe(false);
  });

  it("compares without an early exit on length, and without ===", async () => {
    // A behavioural test cannot see a timing side channel: `a === b` returns
    // exactly the same booleans as the real implementation for every input
    // above. What it cannot do is produce the same *work*, so this reads the
    // source — the same trick `structure.test.ts` uses in apps/convex, and for
    // the same reason: the property is about how the answer is computed.
    //
    // Both sides are hashed to fixed-width digests first, so the loop's length
    // is a constant and a caller cannot learn the secret's length from how long
    // the refusal took before it learns anything else. That is the property
    // `apps/convex/functions/lib/gatewayAuth.ts` spells out at length; this is
    // the same defence at the edge.
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("./auth.ts", import.meta.url), "utf8"),
    );
    const body = source.slice(source.indexOf("export async function timingSafeEqual"));
    const fn = body.slice(0, body.indexOf("\n}\n") + 3);

    expect(fn, "must hash both sides before comparing, to be length-blind").toContain("digest");
    expect(fn, "must accumulate the difference branch-free").toMatch(/\|=/);
    expect(fn, "must not short-circuit on the secret's own bytes").not.toMatch(/===\s*b\b/);
    expect(fn, "must not return early from inside the loop").not.toMatch(
      /for\s*\([^)]*\)\s*\{[^}]*\breturn\b/s,
    );
  });
});

/**
 * SABOTAGE: make `isAuthorized` return `true` when `secret` is empty, i.e.
 * treat an unconfigured deployment as an open one. "refuses everything when the
 * secret is unset" goes RED.
 */
describe("authorizing a request", () => {
  it("accepts the configured secret", async () => {
    await expect(isAuthorized(`Bearer ${SECRET}`, SECRET)).resolves.toBe(true);
  });

  it("refuses a missing, malformed or wrong header alike", async () => {
    for (const header of [null, "", "Bearer", `Basic ${SECRET}`, "Bearer wrong-value"]) {
      await expect(isAuthorized(header, SECRET)).resolves.toBe(false);
    }
  });

  it("refuses everything when the secret is unset", async () => {
    // An unconfigured deployment transcribes nothing rather than transcribing
    // for anyone. `wrangler secret put` failing silently is a real deploy
    // outcome, and this is the direction that failure must run in.
    for (const secret of [undefined, "", "   "]) {
      await expect(isAuthorized(`Bearer ${SECRET}`, secret)).resolves.toBe(false);
      await expect(isAuthorized("Bearer ", secret)).resolves.toBe(false);
    }
  });
});
