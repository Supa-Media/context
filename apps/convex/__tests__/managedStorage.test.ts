/**
 * Managed storage — the invariants that keep "you can always leave" true.
 *
 * Managed storage is the one part of this product where **we** hold the key to
 * a customer's bucket, so the promise in `CLAUDE.md`'s first non-negotiable
 * stops being enforced by the customer holding a credential and starts being
 * enforced by these properties. Each test here is one of them, and each is the
 * test that fails if the corresponding "simplification" in
 * `docs/decisions/storage-and-credentials.md` is ever taken:
 *
 *  1. two workspaces can never resolve to one bucket — the property that makes
 *     handing a bucket over possible, and the one that prefix tenancy ends;
 *  2. a managed name is recognisable without a database lookup, which is what
 *     lets the bind path refuse one on sight;
 *  3. the managed account is refused as a customer-supplied one, by id and by
 *     endpoint, so "that account holds customer buckets and nothing else" is
 *     enforced rather than asserted;
 *  4. a deployment with no managed account configured still works, because a
 *     self-hoster has no such account and the BYO path is untouched;
 *  5. nothing in the module hands the managed token back.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import {
  MANAGED_BUCKET_PREFIX,
  MANAGED_R2_ACCOUNT_ID_ENV_VAR,
  MANAGED_R2_API_TOKEN_ENV_VAR,
  isManagedBucketName,
  managedBucketName,
  managedStorageAvailable,
  readManagedR2Config,
  refuseManagedAccountId,
  refuseManagedEndpoint,
  requireManagedR2Config,
} from "../functions/lib/managedStorage";

/** Fake, and shaped like a real Cloudflare account id: 32 lowercase hex. */
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
/** Fake. If this string ever appears in a returned value, a test below fails. */
const API_TOKEN = "managed-token-value-that-must-never-escape";

const ws = (id: string) => id as Id<"workspaces">;

function configure(accountId: string = ACCOUNT_ID, token: string = API_TOKEN): void {
  process.env[MANAGED_R2_ACCOUNT_ID_ENV_VAR] = accountId;
  process.env[MANAGED_R2_API_TOKEN_ENV_VAR] = token;
}

let savedAccount: string | undefined;
let savedToken: string | undefined;

beforeEach(() => {
  savedAccount = process.env[MANAGED_R2_ACCOUNT_ID_ENV_VAR];
  savedToken = process.env[MANAGED_R2_API_TOKEN_ENV_VAR];
  delete process.env[MANAGED_R2_ACCOUNT_ID_ENV_VAR];
  delete process.env[MANAGED_R2_API_TOKEN_ENV_VAR];
});

afterEach(() => {
  if (savedAccount === undefined) delete process.env[MANAGED_R2_ACCOUNT_ID_ENV_VAR];
  else process.env[MANAGED_R2_ACCOUNT_ID_ENV_VAR] = savedAccount;
  if (savedToken === undefined) delete process.env[MANAGED_R2_API_TOKEN_ENV_VAR];
  else process.env[MANAGED_R2_API_TOKEN_ENV_VAR] = savedToken;
});

describe("one workspace, one bucket", () => {
  it("gives two workspaces two different buckets", () => {
    const a = managedBucketName(ws("k17abc000000000000000000000000ab"));
    const b = managedBucketName(ws("k17abc000000000000000000000000ac"));
    expect(a).not.toEqual(b);
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
  });

  it("refuses rather than inventing a name when the id is unusable", () => {
    // An id format that changed under us must fail here, not produce a bucket
    // name Cloudflare rejects halfway through somebody's signup.
    expect(() => managedBucketName(ws("Not A Valid Id"))).toThrow(ConvexError);
  });

  it("marks its buckets as ours without a database lookup", () => {
    expect(isManagedBucketName(managedBucketName(ws("k17abc000000000000000000000000ab")))).toBe(true);
    expect(isManagedBucketName("my-own-brain")).toBe(false);
    expect(MANAGED_BUCKET_PREFIX).not.toEqual("");
  });
});

describe("the managed account is not a customer's", () => {
  it("refuses the managed account id, however it is cased or padded", () => {
    configure();
    expect(() => refuseManagedAccountId(ACCOUNT_ID)).toThrow(ConvexError);
    expect(() => refuseManagedAccountId(ACCOUNT_ID.toUpperCase())).toThrow(ConvexError);
    expect(() => refuseManagedAccountId(`  ${ACCOUNT_ID}  `)).toThrow(ConvexError);
  });

  it("allows any other account", () => {
    configure();
    expect(() => refuseManagedAccountId("fedcba9876543210fedcba9876543210")).not.toThrow();
  });

  it("refuses an endpoint pointing at the managed account", () => {
    configure();
    expect(() =>
      refuseManagedEndpoint(`https://${ACCOUNT_ID}.r2.cloudflarestorage.com`),
    ).toThrow(ConvexError);
    expect(() =>
      refuseManagedEndpoint(`https://${ACCOUNT_ID}.eu.r2.cloudflarestorage.com/`),
    ).toThrow(ConvexError);
  });

  it("allows a customer's own R2 endpoint", () => {
    configure();
    expect(() =>
      refuseManagedEndpoint("https://fedcba9876543210fedcba9876543210.r2.cloudflarestorage.com"),
    ).not.toThrow();
  });

  it("refuses nothing when no managed account is configured", () => {
    // A self-hoster has no managed account, and must not have their own
    // bindings refused by a guard about an account that does not exist.
    expect(() => refuseManagedAccountId(ACCOUNT_ID)).not.toThrow();
    expect(() =>
      refuseManagedEndpoint(`https://${ACCOUNT_ID}.r2.cloudflarestorage.com`),
    ).not.toThrow();
  });
});

describe("configuration", () => {
  it("reports unavailable, rather than throwing, with nothing configured", () => {
    expect(managedStorageAvailable()).toBe(false);
    expect(readManagedR2Config()).toBeNull();
    expect(() => requireManagedR2Config()).toThrow(ConvexError);
  });

  it("treats a half-configured deployment as unconfigured", () => {
    process.env[MANAGED_R2_ACCOUNT_ID_ENV_VAR] = ACCOUNT_ID;
    expect(managedStorageAvailable()).toBe(false);
    process.env[MANAGED_R2_API_TOKEN_ENV_VAR] = "";
    expect(managedStorageAvailable()).toBe(false);
  });

  it("treats a malformed account id as unconfigured rather than a 404 later", () => {
    configure("not-an-account-id");
    expect(managedStorageAvailable()).toBe(false);
  });

  it("is available once both are set", () => {
    configure();
    expect(managedStorageAvailable()).toBe(true);
    expect(requireManagedR2Config().accountId).toEqual(ACCOUNT_ID);
  });
});

describe("the managed token does not escape", () => {
  it("appears in nothing this module returns or throws", () => {
    configure();
    const surfaces: string[] = [
      managedBucketName(ws("k17abc000000000000000000000000ab")),
      JSON.stringify({ available: managedStorageAvailable() }),
      // The config carries it by design — it is what actions are handed — so
      // the assertion below deliberately excludes it and covers everything a
      // client, a log line or an error could ever see instead.
    ];
    for (const surface of surfaces) {
      expect(surface).not.toContain(API_TOKEN);
    }

    for (const call of [
      () => refuseManagedAccountId(ACCOUNT_ID),
      () => refuseManagedEndpoint(`https://${ACCOUNT_ID}.r2.cloudflarestorage.com`),
      () => managedBucketName(ws("Not A Valid Id")),
    ]) {
      try {
        call();
        throw new Error("expected a refusal");
      } catch (error) {
        expect(JSON.stringify((error as ConvexError<string>).data ?? String(error)))
          .not.toContain(API_TOKEN);
      }
    }
  });
});
