/**
 * Creating a bucket in somebody else's Cloudflare account, end to end.
 *
 * The real actions run against a `fetch` stub speaking Cloudflare's API and,
 * behind it, the same in-memory S3 backend the connect tests use — so the
 * binding this flow writes is verified by the *real* probe against the *real*
 * `S3Store`, exactly as it would be if a person had pasted the same key by
 * hand.
 *
 * Five things must hold, and the first is the one this feature lives or dies
 * on:
 *
 *  1. **The setup credential is never persisted and never returned.** It can
 *     create buckets and mint further credentials in the customer's account,
 *     so it is categorically worse than the bucket key it produces. There is a
 *     test below that dumps every table and every public return value and
 *     looks for it.
 *  2. What *is* stored is exactly what a manual connect would have stored: a
 *     bucket-scoped access key id and the SHA-256 of the token value, and no
 *     third thing.
 *  3. A correctly scoped key or none at all — the permission group is resolved
 *     by name at runtime, and its absence stops the flow before a bucket is
 *     created rather than widening the key.
 *  4. Every failure is a recorded, actionable state. `10042` in particular is
 *     a billing prerequisite with a one-time fix, not a storage error.
 *  5. Nothing Cloudflare says about a credential ends up stored.
 *
 * Every value here is obviously fake. This repository is public.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";
import type { Id } from "../_generated/dataModel";
import { decryptSecret, requireKeyset } from "../functions/lib/crypto";
import {
  apiTokenTemplateUrl,
  bucketCreatedDuringAttempt,
  bucketNameProblem,
  bucketNotOursMessage,
  bucketResourceSelector,
  classifyCloudflareFailure,
  deriveS3SecretAccessKey,
  isPlausibleAccountId,
  provisionFailureMessage,
  r2Endpoint,
  residueAfterFailure,
  residueSentence,
  scopedTokenName,
  stripCredentialFields,
  suggestBucketName,
} from "../functions/lib/cloudflare";
import {
  type TestConvex,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  drainScheduled,
  errorCode,
  setupTest,
} from "./fixtures.helpers";
import { memoryS3 } from "./storeStub.helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

/* -------------------------------------------------------------------------- */
/*                          obviously fake constants                          */
/* -------------------------------------------------------------------------- */

/** 32 hex characters, the shape Cloudflare account ids have. Not a real one. */
const FAKE_ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
/** The credential a person pastes. The whole point is that it does not persist. */
const SETUP_TOKEN = "fake-cloudflare-setup-token-not-a-real-one";
/** What Cloudflare "returns" from the mint call. Also never persisted. */
const MINTED_TOKEN_VALUE = "fake-minted-r2-token-value-not-a-real-one";
const MINTED_TOKEN_ID = "fake0token0id0000000000000000000";
/** Deliberately not a real id: if it reached the policy it came from the wire. */
const WRITE_GROUP_ID = "fake-permission-group-id-not-a-real-one";
const BUCKET = "atlas-context";

interface CloudflareCall {
  method: string;
  path: string;
  authorization: string | null;
  jurisdiction: string | null;
  body: Record<string, unknown> | null;
}

interface CloudflareFailure {
  status: number;
  errors: { code: number; message: string }[];
}

interface CloudflareStubOptions {
  /** What `GET /user/tokens/permission_groups` answers with. */
  permissionGroups?: { id: string; name: string }[];
  permissionGroupsFailure?: CloudflareFailure;
  bucketFailure?: CloudflareFailure;
  /**
   * What `GET /accounts/:id/r2/buckets/:name` answers with — the call that
   * decides whether a name that is already taken belongs to a bucket this
   * attempt created. Absent means Cloudflare does not know the bucket, which
   * is the answer that must refuse rather than adopt.
   */
  bucketDetails?: { name?: string; creation_date?: string };
  tokenFailure?: CloudflareFailure;
  /** Reject the socket on the mint call, the way DNS or a deadline would. */
  tokenNetworkFailure?: boolean;
  /** Refuse to delete a minted token, so the orphan cannot be taken back. */
  tokenRevokeFailure?: CloudflareFailure;
  /** Return a token with no `value`, the way a truncated response would. */
  tokenWithoutValue?: boolean;
}

function cloudflareEnvelope(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function failureResponse(failure: CloudflareFailure): Response {
  return cloudflareEnvelope(
    { success: false, errors: failure.errors, result: null },
    failure.status,
  );
}

/**
 * Cloudflare's API, as far as this flow uses it.
 *
 * Records every call so a test can assert *which* requests were made and in
 * what order — "no bucket was created" is a property about a request that did
 * not happen, and it cannot be checked any other way.
 */
function cloudflareStub(options: CloudflareStubOptions = {}) {
  const calls: CloudflareCall[] = [];

  const fetchImpl = async (
    input: URL | RequestInfo,
    init: RequestInit = {},
  ): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : String(input));
    const headers = new Headers(init.headers ?? {});
    const call: CloudflareCall = {
      method: (init.method ?? "GET").toUpperCase(),
      path: url.pathname,
      authorization: headers.get("authorization"),
      jurisdiction: headers.get("cf-r2-jurisdiction"),
      body:
        typeof init.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : null,
    };
    calls.push(call);

    if (url.pathname === "/client/v4/user/tokens/permission_groups") {
      if (options.permissionGroupsFailure) {
        return failureResponse(options.permissionGroupsFailure);
      }
      return cloudflareEnvelope({
        success: true,
        errors: [],
        result: options.permissionGroups ?? [
          { id: "fake-read-group-id", name: "Workers R2 Storage Bucket Item Read" },
          { id: WRITE_GROUP_ID, name: "Workers R2 Storage Bucket Item Write" },
        ],
      });
    }

    if (url.pathname.includes("/r2/buckets/")) {
      if (options.bucketDetails === undefined) {
        return cloudflareEnvelope(
          { success: false, errors: [{ code: 10006, message: "The specified bucket does not exist." }], result: null },
          404,
        );
      }
      return cloudflareEnvelope({
        success: true,
        errors: [],
        result: options.bucketDetails,
      });
    }

    if (url.pathname.endsWith("/r2/buckets")) {
      if (options.bucketFailure) return failureResponse(options.bucketFailure);
      return cloudflareEnvelope({
        success: true,
        errors: [],
        result: { name: (call.body as { name?: string })?.name },
      });
    }

    if (call.method === "DELETE" && url.pathname.includes("/tokens/")) {
      if (options.tokenRevokeFailure) {
        return failureResponse(options.tokenRevokeFailure);
      }
      // Cloudflare's own answer here is a bare success envelope; the point of
      // the stub is that the call happened at all.
      return cloudflareEnvelope({ success: true, errors: [], result: null });
    }

    if (url.pathname.endsWith("/tokens")) {
      if (options.tokenNetworkFailure) throw new Error("network down");
      if (options.tokenFailure) return failureResponse(options.tokenFailure);
      return cloudflareEnvelope({
        success: true,
        errors: [],
        result: options.tokenWithoutValue
          ? { id: MINTED_TOKEN_ID }
          : { id: MINTED_TOKEN_ID, value: MINTED_TOKEN_VALUE },
      });
    }

    return cloudflareEnvelope({ success: false, errors: [], result: null }, 404);
  };

  return { calls, fetchImpl };
}

/**
 * A workspace whose owner is about to press the button, with Cloudflare and the
 * bucket that will exist afterwards both stubbed behind one `fetch`.
 *
 * The bucket backend is the same `memoryS3` the connect tests use, so the
 * verification this flow schedules exercises the real adapter against the
 * credential it just minted — which is the only way to know that what we stored
 * is usable rather than merely well-shaped.
 */
async function provisioning(options: CloudflareStubOptions = {}) {
  const t: TestConvex = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "atlas");

  const cloudflare = cloudflareStub(options);
  const bucket = memoryS3(BUCKET);

  vi.stubGlobal(
    "fetch",
    async (input: URL | RequestInfo, init: RequestInit = {}) => {
      const url = new URL(typeof input === "string" ? input : String(input));
      return url.hostname === "api.cloudflare.com"
        ? await cloudflare.fetchImpl(input, init)
        : await bucket.fetchImpl(input, init);
    },
  );

  return { t, owner, workspaceId, cloudflare, bucket };
}

/**
 * Point `fetch` at a fresh Cloudflare stub, keeping the S3 backend behind it.
 *
 * A retry is a second attempt against a Cloudflare that answers differently —
 * a permission fixed, a bucket that now exists — so a test of a retry needs to
 * replace the stub without replacing the workspace.
 */
function useCloudflare(options: CloudflareStubOptions = {}) {
  const cloudflare = cloudflareStub(options);
  const bucket = memoryS3(BUCKET);
  vi.stubGlobal("fetch", async (input: URL | RequestInfo, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : String(input));
    return url.hostname === "api.cloudflare.com"
      ? await cloudflare.fetchImpl(input, init)
      : await bucket.fetchImpl(input, init);
  });
  return cloudflare;
}

/**
 * Break `crypto.subtle.digest`, and nothing else.
 *
 * The S3 secret is the SHA-256 of the minted token's value, so a digest that
 * refuses stops the flow at exactly the point an eviction or a refused binding
 * write would: after a live R2 token exists in the customer's account, and
 * before anything in the control plane has recorded it. That window is the one
 * hazard this flow can create and then forget about, so it needs a test rather
 * than a comment.
 */
function withoutDigest(): void {
  const real = globalThis.crypto;
  const bound = (target: object, prop: string | symbol): unknown => {
    const value = Reflect.get(target, prop, target) as unknown;
    return typeof value === "function"
      ? (value as (...args: unknown[]) => unknown).bind(target)
      : value;
  };
  const subtle = new Proxy(real.subtle, {
    get: (target, prop) =>
      prop === "digest"
        ? async () => {
            throw new Error("digest unavailable");
          }
        : bound(target, prop),
  });
  vi.stubGlobal(
    "crypto",
    new Proxy(real, {
      get: (target, prop) => (prop === "subtle" ? subtle : bound(target, prop)),
    }),
  );
}

async function startProvisioning(
  t: TestConvex,
  userId: Id<"users">,
  workspaceId: Id<"workspaces">,
  overrides: Record<string, unknown> = {},
) {
  return await asUser(t, userId).action(
    api.functions.cloudflare.provisionCloudflareR2,
    {
      workspaceId,
      credential: {
        source: "api-token" as const,
        apiToken: SETUP_TOKEN,
        accountId: FAKE_ACCOUNT_ID,
      },
      bucket: BUCKET,
      ...overrides,
    },
  );
}

/** The binding row, read straight off the table. */
async function bindingRow(t: TestConvex, workspaceId: Id<"workspaces">) {
  return await t.run((ctx) =>
    ctx.db
      .query("storageBindings")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique(),
  );
}

async function provisioningRow(t: TestConvex, workspaceId: Id<"workspaces">) {
  return await t.run((ctx) =>
    ctx.db
      .query("cloudflareProvisioning")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique(),
  );
}

/** Every document in every table this deployment defines, as one string. */
async function everyStoredDocument(t: TestConvex): Promise<string> {
  const tables = Object.keys(schema.tables);
  const dumped: unknown[] = [];
  for (const table of tables) {
    const rows = await t.run((ctx) =>
      // The table list comes from the schema, so this is deliberately dynamic:
      // a table added later is searched without anybody remembering to add it.
      ctx.db.query(table as "storageBindings").collect(),
    );
    dumped.push({ table, rows });
  }
  return JSON.stringify(dumped);
}

/* -------------------------------------------------------------------------- */
/*                                 pure logic                                 */
/* -------------------------------------------------------------------------- */

describe("the pieces of the Cloudflare API this flow needs", () => {
  /**
   * The derivation is the one place a silent mistake produces a credential
   * that looks fine and signs nothing, so it is checked against a published
   * SHA-256 vector rather than against another call to itself.
   */
  test("the S3 secret is the lowercase hex SHA-256 of the token value", async () => {
    expect(await deriveS3SecretAccessKey("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(await deriveS3SecretAccessKey("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(await deriveS3SecretAccessKey("abc")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the endpoint carries the account id and the jurisdiction", () => {
    expect(r2Endpoint(FAKE_ACCOUNT_ID)).toBe(
      `https://${FAKE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    );
    expect(r2Endpoint(FAKE_ACCOUNT_ID, "eu")).toBe(
      `https://${FAKE_ACCOUNT_ID}.eu.r2.cloudflarestorage.com`,
    );
    expect(r2Endpoint(FAKE_ACCOUNT_ID, "fedramp")).toContain(".fedramp.");
    // The bucket is never in the host: R2's S3 endpoint is path-style.
    expect(r2Endpoint(FAKE_ACCOUNT_ID)).not.toContain(BUCKET);
  });

  /**
   * Getting this wrong in the lenient direction mints a key over *every* bucket
   * in the customer's account, which is the difference between holding a key to
   * their notes and holding a key to their storage.
   */
  test("the resource selector names exactly one bucket", () => {
    expect(bucketResourceSelector(FAKE_ACCOUNT_ID, "default", BUCKET)).toBe(
      `com.cloudflare.edge.r2.bucket.${FAKE_ACCOUNT_ID}_default_${BUCKET}`,
    );
    expect(bucketResourceSelector(FAKE_ACCOUNT_ID, "eu", BUCKET)).toContain("_eu_");
  });

  test("bucket names are checked against R2's rules, at the stricter end", () => {
    expect(bucketNameProblem(BUCKET)).toBeNull();
    expect(bucketNameProblem("abc")).toBeNull();
    expect(bucketNameProblem("ab")).toMatch(/3 and 63/);
    expect(bucketNameProblem("a".repeat(64))).toMatch(/3 and 63/);
    expect(bucketNameProblem("a".repeat(63))).toBeNull();
    expect(bucketNameProblem("Atlas")).toMatch(/lowercase/);
    expect(bucketNameProblem("atlas_context")).toMatch(/lowercase/);
    expect(bucketNameProblem("-atlas")).toMatch(/start and end/);
    expect(bucketNameProblem("atlas-")).toMatch(/start and end/);
    expect(bucketNameProblem("atlas/context")).not.toBeNull();
  });

  test("a suggested bucket name is always a legal one", () => {
    for (const slug of ["atlas", "ab", "a", "Seyi's Brain", "--", "x".repeat(80)]) {
      expect(bucketNameProblem(suggestBucketName(slug))).toBeNull();
    }
    expect(suggestBucketName("atlas")).toBe("atlas");
  });

  test("account ids are 32 hex characters", () => {
    expect(isPlausibleAccountId(FAKE_ACCOUNT_ID)).toBe(true);
    expect(isPlausibleAccountId(FAKE_ACCOUNT_ID.toUpperCase())).toBe(false);
    expect(isPlausibleAccountId("not-an-account-id")).toBe(false);
    expect(isPlausibleAccountId(`${FAKE_ACCOUNT_ID}0`)).toBe(false);
  });

  /**
   * The deep link is a *form pre-fill*, not an OAuth flow: no redirect, no
   * callback, no code exchange. The assertions are about what the person's
   * browser is handed, since nothing comes back to us.
   */
  test("the API-token deep link pre-fills the R2 permission and no account", () => {
    const url = new URL(apiTokenTemplateUrl({ name: scopedTokenName(BUCKET) }));
    expect(url.origin + url.pathname).toBe(
      "https://dash.cloudflare.com/profile/api-tokens",
    );
    expect(JSON.parse(url.searchParams.get("permissionGroupKeys") ?? "")).toEqual([
      { key: "workers_r2", type: "edit" },
    ]);
    // `*` leaves the account picker open. Naming one would be naming an account
    // nobody has told us about yet — which is the whole reason the account id
    // is a second field on the paste path.
    expect(url.searchParams.get("accountId")).toBe("*");
    expect(url.searchParams.get("name")).toBe(scopedTokenName(BUCKET));
    // No token, ever, in a URL.
    expect(url.toString()).not.toContain(SETUP_TOKEN);
  });

  test("extra permission keys slot in as data rather than as a guess", () => {
    const url = new URL(
      apiTokenTemplateUrl({
        name: "x",
        templateKeys: [
          { key: "workers_r2", type: "edit" },
          { key: "example_unverified_key", type: "edit" },
        ],
      }),
    );
    expect(JSON.parse(url.searchParams.get("permissionGroupKeys") ?? "")).toHaveLength(2);
  });

  /**
   * 10042 is checked before the status because it arrives as a 403, which is
   * otherwise indistinguishable from "this token may not do that" — two
   * failures whose fixes have nothing in common.
   */
  test("10042 is its own state, with its own message", () => {
    const failure = classifyCloudflareFailure({
      status: 403,
      errors: [{ code: 10042, message: "Please enable R2 through the Cloudflare Dashboard." }],
    });
    expect(failure.errorCode).toBe("R2_NOT_ENTITLED");
    // The three things the message has to say: what to do, that it is free,
    // and whose requirement the card is.
    expect(failure.message).toMatch(/R2 checkout/i);
    expect(failure.message).toMatch(/free/i);
    expect(failure.message).toMatch(/Cloudflare's requirement/i);
    expect(failure.message).not.toMatch(/error/i);
  });

  test("the other failures each land on their own code", () => {
    expect(
      classifyCloudflareFailure({
        status: 409,
        errors: [{ code: 10073, message: "The bucket you tried to create already exists" }],
      }).errorCode,
    ).toBe("BUCKET_NAME_TAKEN");
    expect(
      classifyCloudflareFailure({ status: 400, errors: [{ code: 10073, message: "" }] })
        .errorCode,
    ).toBe("BUCKET_NAME_TAKEN");
    expect(classifyCloudflareFailure({ status: 401, errors: [] }).errorCode).toBe(
      "CREDENTIAL_REJECTED",
    );
    expect(
      classifyCloudflareFailure({
        status: 400,
        errors: [{ code: 10000, message: "Authentication error" }],
      }).errorCode,
    ).toBe("CREDENTIAL_REJECTED");
    expect(classifyCloudflareFailure({ status: 403, errors: [] }).errorCode).toBe(
      "INSUFFICIENT_PERMISSIONS",
    );
    expect(classifyCloudflareFailure({ status: 503, errors: [] }).errorCode).toBe(
      "CLOUDFLARE_UNAVAILABLE",
    );
    expect(classifyCloudflareFailure({ status: 418, errors: [] }).errorCode).toBe(
      "PROVISION_FAILED",
    );
  });

  /**
   * A 403 that is really a billing state must not be reported as a permissions
   * problem, whichever order the errors arrive in.
   */
  test("an entitlement failure wins over a permissions failure", () => {
    expect(
      classifyCloudflareFailure({
        status: 403,
        errors: [
          { code: 9109, message: "Unauthorized to access requested resource" },
          { code: 10042, message: "NotEntitled" },
        ],
      }).errorCode,
    ).toBe("R2_NOT_ENTITLED");
  });
});

/* -------------------------------------------------------------------------- */
/*                               the whole flow                               */
/* -------------------------------------------------------------------------- */

describe("provisioning a bucket in the customer's account", () => {
  test("writes a binding that is exactly what a manual connect would have written", async () => {
    const { t, owner, workspaceId, cloudflare } = await provisioning();

    const started = await startProvisioning(t, owner, workspaceId);
    expect(started.status).toBe("pending");
    await drainScheduled(t);

    const binding = await bindingRow(t, workspaceId);
    expect(binding).not.toBeNull();
    expect(binding!.provider).toBe("r2");
    expect(binding!.endpoint).toBe(
      `https://${FAKE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    );
    expect(binding!.region).toBe("auto");
    expect(binding!.bucket).toBe(BUCKET);
    // The access key id is the token's id; the secret is the hash of its value.
    expect(binding!.accessKeyId).toBe(MINTED_TOKEN_ID);
    expect(
      await decryptSecret(binding!.encryptedSecretAccessKey, requireKeyset(), {
        workspaceId,
      }),
    ).toBe(await deriveS3SecretAccessKey(MINTED_TOKEN_VALUE));
    // R2 is path-style and its host label is the account id, so there is
    // nothing ambiguous to record — the same absence a manual connect leaves.
    expect(binding!.forcePathStyle).toBeUndefined();

    // And the binding was actually verified against the bucket, by the same
    // probe `bindStorage` schedules — so this is a usable credential, not just
    // a well-shaped one.
    expect(binding!.status).toBe("connected");

    // Three calls, in the order that makes the third one safe.
    expect(cloudflare.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /client/v4/user/tokens/permission_groups",
      `POST /client/v4/accounts/${FAKE_ACCOUNT_ID}/r2/buckets`,
      `POST /client/v4/accounts/${FAKE_ACCOUNT_ID}/tokens`,
    ]);
    for (const call of cloudflare.calls) {
      expect(call.authorization).toBe(`Bearer ${SETUP_TOKEN}`);
    }
  });

  test("the minted token is scoped to one bucket with a runtime-resolved group", async () => {
    const { t, owner, workspaceId, cloudflare } = await provisioning({
      permissionGroups: [
        { id: "fake-unrelated-group", name: "Workers R2 Storage Bucket Item Read" },
        { id: WRITE_GROUP_ID, name: "Workers R2 Storage Bucket Item Write" },
      ],
    });
    await startProvisioning(t, owner, workspaceId);
    await drainScheduled(t);

    const mint = cloudflare.calls.find((call) => call.path.endsWith("/tokens"))!;
    const policy = (mint.body as { policies: Record<string, unknown>[] }).policies[0];
    // The id came off the wire. It is not a value any source file contains, so
    // a hardcoded id could not produce this.
    expect(policy.permission_groups).toEqual([{ id: WRITE_GROUP_ID }]);
    expect(policy.effect).toBe("allow");
    expect(Object.keys(policy.resources as Record<string, string>)).toEqual([
      `com.cloudflare.edge.r2.bucket.${FAKE_ACCOUNT_ID}_default_${BUCKET}`,
    ]);
  });

  test("a jurisdiction travels as a header, not as a body field", async () => {
    const { t, owner, workspaceId, cloudflare } = await provisioning();
    await startProvisioning(t, owner, workspaceId, { jurisdiction: "eu" });
    await drainScheduled(t);

    const create = cloudflare.calls.find((call) => call.path.endsWith("/r2/buckets"))!;
    expect(create.jurisdiction).toBe("eu");
    expect(create.body).not.toHaveProperty("jurisdiction");
    const mint = cloudflare.calls.find((call) => call.path.endsWith("/tokens"))!;
    const policy = (mint.body as { policies: Record<string, unknown>[] }).policies[0];
    expect(Object.keys(policy.resources as Record<string, string>)[0]).toContain("_eu_");
    const binding = await bindingRow(t, workspaceId);
    expect(binding!.endpoint).toContain(".eu.r2.cloudflarestorage.com");
  });

  test("a location hint is passed through and nothing else is invented", async () => {
    const { t, owner, workspaceId, cloudflare } = await provisioning();
    await startProvisioning(t, owner, workspaceId, { locationHint: "weur" });
    await drainScheduled(t);

    const create = cloudflare.calls.find((call) => call.path.endsWith("/r2/buckets"))!;
    expect(create.body).toEqual({ name: BUCKET, locationHint: "weur" });
    expect(create.jurisdiction).toBeNull();
  });

  test("the in-flight row is gone the moment it succeeds", async () => {
    const { t, owner, workspaceId } = await provisioning();
    await startProvisioning(t, owner, workspaceId);
    await drainScheduled(t);

    expect(await provisioningRow(t, workspaceId)).toBeNull();
    expect(
      await asUser(t, owner).query(api.functions.cloudflare.getCloudflareProvisioning, {
        workspaceId,
      }),
    ).toBeNull();
  });

  test("the owner's audit trail says a bucket was created for them", async () => {
    const { t, owner, workspaceId } = await provisioning();
    await startProvisioning(t, owner, workspaceId);
    await drainScheduled(t);

    const events = await asUser(t, owner).query(api.functions.audit.listEvents, {
      workspaceId,
    });
    const actions = events.map((event) => event.action);
    expect(actions).toContain("storage.provision_requested");
    expect(actions).toContain("storage.provisioned");
    // …and the binding was written through the same path a manual connect uses.
    expect(actions).toContain("storage.bound");
  });
});

/* -------------------------------------------------------------------------- */
/*                        the property this feature is                        */
/* -------------------------------------------------------------------------- */

describe("the setup credential does not survive the flow", () => {
  /**
   * THE TEST THIS FEATURE EXISTS UNDER.
   *
   * Not "it is not in the binding" — *no table*, including the one that briefly
   * holds it, and including the audit trail, and including anything a public
   * function hands back. Sabotage it by having the flow store or return the
   * token and this fails.
   */
  test("the token appears in no table and in no public return value", async () => {
    const { t, owner, workspaceId } = await provisioning();

    const started = await startProvisioning(t, owner, workspaceId);
    expect(JSON.stringify(started)).not.toContain(SETUP_TOKEN);

    // Checked *before* the scheduled job as well as after it. The in-flight row
    // is deleted on success, so a leak into it would otherwise be tidied away
    // by the very thing that made it — and the window it exists in is exactly
    // the window this feature adds.
    expect(await everyStoredDocument(t)).not.toContain(SETUP_TOKEN);

    await drainScheduled(t);

    expect(await everyStoredDocument(t)).not.toContain(SETUP_TOKEN);
    // The minted token's own value is a Cloudflare credential too: only its
    // SHA-256 is ever stored, so the value itself must be absent as well.
    expect(await everyStoredDocument(t)).not.toContain(MINTED_TOKEN_VALUE);

    const view = asUser(t, owner);
    const returned = JSON.stringify([
      await view.query(api.functions.cloudflare.getCloudflareProvisioning, {
        workspaceId,
      }),
      await view.query(api.functions.cloudflare.getCloudflareSetupLink, { workspaceId }),
      await view.query(api.functions.storage.getStorageBinding, { workspaceId }),
      await view.query(api.functions.audit.listEvents, { workspaceId }),
    ]);
    expect(returned).not.toContain(SETUP_TOKEN);
    expect(returned).not.toContain(MINTED_TOKEN_VALUE);
  });

  /**
   * THE SEALED ENVELOPE IS NOT A CONSOLATION PRIZE EITHER.
   *
   * A test that only searches for the plaintext passes happily while a public
   * query hands out the ciphertext, which is the same disclosure with an
   * offline step in front of it — `functions/storage.ts` says exactly this
   * about `encryptedSecretAccessKey`, and the rule is not weaker here because
   * the credential is more powerful. Checked while the attempt is still in
   * flight, because that is the only moment an envelope exists to leak.
   */
  test("no public function hands out the sealed envelope", async () => {
    const { t, owner, workspaceId } = await provisioning();
    await startProvisioning(t, owner, workspaceId);

    const envelope = (await provisioningRow(t, workspaceId))!.encryptedSetupCredential!;
    expect(envelope.length).toBeGreaterThan(20);

    const view = asUser(t, owner);
    const returned = JSON.stringify([
      await view.query(api.functions.cloudflare.getCloudflareProvisioning, {
        workspaceId,
      }),
      await view.query(api.functions.cloudflare.getCloudflareSetupLink, { workspaceId }),
      await view.query(api.functions.storage.getStorageBinding, { workspaceId }),
      await view.query(api.functions.audit.listEvents, { workspaceId }),
    ]);
    expect(returned).not.toContain(envelope);
  });

  /** The sealed envelope is not a consolation prize — it goes too. */
  test("nothing is left sealed on the row either", async () => {
    const { t, owner, workspaceId } = await provisioning();
    await startProvisioning(t, owner, workspaceId);

    // Before the scheduled job runs, the envelope is on the row — and it is an
    // envelope, not the token.
    const pending = await provisioningRow(t, workspaceId);
    expect(pending!.status).toBe("pending");
    expect(pending!.encryptedSetupCredential).toBeDefined();
    expect(pending!.encryptedSetupCredential).not.toContain(SETUP_TOKEN);
    expect(
      await decryptSecret(pending!.encryptedSetupCredential!, requireKeyset(), {
        workspaceId,
      }),
    ).toBe(SETUP_TOKEN);

    await drainScheduled(t);
    expect(await provisioningRow(t, workspaceId)).toBeNull();
  });

  /**
   * The envelope is bound to its workspace, exactly like a storage secret, so
   * a row copied into another context yields a decrypt failure rather than
   * somebody else's Cloudflare account.
   */
  test("the envelope only opens in the workspace it was sealed for", async () => {
    const { t, owner, workspaceId } = await provisioning();
    const otherWorkspace = await createWorkspace(t, owner, "borealis");
    await startProvisioning(t, owner, workspaceId);

    const pending = await provisioningRow(t, workspaceId);
    await expect(
      decryptSecret(pending!.encryptedSetupCredential!, requireKeyset(), {
        workspaceId: otherWorkspace,
      }),
    ).rejects.toThrow();
  });

  /** A failure keeps the explanation and drops the credential. */
  test("a failed attempt keeps its reason and loses its credential", async () => {
    const { t, owner, workspaceId } = await provisioning({
      bucketFailure: {
        status: 403,
        errors: [{ code: 10042, message: "Please enable R2 through the Cloudflare Dashboard." }],
      },
    });
    await startProvisioning(t, owner, workspaceId);
    await drainScheduled(t);

    const row = await provisioningRow(t, workspaceId);
    expect(row!.status).toBe("failed");
    expect(row!.encryptedSetupCredential).toBeUndefined();
    expect(await everyStoredDocument(t)).not.toContain(SETUP_TOKEN);
  });

  /**
   * Nothing a provider says about a credential ends up stored. Cloudflare has
   * no reason to echo a token back, which is exactly why this is checked: the
   * recorded string is provider text on a surface every member can read.
   */
  test("provider text that quotes the token is redacted before it is stored", async () => {
    const { t, owner, workspaceId } = await provisioning({
      bucketFailure: {
        status: 400,
        errors: [{ code: 1234, message: `Invalid token ${SETUP_TOKEN} supplied` }],
      },
    });
    await startProvisioning(t, owner, workspaceId);
    await drainScheduled(t);

    const row = await provisioningRow(t, workspaceId);
    expect(row!.error).toBeDefined();
    expect(row!.error).not.toContain(SETUP_TOKEN);
    expect(row!.error).toContain("[redacted]");
    expect(await everyStoredDocument(t)).not.toContain(SETUP_TOKEN);
  });
});

/* -------------------------------------------------------------------------- */
/*                              failing honestly                              */
/* -------------------------------------------------------------------------- */

describe("every failure is a state the owner can act on", () => {
  test("10042 is a billing prerequisite, not a storage error", async () => {
    const { t, owner, workspaceId } = await provisioning({
      bucketFailure: {
        status: 403,
        errors: [{ code: 10042, message: "Please enable R2 through the Cloudflare Dashboard." }],
      },
    });
    await startProvisioning(t, owner, workspaceId);
    await drainScheduled(t);

    const published = await asUser(t, owner).query(
      api.functions.cloudflare.getCloudflareProvisioning,
      { workspaceId },
    );
    expect(published!.status).toBe("failed");
    expect(published!.errorCode).toBe("R2_NOT_ENTITLED");
    expect(published!.error).toMatch(/free/i);
    expect(published!.error).toMatch(/R2 checkout/i);

    // No half-built binding was left behind.
    expect(await bindingRow(t, workspaceId)).toBeNull();
  });

  test("a name that is already taken is handled rather than thrown", async () => {
    const { t, owner, workspaceId, cloudflare } = await provisioning({
      bucketFailure: {
        status: 409,
        errors: [{ code: 10073, message: "The bucket you tried to create already exists." }],
      },
    });
    // The public call still succeeds — the work is scheduled, not awaited.
    await startProvisioning(t, owner, workspaceId);
    await drainScheduled(t);

    const row = await provisioningRow(t, workspaceId);
    expect(row!.status).toBe("failed");
    expect(row!.errorCode).toBe("BUCKET_NAME_TAKEN");
    expect(row!.error).toMatch(/different name/i);
    // No token was minted for a bucket that was not created.
    expect(cloudflare.calls.some((call) => call.path.endsWith("/tokens"))).toBe(false);
    expect(await bindingRow(t, workspaceId)).toBeNull();
  });

  /**
   * A correctly scoped key or none at all. If Cloudflare cannot offer the write
   * permission group, the flow stops *before* creating a bucket — there is no
   * branch that widens the key to get past it.
   */
  test("an unavailable permission group stops the flow before anything is created", async () => {
    const { t, owner, workspaceId, cloudflare } = await provisioning({
      permissionGroups: [
        { id: "fake-read-group-id", name: "Workers R2 Storage Bucket Item Read" },
      ],
    });
    await startProvisioning(t, owner, workspaceId);
    await drainScheduled(t);

    const row = await provisioningRow(t, workspaceId);
    expect(row!.errorCode).toBe("PERMISSION_GROUP_UNAVAILABLE");
    expect(row!.error).toMatch(/nothing broader/i);
    expect(cloudflare.calls.map((call) => call.path)).toEqual([
      "/client/v4/user/tokens/permission_groups",
    ]);
  });

  test("a rejected credential says so, and says to replace it", async () => {
    const { t, owner, workspaceId } = await provisioning({
      permissionGroupsFailure: {
        status: 401,
        errors: [{ code: 10000, message: "Authentication error" }],
      },
    });
    await startProvisioning(t, owner, workspaceId);
    await drainScheduled(t);

    const row = await provisioningRow(t, workspaceId);
    expect(row!.errorCode).toBe("CREDENTIAL_REJECTED");
    expect(row!.error).toMatch(/fresh API token/i);
  });

  test("a token Cloudflare will not show us is a failure, not a broken binding", async () => {
    const { t, owner, workspaceId } = await provisioning({ tokenWithoutValue: true });
    await startProvisioning(t, owner, workspaceId);
    await drainScheduled(t);

    expect((await provisioningRow(t, workspaceId))!.errorCode).toBe("PROVISION_FAILED");
    expect(await bindingRow(t, workspaceId)).toBeNull();
  });

  test("Cloudflare being unreachable is retryable and changes nothing", async () => {
    const { t, owner, workspaceId } = await provisioning();
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    await startProvisioning(t, owner, workspaceId);
    await drainScheduled(t);

    const row = await provisioningRow(t, workspaceId);
    expect(row!.errorCode).toBe("CLOUDFLARE_UNAVAILABLE");
    expect(await bindingRow(t, workspaceId)).toBeNull();
  });

  /**
   * A failed provisioning attempt must not disturb storage that already works.
   * The failure is about a bucket that does not exist; the binding is about one
   * that does.
   */
  test("a failed attempt does not touch an existing binding", async () => {
    const { t, owner, workspaceId } = await provisioning();
    await startProvisioning(t, owner, workspaceId);
    await drainScheduled(t);
    const before = await bindingRow(t, workspaceId);
    expect(before!.status).toBe("connected");

    // Same workspace, second attempt, Cloudflare now refusing.
    const failing = cloudflareStub({
      bucketFailure: { status: 500, errors: [{ code: 1, message: "boom" }] },
    });
    const bucket = memoryS3(BUCKET);
    vi.stubGlobal("fetch", async (input: URL | RequestInfo, init: RequestInit = {}) => {
      const url = new URL(typeof input === "string" ? input : String(input));
      return url.hostname === "api.cloudflare.com"
        ? await failing.fetchImpl(input, init)
        : await bucket.fetchImpl(input, init);
    });
    await startProvisioning(t, owner, workspaceId, { bucket: "atlas-second" });
    await drainScheduled(t);

    const after = await bindingRow(t, workspaceId);
    expect(after!.status).toBe("connected");
    expect(after!.bucket).toBe(BUCKET);
    expect(after!.accessKeyId).toBe(before!.accessKeyId);
    expect((await provisioningRow(t, workspaceId))!.errorCode).toBe(
      "CLOUDFLARE_UNAVAILABLE",
    );
  });
});

/* -------------------------------------------------------------------------- */
/*                             who may ask for it                             */
/* -------------------------------------------------------------------------- */

describe("only an owner may create storage for a context", () => {
  test("a member of another context cannot provision into this one", async () => {
    const { t, workspaceId, cloudflare } = await provisioning();
    const stranger = await createUser(t, "stranger@example.invalid");

    const error = await captureError(() =>
      startProvisioning(t, stranger, workspaceId),
    );
    // The same refusal a non-existent workspace gets: a stranger learns
    // nothing about whether this context is here.
    expect(errorCode(error)).toBe("WORKSPACE_NOT_FOUND");
    expect(cloudflare.calls).toEqual([]);
    expect(await provisioningRow(t, workspaceId)).toBeNull();
  });

  test("an editor cannot provision, and nothing is queued when they try", async () => {
    const { t, workspaceId, cloudflare } = await provisioning();
    const editor = await createUser(t, "editor@example.invalid");
    await t.run((ctx) =>
      ctx.db.insert("workspaceMembers", {
        workspaceId,
        userId: editor,
        role: "editor",
        joinedAt: Date.now(),
      }),
    );

    const error = await captureError(() => startProvisioning(t, editor, workspaceId));
    expect(errorCode(error)).toBe("INSUFFICIENT_ROLE");
    expect(cloudflare.calls).toEqual([]);
    expect(await provisioningRow(t, workspaceId)).toBeNull();
  });

  test("the setup link is owner-only", async () => {
    const { t, owner, workspaceId } = await provisioning();
    const member = await createUser(t, "member@example.invalid");
    await t.run((ctx) =>
      ctx.db.insert("workspaceMembers", {
        workspaceId,
        userId: member,
        role: "member",
        joinedAt: Date.now(),
      }),
    );

    expect(
      errorCode(
        await captureError(() =>
          asUser(t, member).query(api.functions.cloudflare.getCloudflareSetupLink, {
            workspaceId,
          }),
        ),
      ),
    ).toBe("INSUFFICIENT_ROLE");

    const link = await asUser(t, owner).query(
      api.functions.cloudflare.getCloudflareSetupLink,
      { workspaceId },
    );
    expect(link.suggestedBucket).toBe("atlas");
    expect(link.accountIdRequired).toBe(true);
  });

  test("status is readable by any member, the credential by nobody", async () => {
    const { t, owner, workspaceId } = await provisioning();
    const member = await createUser(t, "member@example.invalid");
    await t.run((ctx) =>
      ctx.db.insert("workspaceMembers", {
        workspaceId,
        userId: member,
        role: "member",
        joinedAt: Date.now(),
      }),
    );
    await startProvisioning(t, owner, workspaceId);

    const view = await asUser(t, member).query(
      api.functions.cloudflare.getCloudflareProvisioning,
      { workspaceId },
    );
    expect(view!.status).toBe("pending");
    expect(JSON.stringify(view)).not.toContain(SETUP_TOKEN);
    expect(Object.keys(view!)).not.toContain("encryptedSetupCredential");
  });
});

/* -------------------------------------------------------------------------- */
/*                          refusals and the in-flight row                    */
/* -------------------------------------------------------------------------- */

describe("what is refused before Cloudflare is ever called", () => {
  test("an implausible account id, an illegal bucket name, an empty token", async () => {
    const { t, owner, workspaceId, cloudflare } = await provisioning();

    expect(
      errorCode(
        await captureError(() =>
          startProvisioning(t, owner, workspaceId, {
            credential: {
              source: "api-token",
              apiToken: SETUP_TOKEN,
              accountId: "not-an-account",
            },
          }),
        ),
      ),
    ).toBe("INVALID_ACCOUNT_ID");

    expect(
      errorCode(
        await captureError(() =>
          startProvisioning(t, owner, workspaceId, { bucket: "Not A Bucket" }),
        ),
      ),
    ).toBe("INVALID_BUCKET_NAME");

    expect(
      errorCode(
        await captureError(() =>
          startProvisioning(t, owner, workspaceId, {
            credential: { source: "api-token", apiToken: "  ", accountId: FAKE_ACCOUNT_ID },
          }),
        ),
      ),
    ).toBe("INVALID_CREDENTIAL");

    expect(cloudflare.calls).toEqual([]);
    expect(await provisioningRow(t, workspaceId)).toBeNull();
  });

  test("two runs at once would orphan a credential, so the second is refused", async () => {
    const { t, owner, workspaceId } = await provisioning();
    await startProvisioning(t, owner, workspaceId);

    expect(
      errorCode(
        await captureError(() =>
          startProvisioning(t, owner, workspaceId, { bucket: "atlas-again" }),
        ),
      ),
    ).toBe("PROVISION_IN_PROGRESS");
  });

  test("a failed attempt can simply be retried", async () => {
    const { t, owner, workspaceId } = await provisioning({
      bucketFailure: { status: 500, errors: [{ code: 1, message: "boom" }] },
    });
    await startProvisioning(t, owner, workspaceId);
    await drainScheduled(t);
    expect((await provisioningRow(t, workspaceId))!.status).toBe("failed");

    // Cloudflare recovers; the same call goes through and the stale failure is
    // not left sitting next to a working binding.
    const working = cloudflareStub();
    const bucket = memoryS3(BUCKET);
    vi.stubGlobal("fetch", async (input: URL | RequestInfo, init: RequestInit = {}) => {
      const url = new URL(typeof input === "string" ? input : String(input));
      return url.hostname === "api.cloudflare.com"
        ? await working.fetchImpl(input, init)
        : await bucket.fetchImpl(input, init);
    });
    await startProvisioning(t, owner, workspaceId);
    await drainScheduled(t);

    expect(await provisioningRow(t, workspaceId)).toBeNull();
    expect((await bindingRow(t, workspaceId))!.accessKeyId).toBe(MINTED_TOKEN_ID);
  });

  test("dismissing a stuck attempt destroys the sealed credential now", async () => {
    const { t, owner, workspaceId } = await provisioning();
    await startProvisioning(t, owner, workspaceId);
    expect((await provisioningRow(t, workspaceId))!.encryptedSetupCredential).toBeDefined();

    const dismissed = await asUser(t, owner).mutation(
      api.functions.cloudflare.dismissProvisioning,
      { workspaceId },
    );
    expect(dismissed).toEqual({ dismissed: true });
    expect(await provisioningRow(t, workspaceId)).toBeNull();
    expect(await everyStoredDocument(t)).not.toContain(SETUP_TOKEN);

    // The job that was already queued finds nothing to do and writes no
    // binding, rather than finishing a run the owner cancelled.
    await drainScheduled(t);
    expect(await bindingRow(t, workspaceId)).toBeNull();
  });

  test("dismissing is owner-only, and is a no-op when there is nothing to dismiss", async () => {
    const { t, owner, workspaceId } = await provisioning();
    const editor = await createUser(t, "editor@example.invalid");
    await t.run((ctx) =>
      ctx.db.insert("workspaceMembers", {
        workspaceId,
        userId: editor,
        role: "editor",
        joinedAt: Date.now(),
      }),
    );

    expect(
      await asUser(t, owner).mutation(api.functions.cloudflare.dismissProvisioning, {
        workspaceId,
      }),
    ).toEqual({ dismissed: false });

    await startProvisioning(t, owner, workspaceId);
    expect(
      errorCode(
        await captureError(() =>
          asUser(t, editor).mutation(api.functions.cloudflare.dismissProvisioning, {
            workspaceId,
          }),
        ),
      ),
    ).toBe("INSUFFICIENT_ROLE");
    expect((await provisioningRow(t, workspaceId))!.status).toBe("pending");
  });
});
