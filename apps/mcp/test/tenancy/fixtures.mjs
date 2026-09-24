/**
 * Shared fixtures for `test/tenancy/*.test.mjs`, split out of the original
 * tenancy.test.mjs — see tenancy.test.mjs for the module overview and the
 * sabotage-testing record.
 */

import worker from "../../src/index.js";
import { createControlPlane } from "../../src/controlPlane.js";
import {
  CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
  createControlPlaneStub,
  createDropboxBackend,
  createS3Backend,
  sha256Hex,
} from "../controlPlaneStub.mjs";
import { createWorkerCtx } from "../workerCtx.mjs";

export {
  worker,
  createControlPlane,
  CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
  createControlPlaneStub,
  createDropboxBackend,
  createS3Backend,
  sha256Hex,
  createWorkerCtx,
};

export const S3_ENDPOINT = "https://s3.example-object-storage.test";

/** A token long enough to be a real one; obviously fake, as this repo is public. */
export function token(label) {
  return `cat_${label}_${"0".repeat(Math.max(0, 34 - label.length))}`;
}

export const TOKEN_A = token("tenant_a_owner");
export const TOKEN_B = token("tenant_b_owner");
export const TOKEN_A_READONLY = token("tenant_a_readonly");
export const TOKEN_A_SIBLING = token("tenant_a_sibling");
export const REFRESH_A = `crt_tenant_a_${"0".repeat(24)}`;

/**
 * Two more tenants on the one-click tier.
 *
 * Dropbox has no bucket name and no per-tenant endpoint, so the S3 pair's
 * "adjacent bucket names on one endpoint" arrangement has an even tighter
 * Dropbox equivalent: **the same two URLs and the same rootPrefix, separated by
 * the access token alone.** If the token is not what decides, these two see
 * each other, and their identically-keyed notes are what says so.
 */
export const TOKEN_C = token("tenant_c_owner");
export const TOKEN_D = token("tenant_d_owner");
/** Dropbox's own short-lived tokens are `sl.`-prefixed. Obviously fake. */
export const DROPBOX_TOKEN_C = "sl.FAKE-tenant-c-access-token";
export const DROPBOX_TOKEN_D = "sl.FAKE-tenant-d-access-token";

export async function rpc(env, tokenValue, method, params, { path = "/mcp" } = {}) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request(`https://mcp.context.test${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenValue}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    env,
    ctx
  );
  const text = await response.text();
  await settle();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { response, status: response.status, text, body };
}

export async function callTool(env, tokenValue, name, args = {}, options = {}) {
  const { body } = await rpc(env, tokenValue, "tools/call", { name, arguments: args }, options);
  return body?.result;
}

export function form(fields) {
  return new URLSearchParams(fields).toString();
}

export async function postForm(env, path, fields, init = {}) {
  const response = await worker.fetch(
    new Request(`https://mcp.context.test${path}`, {
      method: "POST",
      // `init.headers` last, so a caller can add an Authorization header —
      // and, deliberately, override the content type, which is what a test of
      // a wrong media type would need. It is the caller's to lose.
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...(init.headers ?? {}) },
      body: form(fields),
    }),
    env,
    { waitUntil() {} }
  );
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { response, status: response.status, body, text };
}

/** base64url of the SHA-256 of a verifier — an S256 PKCE challenge. */
export async function s256(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const PRIVACY_MANIFEST =
  "---\nrole: privacy-manifest\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  1-projects: team\n\nnote_overrides:\n  # none\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

/**
 * Temporarily answer selected control-plane paths with a scripted payload,
 * falling through to the real stub for anything the script returns null for.
 */
export function withControlPlaneOverride(script, controlPlane) {
  const previous = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith(CONTROL_PLANE_ORIGIN)) {
      const path = new URL(url).pathname;
      const body = init?.body ? JSON.parse(init.body) : {};
      const scripted = script(path, body);
      if (scripted !== null && scripted !== undefined) {
        return new Response(JSON.stringify(scripted), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return controlPlane.handle(url, init);
    }
    return previous(input, init);
  };
  return () => {
    globalThis.fetch = previous;
  };
}

/** The smallest thing that looks like an R2 binding. */
export function memoryR2(seed = {}) {
  const objects = new Map(
    Object.entries(seed).map(([key, body]) => [key, { body, etag: `m${key.length}` }])
  );
  let counter = 0;
  return {
    async get(key) {
      if (!objects.has(key)) return null;
      const { body, etag } = objects.get(key);
      return {
        etag,
        text: async () => body,
        arrayBuffer: async () => new TextEncoder().encode(body).buffer,
      };
    },
    async put(key, value, options = {}) {
      const expected = options?.onlyIf?.etagMatches;
      if (expected && objects.get(key)?.etag !== expected) return null;
      const body = typeof value === "string" ? value : new TextDecoder().decode(value);
      const etag = `m${++counter}`;
      objects.set(key, { body, etag });
      return { etag };
    },
    async delete(key) {
      objects.delete(key);
    },
    async list({ prefix } = {}) {
      return {
        objects: [...objects.keys()]
          .filter((key) => !prefix || key.startsWith(prefix))
          .sort()
          // `etag` per listed object, as R2 and S3 both report it — the search
          // index diffs on it, and a stub that omits it makes every note look
          // stale on every pass.
          .map((key) => ({
            key,
            size: objects.get(key).body.length,
            uploaded: new Date(),
            etag: objects.get(key).etag,
          })),
        truncated: false,
      };
    },
  };
}

/**
 * Builds the shared fixture every tenancy section runs against: two S3
 * tenants on the same endpoint with adjacent bucket names, two Dropbox
 * tenants sharing the same URLs and folder name, separated by their access
 * tokens alone, and the control-plane grants and env each section's checks
 * need.
 *
 * Call `harness.restoreAll()` once, after every section has run, to restore
 * `globalThis.fetch` and uninstall the control-plane, S3 and Dropbox stubs in
 * the same order the original single-function suite did.
 */
export async function createTenancyHarness() {
  const previousFetch = globalThis.fetch;
  const restoreFetch = () => {
    globalThis.fetch = previousFetch;
  };

  const s3 = createS3Backend(S3_ENDPOINT);
  const restoreS3 = s3.install();
  const dropbox = createDropboxBackend();
  const restoreDropbox = dropbox.install();
  const controlPlane = createControlPlaneStub();
  const restoreControlPlane = controlPlane.install();

  // Two customers, same provider, same endpoint, adjacent bucket names. A
  // rootPrefix on A as well, to prove it is applied inside the adapter and is
  // invisible to — and not a substitute for — tenancy.
  controlPlane.addWorkspace("ws_a", "alpha", {
    provider: "s3",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket: "tenant-a",
    rootPrefix: "context/",
    accessKeyId: "AKIAEXAMPLEEXAMPLEAA",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEAA",
    forcePathStyle: true,
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    status: "active",
  });
  controlPlane.addWorkspace("ws_b", "alphabet", {
    provider: "s3",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket: "tenant-ab",
    accessKeyId: "AKIAEXAMPLEEXAMPLEBB",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEBB",
    forcePathStyle: true,
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    status: "active",
  });

  // Two Dropbox tenants. No endpoint, no region, no bucket, no key pair — the
  // binding is a short-lived access token and the folder the customer picked,
  // and both of them picked the same folder name.
  controlPlane.addWorkspace("ws_c", "gamma", {
    provider: "dropbox",
    accessToken: DROPBOX_TOKEN_C,
    rootPrefix: "context/",
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    status: "active",
  });
  controlPlane.addWorkspace("ws_d", "delta", {
    provider: "dropbox",
    accessToken: DROPBOX_TOKEN_D,
    rootPrefix: "context/",
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    status: "active",
  });

  await controlPlane.addGrant({
    accessToken: TOKEN_A,
    refreshToken: REFRESH_A,
    workspaceId: "ws_a",
    role: "owner",
    scopes: ["context:read", "context:write"],
    clientId: "mcp_client_alpha",
    userId: "user_a",
  });
  await controlPlane.addGrant({
    accessToken: TOKEN_B,
    workspaceId: "ws_b",
    role: "owner",
    scopes: ["context:read", "context:write"],
    clientId: "mcp_client_beta",
    userId: "user_b",
  });
  const grantAReadonly = await controlPlane.addGrant({
    accessToken: TOKEN_A_READONLY,
    workspaceId: "ws_a",
    role: "owner",
    scopes: ["context:read"],
    clientId: "mcp_client_alpha_readonly",
    userId: "user_a",
  });
  await controlPlane.addGrant({
    accessToken: TOKEN_A_SIBLING,
    workspaceId: "ws_a",
    role: "owner",
    scopes: ["context:read", "context:write"],
    clientId: "mcp_client_alpha_sibling",
    userId: "user_a",
  });

  await controlPlane.addGrant({
    accessToken: TOKEN_C,
    workspaceId: "ws_c",
    role: "owner",
    scopes: ["context:read", "context:write"],
    clientId: "mcp_client_gamma",
    userId: "user_c",
  });
  await controlPlane.addGrant({
    accessToken: TOKEN_D,
    workspaceId: "ws_d",
    role: "owner",
    scopes: ["context:read", "context:write"],
    clientId: "mcp_client_delta",
    userId: "user_d",
  });

  // The sibling connected through the real flow in production; here its client
  // row is placed directly so it can authenticate at the revocation endpoint.
  for (const clientId of [
    "mcp_client_alpha",
    "mcp_client_alpha_sibling",
    "mcp_client_alpha_readonly",
  ]) {
    controlPlane.clients.set(clientId, {
      clientId,
      clientName: clientId,
      redirectUris: ["https://client.test/callback"],
      hashedClientSecret: null,
      tokenEndpointAuthMethod: "none",
    });
  }

  // Seed both buckets directly, honouring A's rootPrefix.
  const bucketA = s3.bucketFor("tenant-a");
  const bucketB = s3.bucketFor("tenant-ab");
  bucketA.set("context/privacy.md", { body: PRIVACY_MANIFEST, etag: "a0" });
  bucketA.set("context/1-projects/alpha.md", { body: "alpha's project", etag: "a1" });
  bucketA.set("context/index.md", { body: "# alpha index", etag: "a2" });
  bucketB.set("privacy.md", { body: PRIVACY_MANIFEST, etag: "b0" });
  bucketB.set("1-projects/beta-secret.md", { body: "BETA-ONLY-MARKER", etag: "b1" });
  bucketB.set("1-projects/alpha.md", { body: "beta's own file, same name", etag: "b2" });

  // Both Dropbox folders hold the same three paths, so nothing about a key can
  // tell them apart. Note `1-projects/alpha.md` exists in all four tenants now.
  const folderC = dropbox.accountFor(DROPBOX_TOKEN_C);
  const folderD = dropbox.accountFor(DROPBOX_TOKEN_D);
  folderC.set("/context/privacy.md", { body: PRIVACY_MANIFEST, rev: "c0" });
  folderC.set("/context/1-projects/alpha.md", { body: "gamma's own file", rev: "c1" });
  folderC.set("/context/1-projects/gamma-secret.md", { body: "GAMMA-ONLY-MARKER", rev: "c2" });
  folderD.set("/context/privacy.md", { body: PRIVACY_MANIFEST, rev: "d0" });
  folderD.set("/context/1-projects/alpha.md", { body: "delta's own file", rev: "d1" });
  folderD.set("/context/1-projects/delta-secret.md", { body: "DELTA-ONLY-MARKER", rev: "d2" });

  const env = {
    CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
    GATEWAY_SECRET,
    NATIVE_BINDINGS: "ALLOWED_BUCKET",
    ALLOWED_BUCKET: memoryR2(),
    // Present on env and deliberately NOT in NATIVE_BINDINGS. A control plane
    // that names it must not be able to reach it.
    LOCAL_CONTEXT_BUCKET: memoryR2({ "secret.md": "CRON-ONLY-MARKER" }),
  };

  return {
    s3,
    dropbox,
    controlPlane,
    env,
    bucketA,
    bucketB,
    folderC,
    folderD,
    grantAReadonly,
    restoreAll() {
      restoreControlPlane();
      restoreDropbox();
      restoreS3();
      restoreFetch();
    },
  };
}
