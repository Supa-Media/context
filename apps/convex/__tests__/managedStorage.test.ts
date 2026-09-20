/**
 * Managed storage — the invariants that keep "you can always leave" true.
 *
 * Managed storage is the one part of this product where **we** hold the key to
 * a customer's bucket, so `CLAUDE.md`'s first non-negotiable stops being
 * enforced by the customer holding a credential and starts being enforced by
 * these properties:
 *
 *  1. two workspaces can never resolve to one bucket — what makes handing a
 *     bucket over possible, and what prefix tenancy would end;
 *  2. a malformed managed account id fails loudly instead of silently
 *     disabling the guards on the deployment that has an account to protect;
 *  3. the managed account is refused as a customer-supplied one, by id and by
 *     the endpoint as the URL parser sees it — not as it was typed;
 *  4. a deployment with no managed account refuses nothing, because a
 *     self-hoster has none and their own bindings must still work.
 *
 * The guards' **wiring** is proved in `storage.test.ts` and `cloudflare.test.ts`
 * against the real actions. Unit tests here would otherwise pass with both
 * call sites deleted, which is the failure `docs/decisions/testing.md` names.
 */

import { describe, expect, it } from "vitest";
import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import {
  MANAGED_BUCKET_PREFIX,
  MANAGED_R2_ACCOUNT_ID_ENV_VAR,
  managedAccountId,
  managedBucketName,
  refuseManagedAccountId,
  refuseManagedEndpoint,
} from "../functions/lib/managedStorage";

/** Fake, and shaped like a real Cloudflare account id: 32 lowercase hex. */
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const OTHER_ACCOUNT = "fedcba9876543210fedcba9876543210";

const ws = (id: string) => id as Id<"workspaces">;
const env = (value?: string) =>
  value === undefined ? {} : { [MANAGED_R2_ACCOUNT_ID_ENV_VAR]: value };

describe("one workspace, one bucket", () => {
  it("gives two workspaces two different buckets", () => {
    expect(managedBucketName(ws("k17abc000000000000000000000000ab"))).not.toEqual(
      managedBucketName(ws("k17abc000000000000000000000000ac")),
    );
  });

  it("never folds two ids onto one bucket", () => {
    // The bug this replaced: `.toLowerCase()` mapped `…aB` and `…ab` — two
    // distinct workspaces — onto one bucket, which provisioning would then
    // adopt, putting two customers in one bucket and ending the hand-over
    // promise. Case must refuse, never merge.
    expect(() => managedBucketName(ws("k17abc000000000000000000000000aB"))).toThrow(
      ConvexError,
    );
    expect(() => managedBucketName(ws("K17abc000000000000000000000000ab"))).toThrow(
      ConvexError,
    );
  });

  it("is deterministic, so a retry finds the bucket it already made", () => {
    const id = ws("k17abc000000000000000000000000ab");
    expect(managedBucketName(id)).toEqual(managedBucketName(id));
  });

  it("produces a name R2 will accept", () => {
    const name = managedBucketName(ws("k17abc000000000000000000000000ab"));
    expect(name.length).toBeGreaterThanOrEqual(3);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    expect(name.startsWith(MANAGED_BUCKET_PREFIX)).toBe(true);
  });

  it("refuses rather than truncating or inventing a name", () => {
    // Never `.slice(0, 63)`: a truncated name is a name two workspaces can
    // share, which is the same tenant merge by a slower route.
    expect(() => managedBucketName(ws("a".repeat(80)))).toThrow(ConvexError);
    expect(() => managedBucketName(ws(""))).toThrow(ConvexError);
    expect(() => managedBucketName(ws("Not A Valid Id"))).toThrow(ConvexError);
  });
});

describe("reading the managed account id", () => {
  it("is null when unset or empty, because a self-hoster has none", () => {
    expect(managedAccountId(env())).toBeNull();
    expect(managedAccountId(env(""))).toBeNull();
    expect(managedAccountId(env("   "))).toBeNull();
  });

  it("survives the whitespace and case a real secret store adds", () => {
    // The fail-open this replaced: an untrimmed `\n` made a configured
    // deployment read as unconfigured, silently disabling both guards.
    expect(managedAccountId(env(`${ACCOUNT_ID}\n`))).toEqual(ACCOUNT_ID);
    expect(managedAccountId(env(`  ${ACCOUNT_ID}  `))).toEqual(ACCOUNT_ID);
    expect(managedAccountId(env(ACCOUNT_ID.toUpperCase()))).toEqual(ACCOUNT_ID);
  });

  it("throws on a value that is set but is not an account id", () => {
    // Loud, not silent: conflating "misconfigured" with "absent" turns the
    // guards off on exactly the deployment that has an account to protect.
    expect(() => managedAccountId(env("not-an-account-id"))).toThrow(ConvexError);
    expect(() => managedAccountId(env(`${ACCOUNT_ID}0`))).toThrow(ConvexError);
  });

  it("does not echo the value it rejected", () => {
    try {
      managedAccountId(env("nope-nope-nope"));
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(ConvexError);
      expect(JSON.stringify((error as ConvexError<string>).data)).not.toContain(
        "nope-nope-nope",
      );
    }
  });
});

describe("the managed account is not a customer's", () => {
  it("refuses the managed account id, however cased or padded", () => {
    for (const candidate of [ACCOUNT_ID, ACCOUNT_ID.toUpperCase(), `  ${ACCOUNT_ID} `]) {
      expect(() => refuseManagedAccountId(candidate, ACCOUNT_ID)).toThrow(ConvexError);
    }
  });

  it("allows any other account", () => {
    expect(() => refuseManagedAccountId(OTHER_ACCOUNT, ACCOUNT_ID)).not.toThrow();
  });

  it("refuses every address Cloudflare issues for our account", () => {
    for (const endpoint of [
      `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
      `https://${ACCOUNT_ID}.eu.r2.cloudflarestorage.com/`,
      `https://a-bucket.${ACCOUNT_ID}.r2.cloudflarestorage.com`,
      `https://${ACCOUNT_ID.toUpperCase()}.r2.cloudflarestorage.com`,
    ]) {
      expect(() => refuseManagedEndpoint(endpoint, ACCOUNT_ID)).toThrow(ConvexError);
    }
  });

  it("refuses the forms that spell the host differently from how it resolves", () => {
    // Both of these were accepted by the substring check this replaced, and
    // both resolve to the managed account once `new URL()` normalises them:
    // percent-decoding and IDNA mapping happen in the parser, so a guard that
    // reads the string as typed disagrees with every consumer of that string.
    const percentEncoded = `https://0123456789%61bcdef0123456789abcdef.r2.cloudflarestorage.com`;
    const fullwidthZero = `https://０123456789abcdef0123456789abcdef.r2.cloudflarestorage.com`;
    expect(() => refuseManagedEndpoint(percentEncoded, ACCOUNT_ID)).toThrow(ConvexError);
    expect(() => refuseManagedEndpoint(fullwidthZero, ACCOUNT_ID)).toThrow(ConvexError);
  });

  it("allows a customer's own R2 endpoint", () => {
    expect(() =>
      refuseManagedEndpoint(`https://${OTHER_ACCOUNT}.r2.cloudflarestorage.com`, ACCOUNT_ID),
    ).not.toThrow();
  });

  it("does not refuse an account id that merely appears in a path or query", () => {
    // A refusal about *which host a request reaches* must not fire on a string
    // that is not the host — it would be the wrong refusal wearing the right
    // message, and it can lock somebody out of their own storage.
    expect(() =>
      refuseManagedEndpoint(`https://s3.customer.example/${ACCOUNT_ID}/notes`, ACCOUNT_ID),
    ).not.toThrow();
    expect(() =>
      refuseManagedEndpoint(`https://s3.customer.example/?x=${ACCOUNT_ID}`, ACCOUNT_ID),
    ).not.toThrow();
  });

  it("leaves an unparseable endpoint to the URL check that reports it properly", () => {
    // Otherwise a non-URL containing the id answers "wrong account" when the
    // truthful answer is "that is not a URL" — and hands any signed-in caller
    // a cleaner oracle than they would otherwise have.
    expect(() =>
      refuseManagedEndpoint(`this is not a url ${ACCOUNT_ID}`, ACCOUNT_ID),
    ).not.toThrow();
  });

  it("refuses nothing when no managed account is configured", () => {
    expect(() => refuseManagedAccountId(ACCOUNT_ID, null)).not.toThrow();
    expect(() =>
      refuseManagedEndpoint(`https://${ACCOUNT_ID}.r2.cloudflarestorage.com`, null),
    ).not.toThrow();
  });
});
