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
 *  4. Every failure is a recorded, actionable state, and it is **honest about
 *     what is in the customer's Cloudflare account** — the expected failure of
 *     this flow creates a bucket and is then refused at the mint, and a message
 *     that says "nothing was changed" there is what makes the retry a dead end.
 *     `10042` in particular is a billing prerequisite with a one-time fix, not
 *     a storage error.
 *  5. Nothing Cloudflare says about a credential ends up stored.
 *  6. An attempt that never finishes still stops holding the credential.
 *
 * Every value here is obviously fake. This repository is public.
 */

import { afterEach, vi } from "vitest";
import { api } from "../../_generated/api";
import schema from "../../schema";
import type { Id } from "../../_generated/dataModel";
import {
  type TestConvex,
  asUser,
  createUser,
  createWorkspace,
  setupTest,
} from "../fixtures.helpers";
import { memoryS3 } from "../storeStub.helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

/* -------------------------------------------------------------------------- */
/*                          obviously fake constants                          */
/* -------------------------------------------------------------------------- */

/** 32 hex characters, the shape Cloudflare account ids have. Not a real one. */
export const FAKE_ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
/** The credential a person pastes. The whole point is that it does not persist. */
export const SETUP_TOKEN = "fake-cloudflare-setup-token-not-a-real-one";
/** What Cloudflare "returns" from the mint call. Also never persisted. */
export const MINTED_TOKEN_VALUE = "fake-minted-r2-token-value-not-a-real-one";
export const MINTED_TOKEN_ID = "fake0token0id0000000000000000000";
/** Deliberately not a real id: if it reached the policy it came from the wire. */
export const WRITE_GROUP_ID = "fake-permission-group-id-not-a-real-one";
export const BUCKET = "atlas-context";

export interface CloudflareCall {
  method: string;
  path: string;
  authorization: string | null;
  jurisdiction: string | null;
  body: Record<string, unknown> | null;
}

export interface CloudflareFailure {
  status: number;
  errors: { code: number; message: string }[];
}

export interface CloudflareStubOptions {
  /** What `GET /accounts/:id/tokens/permission_groups` answers with. */
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
  /**
   * A verbatim body for the mint call — the one endpoint whose response body
   * can carry a live credential, and the one place the raw-body fallback in
   * `describeErrors` can reach one.
   */
  tokenFailureBody?: { status: number; body: unknown };
  /** Return a token with no `value`, the way a truncated response would. */
  tokenWithoutValue?: boolean;
}

export function cloudflareEnvelope(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function failureResponse(failure: CloudflareFailure): Response {
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
export function cloudflareStub(options: CloudflareStubOptions = {}) {
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

    if (
      url.pathname ===
      `/client/v4/accounts/${FAKE_ACCOUNT_ID}/tokens/permission_groups`
    ) {
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
      if (options.tokenFailureBody) {
        return cloudflareEnvelope(
          options.tokenFailureBody.body,
          options.tokenFailureBody.status,
        );
      }
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
export async function provisioning(options: CloudflareStubOptions = {}) {
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
export function useCloudflare(options: CloudflareStubOptions = {}) {
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
export function withoutDigest(): void {
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

export async function startProvisioning(
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
export async function bindingRow(t: TestConvex, workspaceId: Id<"workspaces">) {
  return await t.run((ctx) =>
    ctx.db
      .query("storageBindings")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique(),
  );
}

export async function provisioningRow(t: TestConvex, workspaceId: Id<"workspaces">) {
  return await t.run((ctx) =>
    ctx.db
      .query("cloudflareProvisioning")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique(),
  );
}

/** Every document in every table this deployment defines, as one string. */
export async function everyStoredDocument(t: TestConvex): Promise<string> {
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

