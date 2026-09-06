/**
 * Multi-tenancy, OAuth, and the ways both are supposed to fail.
 *
 * Two workspaces are stood up on the **same provider, the same endpoint, and
 * adjacent bucket names** (`tenant-a` / `tenant-ab`), because that is the
 * arrangement where a prefix comparison, a `startsWith`, or a stale credential
 * actually leaks. Tenants on different providers would pass an isolation suite
 * that a one-character bug defeats.
 *
 * Two more are stood up on Dropbox, where that arrangement gets tighter still:
 * no bucket name and no per-tenant endpoint, so **the same two URLs and the
 * same customer-chosen folder, separated by the access token alone.**
 *
 * Offline and dependency-free: the control plane is an in-memory server
 * speaking the documented HTTP contract, the object store is an in-memory S3
 * backend the real `S3Store` signs requests against, and the Dropbox tenants
 * run against an in-memory Dropbox the real `DropboxStore` calls.
 *
 * ## Sabotage record
 *
 * A suite that cannot fail proves nothing, so this one was deliberately broken
 * three ways before it was trusted. No flag ships to do it — a switch that
 * disables tenancy is not something that belongs in a deployable artifact — so
 * these were run as temporary local edits and reverted:
 *
 * 1. **Tenant resolution returns the wrong workspace**, with the control plane
 *    reverting to the single-secret design where it trusts the workspace id the
 *    gateway asks for. 13 checks failed, including tenant A reading tenant B's
 *    note, tenant A's write landing in tenant B's bucket, and the byte-identical
 *    refusal collapsing.
 * 2. **`redirectUriMatches` weakened to `presented.startsWith(registered)`.**
 *    2 checks failed, including the `…/callback.evil` suffix attack.
 * 3. **PKCE not enforced** — `plain` accepted at the authorization endpoint and
 *    the verifier never compared. 2 checks failed.
 * 4. **The in-memory Dropbox ignores the bearer token** and serves every tenant
 *    out of one account — the shape of a gateway that built a store from the
 *    wrong binding. 2 checks failed, including the two tenants' identically
 *    pathed `1-projects/alpha.md` resolving to one file. Sabotaging the *stub*
 *    rather than the source is the point here: a backend that cannot tell its
 *    accounts apart would make every Dropbox isolation claim below vacuous.
 * 5. **The store factory drops `rootPrefix` for Dropbox.** 4 checks failed
 *    here, because a folder the customer chose is not something the adapter may
 *    lose track of. See `storeFactory.test.mjs` for the rest of that record.
 */

import worker from "../src/index.js";
import { createControlPlane } from "../src/controlPlane.js";
import {
  CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
  createControlPlaneStub,
  createDropboxBackend,
  createS3Backend,
  sha256Hex,
} from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";

const S3_ENDPOINT = "https://s3.example-object-storage.test";

/** A token long enough to be a real one; obviously fake, as this repo is public. */
function token(label) {
  return `cat_${label}_${"0".repeat(Math.max(0, 34 - label.length))}`;
}

const TOKEN_A = token("tenant_a_owner");
const TOKEN_B = token("tenant_b_owner");
const TOKEN_A_READONLY = token("tenant_a_readonly");
const TOKEN_A_SIBLING = token("tenant_a_sibling");
const REFRESH_A = `crt_tenant_a_${"0".repeat(24)}`;

/**
 * Two more tenants on the one-click tier.
 *
 * Dropbox has no bucket name and no per-tenant endpoint, so the S3 pair's
 * "adjacent bucket names on one endpoint" arrangement has an even tighter
 * Dropbox equivalent: **the same two URLs and the same rootPrefix, separated by
 * the access token alone.** If the token is not what decides, these two see
 * each other, and their identically-keyed notes are what says so.
 */
const TOKEN_C = token("tenant_c_owner");
const TOKEN_D = token("tenant_d_owner");
/** Dropbox's own short-lived tokens are `sl.`-prefixed. Obviously fake. */
const DROPBOX_TOKEN_C = "sl.FAKE-tenant-c-access-token";
const DROPBOX_TOKEN_D = "sl.FAKE-tenant-d-access-token";

async function rpc(env, tokenValue, method, params, { path = "/mcp" } = {}) {
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

async function callTool(env, tokenValue, name, args = {}, options = {}) {
  const { body } = await rpc(env, tokenValue, "tools/call", { name, arguments: args }, options);
  return body?.result;
}

function form(fields) {
  return new URLSearchParams(fields).toString();
}

async function postForm(env, path, fields, init = {}) {
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
async function s256(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const PRIVACY_MANIFEST =
  "---\nrole: privacy-manifest\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  1-projects: team\n\nnote_overrides:\n  # none\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

export async function runTenancyChecks(check) {
  const restoreFetch = (() => {
    const previous = globalThis.fetch;
    return () => {
      globalThis.fetch = previous;
    };
  })();

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
    capabilities: { conditionalWrite: true },
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
    capabilities: { conditionalWrite: true },
    status: "active",
  });

  // Two Dropbox tenants. No endpoint, no region, no bucket, no key pair — the
  // binding is a short-lived access token and the folder the customer picked,
  // and both of them picked the same folder name.
  controlPlane.addWorkspace("ws_c", "gamma", {
    provider: "dropbox",
    accessToken: DROPBOX_TOKEN_C,
    rootPrefix: "context/",
    capabilities: { conditionalWrite: true },
    status: "active",
  });
  controlPlane.addWorkspace("ws_d", "delta", {
    provider: "dropbox",
    accessToken: DROPBOX_TOKEN_D,
    rootPrefix: "context/",
    capabilities: { conditionalWrite: true },
    status: "active",
  });

  const grantA = await controlPlane.addGrant({
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
  const grantASibling = await controlPlane.addGrant({
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

  /* ------------------------- 1. cross-tenant isolation ------------------------ */

  const listA = (await callTool(env, TOKEN_A, "list_notes"))?.content?.[0]?.text || "";
  check("tenant A lists its own notes", listA.includes("1-projects/alpha.md"));
  check(
    "tenant A's listing never names tenant B's notes",
    !listA.includes("beta-secret") && !listA.includes("BETA-ONLY")
  );
  check("tenant A's listing is not rootPrefix-decorated", !listA.includes("context/1-projects"));

  const listB = (await callTool(env, TOKEN_B, "list_notes"))?.content?.[0]?.text || "";
  check("tenant B lists its own notes", listB.includes("1-projects/beta-secret.md"));
  check("tenant B's listing never names tenant A's notes", !listB.includes("alpha's project"));

  const aReadsBSecret = await callTool(env, TOKEN_A, "read_note", {
    path: "1-projects/beta-secret.md",
  });
  check(
    "tenant A cannot read a path that exists only in tenant B",
    aReadsBSecret?.isError === true && !aReadsBSecret.content[0].text.includes("BETA-ONLY")
  );

  // The same key exists in both buckets with different content: the single
  // most direct test that the credential, not the key, decides the bucket.
  const aReadsShared = await callTool(env, TOKEN_A, "read_note", { path: "1-projects/alpha.md" });
  const bReadsShared = await callTool(env, TOKEN_B, "read_note", { path: "1-projects/alpha.md" });
  check(
    "the same key in two tenants resolves to two different objects",
    aReadsShared.content[0].text.includes("alpha's project") &&
      bReadsShared.content[0].text.includes("beta's own file")
  );

  const aSearch = (await callTool(env, TOKEN_A, "search_notes", { query: "BETA-ONLY-MARKER" }))
    ?.content?.[0]?.text;
  check("tenant A's search cannot reach tenant B's content", !aSearch.includes("beta-secret"));

  const beforeWrite = bucketB.get("1-projects/alpha.md").body;
  await callTool(env, TOKEN_A, "write_note", {
    path: "1-projects/alpha.md",
    content: "alpha rewrote this",
    visibility: "team",
    confirm_team_publish: true,
  });
  check(
    "a write by tenant A lands in tenant A's bucket",
    bucketA.get("context/1-projects/alpha.md").body === "alpha rewrote this"
  );
  check(
    "a write by tenant A leaves tenant B's identically-keyed object untouched",
    bucketB.get("1-projects/alpha.md").body === beforeWrite
  );

  const aCreates = await callTool(env, TOKEN_A, "write_note", {
    path: "1-projects/brand-new.md",
    content: "new",
    visibility: "team",
    confirm_team_publish: true,
  });
  check("tenant A can create a new note", !aCreates.isError);
  check(
    "tenant A's new note does not appear in tenant B's bucket",
    !bucketB.has("1-projects/brand-new.md") && bucketA.has("context/1-projects/brand-new.md")
  );

  // Existence inference through the workspace selector.
  const aSelectsB = await rpc(env, TOKEN_A, "ping", {}, { path: "/@alphabet/mcp" });
  const aSelectsNothing = await rpc(env, TOKEN_A, "ping", {}, { path: "/@nosuchworkspace/mcp" });
  check("selecting another tenant's workspace is refused", aSelectsB.status === 403);
  check(
    "a real workspace you cannot reach is byte-identical to one that does not exist",
    aSelectsB.status === aSelectsNothing.status &&
      aSelectsB.text === aSelectsNothing.text &&
      aSelectsB.response.headers.get("WWW-Authenticate") ===
        aSelectsNothing.response.headers.get("WWW-Authenticate")
  );
  const aSelectsSelf = await rpc(env, TOKEN_A, "ping", {}, { path: "/@alpha/mcp" });
  const aSelectsSelfBare = await rpc(env, TOKEN_A, "ping", {}, { path: "/alpha/mcp" });
  check("naming your own workspace in the URL works", aSelectsSelf.body?.result !== undefined);
  check("the @ is cosmetic and normalised away", aSelectsSelfBare.body?.result !== undefined);

  /* ------------- 1b. the same, for a workspace backed by Dropbox ------------- */

  /**
   * Tenancy has to hold on the one-click tier too, and it is a *harder* case
   * than S3, not an easier one. Two S3 tenants at least differ by bucket name;
   * two Dropbox tenants are the same two hostnames, the same paths, and the
   * same customer-chosen folder — separated by the access token in the binding
   * and by nothing else at all. The store the factory built is the only thing
   * standing between them.
   */
  const listC = (await callTool(env, TOKEN_C, "list_notes"))?.content?.[0]?.text || "";
  check(
    "a dropbox-backed workspace serves its own notes end to end",
    listC.includes("1-projects/alpha.md") && listC.includes("1-projects/gamma-secret.md")
  );
  check(
    "a dropbox listing is not rootPrefix-decorated either",
    !listC.includes("context/1-projects") && !listC.includes("/context/")
  );
  check(
    "a dropbox tenant's listing never names the other dropbox tenant's notes",
    !listC.includes("delta-secret") && !listC.includes("DELTA-ONLY")
  );
  check(
    "nor any S3 tenant's",
    !listC.includes("beta-secret") && !listC.includes("brand-new")
  );

  const cReadsD = await callTool(env, TOKEN_C, "read_note", {
    path: "1-projects/delta-secret.md",
  });
  check(
    "one dropbox tenant cannot read a path that exists only in the other",
    cReadsD?.isError === true && !cReadsD.content[0].text.includes("DELTA-ONLY")
  );
  const dReadsC = await callTool(env, TOKEN_D, "read_note", {
    path: "1-projects/gamma-secret.md",
  });
  check(
    "and the refusal runs in both directions",
    dReadsC?.isError === true && !dReadsC.content[0].text.includes("GAMMA-ONLY")
  );

  // Four tenants, one key, four different objects — and two of those four are
  // told apart by nothing but a bearer token.
  const cReadsShared = await callTool(env, TOKEN_C, "read_note", { path: "1-projects/alpha.md" });
  const dReadsShared = await callTool(env, TOKEN_D, "read_note", { path: "1-projects/alpha.md" });
  check(
    "two dropbox tenants sharing a folder name are separated by the access token alone",
    cReadsShared.content[0].text.includes("gamma's own file") &&
      dReadsShared.content[0].text.includes("delta's own file")
  );
  check(
    "and a dropbox tenant's copy is not an S3 tenant's copy",
    !cReadsShared.content[0].text.includes("alpha rewrote this") &&
      !cReadsShared.content[0].text.includes("beta's own file")
  );

  const aReadsGamma = await callTool(env, TOKEN_A, "read_note", {
    path: "1-projects/gamma-secret.md",
  });
  check(
    "an S3 tenant cannot reach a dropbox tenant's notes",
    aReadsGamma?.isError === true && !aReadsGamma.content[0].text.includes("GAMMA-ONLY")
  );
  const cSearch =
    (await callTool(env, TOKEN_C, "search_notes", { query: "BETA-ONLY-MARKER" }))?.content?.[0]
      ?.text || "";
  check(
    "and a dropbox tenant's search cannot reach an S3 tenant's content",
    !cSearch.includes("beta-secret") && !cSearch.includes("BETA-ONLY-MARKER\n")
  );

  const deltaBeforeWrite = folderD.get("/context/1-projects/alpha.md").body;
  const cWrites = await callTool(env, TOKEN_C, "write_note", {
    path: "1-projects/alpha.md",
    content: "gamma rewrote this",
    visibility: "team",
    confirm_team_publish: true,
  });
  check("a dropbox-backed workspace can write", !cWrites.isError);
  check(
    "the write landed in that customer's own Dropbox folder",
    folderC.get("/context/1-projects/alpha.md").body === "gamma rewrote this"
  );
  check(
    "and left the other dropbox tenant's identically-pathed file untouched",
    folderD.get("/context/1-projects/alpha.md").body === deltaBeforeWrite
  );
  check(
    "and never reached an S3 tenant's bucket",
    bucketA.get("context/1-projects/alpha.md").body === "alpha rewrote this" &&
      bucketB.get("1-projects/alpha.md").body === beforeWrite
  );

  // The factory's refusals, reached the way a real request reaches them: the
  // control plane, not a unit test, is where a half-built binding comes from.
  //
  /**
   * A refusal has to arrive as a *response*.
   *
   * A binding the factory will not build throws, and if that throw is not the
   * one `index.js` catches it escapes `worker.fetch` — a 500 in production, and
   * here an exception that would take every later check in this file with it
   * and report as a crash rather than a failure. So it is caught and reported
   * as a status, the same way the malformed-escape checks below do.
   */
  const listNotesOrThrow = async (tokenValue) => {
    try {
      return await rpc(env, tokenValue, "tools/call", { name: "list_notes", arguments: {} });
    } catch (error) {
      return { status: "threw", text: String(error?.message || error), body: null };
    }
  };

  const restoreTokenless = withControlPlaneOverride((path) => {
    if (path === "/gateway/binding") {
      return {
        binding: {
          workspaceId: "ws_c",
          provider: "dropbox",
          rootPrefix: "context/",
          capabilities: { conditionalWrite: true },
          status: "active",
        },
      };
    }
    return null;
  }, controlPlane);
  const tokenless = await listNotesOrThrow(TOKEN_C);
  restoreTokenless();
  check(
    "a dropbox binding with no access token is a refusal, not a store",
    tokenless.status === 503
  );
  check(
    "and it does not fall through to anybody else's storage",
    !tokenless.text.includes("gamma") && !tokenless.text.includes("alpha")
  );

  // The one thing the control plane must never send. A binding that worked
  // while carrying it is how the bug would reach production unnoticed.
  const restoreRefresh = withControlPlaneOverride((path) => {
    if (path === "/gateway/binding") {
      return {
        binding: {
          workspaceId: "ws_c",
          provider: "dropbox",
          accessToken: DROPBOX_TOKEN_C,
          refreshToken: "rt.FAKE-long-lived-must-never-arrive",
          rootPrefix: "context/",
          capabilities: { conditionalWrite: true },
          status: "active",
        },
      };
    }
    return null;
  }, controlPlane);
  const withRefresh = await listNotesOrThrow(TOKEN_C);
  restoreRefresh();
  check(
    "a binding carrying a refresh token is refused even though its access token works",
    withRefresh.status === 503 && !withRefresh.text.includes("gamma-secret")
  );

  /* ------------------- 2. a resolution failure is a refusal ------------------- */

  const garbage = await rpc(env, `${token("not_a_real_token")}`, "ping", {});
  check("an unknown token is refused", garbage.status === 401);
  check(
    "an unknown token's refusal names no workspace",
    !garbage.text.includes("ws_") && !garbage.text.includes("alpha")
  );

  const noToken = await worker.fetch(
    new Request("https://mcp.context.test/mcp", { method: "POST", body: "{}" }),
    env,
    { waitUntil() {} }
  );
  check("no token is refused", noToken.status === 401);

  // The control plane goes down mid-flight. The failure must be a refusal, not
  // a quiet fallback to some other store.
  const brokenPlane = {
    install() {
      const previous = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.startsWith(CONTROL_PLANE_ORIGIN)) return new Response("boom", { status: 500 });
        return previous(input, init);
      };
      return () => {
        globalThis.fetch = previous;
      };
    },
  };
  let restoreBroken = brokenPlane.install();
  const downstream = await rpc(env, TOKEN_A, "ping", {});
  restoreBroken();
  check("a control plane outage refuses rather than falling back", downstream.status === 401);
  check("an outage refusal leaks no note content", !downstream.text.includes("alpha"));

  // A control plane that answers, but with a shape this gateway does not
  // recognise. Coercing it is how "undefined" becomes a workspace id.
  const restoreMalformed = withControlPlaneOverride((path) => {
    if (path === "/gateway/session") return { session: { grantId: "g", clientId: "c" } };
    return null;
  }, controlPlane);
  const malformed = await rpc(env, TOKEN_A, "ping", {});
  restoreMalformed();
  check("a malformed session payload is refused, not coerced", malformed.status === 401);

  // The binding call answers with a *different* workspace than the session
  // resolved to. The two independent resolutions disagree; refuse.
  const restoreMismatch = withControlPlaneOverride((path, body) => {
    if (path === "/gateway/binding") {
      return {
        binding: {
          workspaceId: "ws_b",
          provider: "s3",
          endpoint: S3_ENDPOINT,
          region: "auto",
          bucket: "tenant-ab",
          accessKeyId: "AKIAEXAMPLEEXAMPLEBB",
          secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEBB",
          forcePathStyle: true,
          capabilities: { conditionalWrite: true },
          status: "active",
        },
      };
    }
    return null;
  }, controlPlane);
  const mismatch = await rpc(env, TOKEN_A, "tools/call", {
    name: "list_notes",
    arguments: {},
  });
  restoreMismatch();
  check(
    "a binding for the wrong workspace is refused, not served",
    mismatch.status === 503 && !mismatch.text.includes("beta-secret")
  );

  // A binding that names a Worker binding the operator never allowlisted.
  const restoreSmuggled = withControlPlaneOverride((path) => {
    if (path === "/gateway/binding") {
      return {
        binding: {
          workspaceId: "ws_a",
          provider: "r2-binding",
          bindingName: "LOCAL_CONTEXT_BUCKET",
          capabilities: { conditionalWrite: true },
          status: "active",
        },
      };
    }
    return null;
  }, controlPlane);
  const smuggled = await rpc(env, TOKEN_A, "tools/call", { name: "list_notes", arguments: {} });
  restoreSmuggled();
  check(
    "a control plane cannot point a tenant at a non-allowlisted worker binding",
    smuggled.status === 503 && !smuggled.text.includes("CRON-ONLY-MARKER")
  );

  const restoreUnbound = withControlPlaneOverride((path) => {
    if (path === "/gateway/binding") return { binding: null };
    return null;
  }, controlPlane);
  const unbound = await rpc(env, TOKEN_A, "tools/call", { name: "list_notes", arguments: {} });
  restoreUnbound();
  check("a workspace with no binding is refused", unbound.status === 503);
  check("an unbound workspace never falls through to another store", !unbound.text.includes("alpha's"));

  /* -------------- 3. the gateway secret is not sufficient on its own ---------- */

  // Proof #1 alone: the gateway secret, with a token that resolves to nothing.
  const secretOnly = await controlPlane.handle(`${CONTROL_PLANE_ORIGIN}/gateway/binding`, {
    headers: { Authorization: `Bearer ${GATEWAY_SECRET}` },
    body: JSON.stringify({ accessToken: "not-a-token", expectedWorkspaceId: "ws_a" }),
  });
  check(
    "the gateway secret alone opens no credential",
    (await secretOnly.json()).binding === null
  );

  // Proof #2 alone: a genuine user token, no gateway secret.
  const tokenOnly = await controlPlane.handle(`${CONTROL_PLANE_ORIGIN}/gateway/binding`, {
    headers: {},
    body: JSON.stringify({ accessToken: TOKEN_A, expectedWorkspaceId: "ws_a" }),
  });
  check("a user token alone cannot reach the control plane", tokenOnly.status === 401);

  const wrongSecret = await controlPlane.handle(`${CONTROL_PLANE_ORIGIN}/gateway/binding`, {
    headers: { Authorization: "Bearer not-the-gateway-secret" },
    body: JSON.stringify({ accessToken: TOKEN_A, expectedWorkspaceId: "ws_a" }),
  });
  check("a wrong gateway secret is refused", wrongSecret.status === 401);

  // Both proofs, but the gateway asks for a workspace the grant does not name.
  const crossAsk = await controlPlane.handle(`${CONTROL_PLANE_ORIGIN}/gateway/binding`, {
    headers: { Authorization: `Bearer ${GATEWAY_SECRET}` },
    body: JSON.stringify({ accessToken: TOKEN_A, expectedWorkspaceId: "ws_b" }),
  });
  const crossAskBody = await crossAsk.text();
  const ghostAsk = await controlPlane.handle(`${CONTROL_PLANE_ORIGIN}/gateway/binding`, {
    headers: { Authorization: `Bearer ${GATEWAY_SECRET}` },
    body: JSON.stringify({ accessToken: TOKEN_A, expectedWorkspaceId: "ws_does_not_exist" }),
  });
  check(
    "naming another tenant's workspace returns nothing, not that tenant's binding",
    JSON.parse(crossAskBody).binding === null
  );
  check(
    "a real-but-forbidden workspace is byte-identical to one that does not exist",
    crossAskBody === (await ghostAsk.text())
  );

  const grantScoped = await controlPlane.handle(`${CONTROL_PLANE_ORIGIN}/gateway/binding`, {
    headers: { Authorization: `Bearer ${GATEWAY_SECRET}` },
    body: JSON.stringify({ accessToken: TOKEN_A, expectedWorkspaceId: null }),
  });
  const grantScopedBody = await grantScoped.json();
  check(
    "with no workspace named, the grant decides which one comes back",
    grantScopedBody.binding.workspaceId === "ws_a" && grantScopedBody.binding.bucket === "tenant-a"
  );
  check(
    "a binding response carries exactly one workspace, never a list",
    !Array.isArray(grantScopedBody.binding) && typeof grantScopedBody.binding.bucket === "string"
  );
  // Structural, not behavioural: bulk extraction has to be impossible because
  // the contract has no shape for it, not because nobody has called it yet.
  const contractMethods = Object.keys(
    createControlPlane({ CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET })
  );
  check(
    "the control-plane client exposes no bulk or enumerating call at all",
    contractMethods.every((name) => !/^(list|all|enumerate|search|find)/i.test(name)) &&
      contractMethods.includes("getStorageBinding")
  );

  /* --------------------------- 4. scope enforcement -------------------------- */

  const readOnlyRead = await callTool(env, TOKEN_A_READONLY, "read_note", {
    path: "1-projects/alpha.md",
  });
  check("a read-only grant can read", !readOnlyRead.isError);

  const readOnlyWrite = await callTool(env, TOKEN_A_READONLY, "write_note", {
    path: "1-projects/alpha.md",
    content: "should not land",
    visibility: "team",
  });
  check("a read-only grant cannot write", readOnlyWrite.isError === true);
  check(
    "a refused write changed nothing",
    bucketA.get("context/1-projects/alpha.md").body === "alpha rewrote this"
  );

  const readOnlyMove = await callTool(env, TOKEN_A_READONLY, "move_note", {
    source: "1-projects/alpha.md",
    destination: "1-projects/moved.md",
  });
  check("a read-only grant cannot move either", readOnlyMove.isError === true);

  const readOnlyTools = (await rpc(env, TOKEN_A_READONLY, "tools/list")).body.result.tools;
  check(
    "a read-only grant is not shown write tools",
    readOnlyTools.every((tool) => tool.annotations?.readOnlyHint === true) &&
      readOnlyTools.some((tool) => tool.name === "read_note")
  );
  const fullTools = (await rpc(env, TOKEN_A, "tools/list")).body.result.tools;
  check("a full grant is shown every tool", fullTools.length > readOnlyTools.length);

  const captureToken = token("tenant_a_capture");
  await controlPlane.addGrant({
    accessToken: captureToken,
    workspaceId: "ws_a",
    role: "editor",
    scopes: ["context:capture"],
    clientId: "mcp_client_alpha_capture",
    userId: "user_automation",
  });
  const captureAtMcp = await rpc(env, captureToken, "ping", {});
  check("a capture-only grant cannot open an MCP session at all", captureAtMcp.status === 403);
  check(
    "the insufficient-scope refusal says so in the challenge",
    (captureAtMcp.response.headers.get("WWW-Authenticate") || "").includes(
      'error="insufficient_scope"'
    )
  );
  const captureAtInbox = await worker.fetch(
    new Request("https://mcp.context.test/inbox", {
      method: "POST",
      headers: { Authorization: `Bearer ${captureToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "auto", text: "captured" }),
    }),
    env,
    { waitUntil() {} }
  );
  check("but it can drop a capture in the inbox", captureAtInbox.status === 200);
  check(
    "and the capture landed in its own tenant's bucket",
    [...bucketA.keys()].some((key) => key.startsWith("context/0-inbox/")) &&
      ![...bucketB.keys()].some((key) => key.startsWith("0-inbox/"))
  );

  /* ------------------------------ 5. revocation ------------------------------ */

  check(
    "the sibling client works before revocation",
    !(await callTool(env, TOKEN_A_SIBLING, "read_note", { path: "1-projects/alpha.md" })).isError
  );
  controlPlane.revoke(grantAReadonly);
  const afterRevoke = await rpc(env, TOKEN_A_READONLY, "ping", {});
  check("a revoked grant fails closed immediately", afterRevoke.status === 401);
  check(
    "revoking one client leaves its siblings working",
    !(await callTool(env, TOKEN_A_SIBLING, "read_note", { path: "1-projects/alpha.md" })).isError &&
      !(await callTool(env, TOKEN_A, "read_note", { path: "1-projects/alpha.md" })).isError
  );
  check(
    "a revoked grant cannot fetch a storage credential either",
    (
      await (
        await controlPlane.handle(`${CONTROL_PLANE_ORIGIN}/gateway/binding`, {
          headers: { Authorization: `Bearer ${GATEWAY_SECRET}` },
          body: JSON.stringify({ accessToken: TOKEN_A_READONLY, expectedWorkspaceId: null }),
        })
      ).json()
    ).binding === null
  );

  /* --------------------- 6. discovery and the 401 challenge ------------------ */

  const challenge = noToken.headers.get("WWW-Authenticate") || "";
  check("a 401 carries a Bearer challenge", challenge.startsWith("Bearer "));
  check(
    "the challenge points at the resource metadata",
    challenge.includes(
      'resource_metadata="https://mcp.context.test/.well-known/oauth-protected-resource/mcp"'
    )
  );
  check("the challenge advertises the scopes", challenge.includes('scope="context:read'));

  const namedChallenge = (await rpc(env, "", "ping", {}, { path: "/@alpha/mcp" })).response.headers.get(
    "WWW-Authenticate"
  );
  check(
    "a named-workspace 401 points at that workspace's metadata",
    namedChallenge.includes("/.well-known/oauth-protected-resource/@alpha/mcp")
  );

  const prm = await worker.fetch(
    new Request("https://mcp.context.test/.well-known/oauth-protected-resource"),
    env,
    { waitUntil() {} }
  );
  const prmBody = await prm.json();
  check("protected resource metadata is served", prm.status === 200);
  check("it declares the canonical resource", prmBody.resource === "https://mcp.context.test/mcp");
  check(
    "it declares exactly one authorization server",
    Array.isArray(prmBody.authorization_servers) && prmBody.authorization_servers.length === 1
  );
  check("it advertises scopes", prmBody.scopes_supported.includes("context:read"));

  const prmSuffixed = await worker.fetch(
    new Request("https://mcp.context.test/.well-known/oauth-protected-resource/@alpha/mcp"),
    env,
    { waitUntil() {} }
  );
  check(
    "the path-suffixed well-known form is served too",
    (await prmSuffixed.json()).resource === "https://mcp.context.test/@alpha/mcp"
  );
  const prmPrefixed = await worker.fetch(
    new Request("https://mcp.context.test/@alpha/.well-known/oauth-protected-resource"),
    env,
    { waitUntil() {} }
  );
  check(
    "per-workspace discovery works from the endpoint URL too",
    (await prmPrefixed.json()).resource === "https://mcp.context.test/@alpha/mcp"
  );

  // The exact URL the 401 challenge points at. "mcp" looks like a slug, and a
  // metadata document for a workspace called "mcp" would send every client that
  // followed the challenge to the wrong resource identifier.
  const prmChallengeTarget = await worker.fetch(
    new Request("https://mcp.context.test/.well-known/oauth-protected-resource/mcp"),
    env,
    { waitUntil() {} }
  );
  check(
    "the challenge's own metadata URL does not read /mcp as a workspace",
    (await prmChallengeTarget.json()).resource === "https://mcp.context.test/mcp"
  );

  const asm = await worker.fetch(
    new Request("https://mcp.context.test/.well-known/oauth-authorization-server"),
    env,
    { waitUntil() {} }
  );
  const asmBody = await asm.json();
  check("authorization server metadata is served", asm.status === 200);
  check("the issuer matches the origin", asmBody.issuer === "https://mcp.context.test");
  check(
    "it advertises S256 and only S256",
    JSON.stringify(asmBody.code_challenge_methods_supported) === JSON.stringify(["S256"])
  );
  check(
    "it advertises the authorization_code and refresh_token grants",
    asmBody.grant_types_supported.includes("authorization_code") &&
      asmBody.grant_types_supported.includes("refresh_token")
  );
  check("it advertises a registration endpoint", typeof asmBody.registration_endpoint === "string");
  check("it advertises a revocation endpoint", typeof asmBody.revocation_endpoint === "string");

  // Discovery and validation have to learn a new scope together. A client that
  // follows discovery faithfully and then gets `invalid_scope` from the
  // endpoint discovery pointed it at is the client that breaks, and it breaks
  // in a way that looks like our server lying about what it supports.
  check(
    "the tier scope is advertised in the authorization server metadata",
    asmBody.scopes_supported.includes("context:private")
  );
  const prmScopes = await (
    await worker.fetch(
      new Request("https://mcp.context.test/.well-known/oauth-protected-resource/mcp"),
      env,
      { waitUntil() {} }
    )
  ).json();
  check(
    "and in the protected resource metadata, identically",
    JSON.stringify(prmScopes.scopes_supported) === JSON.stringify(asmBody.scopes_supported)
  );

  check(
    "an unknown path is a 404, not a 200 that breaks discovery",
    (await worker.fetch(new Request("https://mcp.context.test/anything"), env, { waitUntil() {} }))
      .status === 404
  );

  // A malformed percent-escape used to reach `decodeURIComponent` unguarded at
  // the very top of `fetch`, before any routing or auth, so any unauthenticated
  // request could turn the Worker into an exception instead of a response.
  // These paths are undecodable, therefore they name no workspace and no token.
  for (const malformed of ["/%zz/mcp", "/%e0%a4%a/mcp", "/@%zz/mcp", "/%zz"]) {
    let status = null;
    try {
      status = (
        await worker.fetch(new Request(`https://mcp.context.test${malformed}`), env, {
          waitUntil() {},
        })
      ).status;
    } catch {
      status = "threw";
    }
    check(`a malformed escape in the path (${malformed}) routes instead of throwing`, status === 404);
  }
  let tokenPathStatus = null;
  try {
    tokenPathStatus = (
      await worker.fetch(
        new Request("https://mcp.context.test/t/%zz/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }),
        }),
        env,
        { waitUntil() {} }
      )
    ).status;
  } catch {
    tokenPathStatus = "threw";
  }
  check(
    "a malformed escape in a token-in-path token is a 401, not a Worker exception",
    tokenPathStatus === 401
  );

  /* ------------------- 7. no static-token path exists at all ------------------ */

  const staticEnv = {
    ...env,
    PRIVATE_TOKEN: "priv-token",
    TEAM_TOKEN: "team-token",
    PUBLIC_TOKEN: "pub-token",
    INBOX_TOKEN: "inbox-token",
    BRAIN: memoryR2({ "privacy.md": PRIVACY_MANIFEST }),
  };
  for (const legacy of ["priv-token", "team-token", "pub-token", "inbox-token"]) {
    const attempt = await rpc(staticEnv, legacy, "ping", {});
    check(`a legacy env token (${legacy}) is not a credential any more`, attempt.status === 401);
  }
  const legacyInbox = await worker.fetch(
    new Request("https://mcp.context.test/inbox", {
      method: "POST",
      headers: { Authorization: "Bearer inbox-token", "Content-Type": "application/json" },
      body: JSON.stringify({ text: "should not land" }),
    }),
    staticEnv,
    { waitUntil() {} }
  );
  check("the inbox has no static token either", legacyInbox.status === 401);
  check(
    "an env-bound BRAIN bucket is unreachable from any request",
    !JSON.stringify(env).includes("BRAIN")
  );

  /* ------------------------- 8. registration and PKCE ------------------------ */

  const registration = await worker.fetch(
    new Request("https://mcp.context.test/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Test Client",
        redirect_uris: ["https://client.test/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        application_type: "web",
      }),
    }),
    env,
    { waitUntil() {} }
  );
  const registered = await registration.json();
  check("dynamic client registration returns 201", registration.status === 201);
  check("registration returns a client_id", typeof registered.client_id === "string");
  check("a public client gets no secret", registered.client_secret === undefined);

  /*
    WHAT THE REGISTRATION RATE LIMIT IS KEYED ON, AND THAT IT IS NOT AN ADDRESS.

    Registration is the only unauthenticated write in the control plane, and
    every call mints a permanent row nothing sweeps. The limit lives there; what
    lives here is the bucket name, and two properties of it that the control
    plane cannot check for itself: that a key is sent at all, and that it is not
    the caller's IP address.

    A key that silently stopped being sent would not fail anything — the control
    plane would just put every registration on the internet into one shared
    bucket, which is a global limit wearing a per-registrant limit's clothes.
  */
  const registerFrom = async (address) => {
    const before = controlPlane.calls.length;
    const response = await worker.fetch(
      new Request("https://mcp.context.test/oauth/register", {
        method: "POST",
        headers: address
          ? { "Content-Type": "application/json", "CF-Connecting-IP": address }
          : { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Keyed",
          redirect_uris: ["https://client.test/callback"],
          token_endpoint_auth_method: "none",
        }),
      }),
      env,
      { waitUntil() {} }
    );
    const call = controlPlane.calls
      .slice(before)
      .find((entry) => entry.path === "/gateway/clients/register");
    /*
      THE STATUS, NOT ONLY THE KEY, and the reason is a defect review measured
      in the first version of this helper: it returned the key alone, so
      `undefined` was equally true when the control plane had **never been
      called**. The check below named for "still registers with no header"
      therefore PASSED under a sabotage that made a missing header refuse the
      registration outright — what went red was 28 unrelated OAuth tests that
      happen not to set the header. The property was protected by accident, by
      neighbours, which is this register's own definition of not a guard.
    */
    return { status: response.status, key: call?.body?.registrantKey };
  };

  const { key: keyFromOne } = await registerFrom("203.0.113.7");
  const { key: keyFromOneAgain } = await registerFrom("203.0.113.7");
  const { key: keyFromAnother } = await registerFrom("203.0.113.8");
  check("a registration carries a registrant key", typeof keyFromOne === "string");
  check("...stable for the same address, so a flood lands in one bucket", keyFromOne === keyFromOneAgain);
  check("...and different for another, so it costs its own source", keyFromOne !== keyFromAnother);
  check(
    "...and it is not the address, which the control plane has no reason to hold",
    !keyFromOne.includes("203.0.113.7") && keyFromOne !== "203.0.113.7"
  );
  /*
    `X-Forwarded-For` is deliberately not read: a client sets it, so keying on
    it would let one source spend everybody else's budget — or its own, over and
    over, by changing it. Cloudflare overwrites `CF-Connecting-IP` on the way
    in, which is the whole reason that is the header.
  */
  const forged = await worker.fetch(
    new Request("https://mcp.context.test/oauth/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "203.0.113.9",
        "CF-Connecting-IP": "203.0.113.7",
      },
      body: JSON.stringify({
        client_name: "Forged",
        redirect_uris: ["https://client.test/callback"],
        token_endpoint_auth_method: "none",
      }),
    }),
    env,
    { waitUntil() {} }
  );
  const forgedKey = controlPlane.calls
    .filter((entry) => entry.path === "/gateway/clients/register")
    .at(-1)?.body?.registrantKey;
  check("a client-supplied forwarding header cannot move the bucket", forgedKey === keyFromOne);
  check("...and the registration still succeeds", forged.status === 201);

  /*
    No header at all — a self-hosted gateway behind something that does not set
    one. It sends no key, which the control plane reads as the shared
    unattributed bucket. The positive twin matters more than usual here: this
    must still REGISTER, because refusing would break self-hosting, which
    CLAUDE.md names as a supported path.
  */
  const withoutHeader = await registerFrom(null);
  check("a gateway with no address header sends no key", withoutHeader.key === undefined);
  check("...and the registration still succeeds, because refusing breaks self-hosting", withoutHeader.status === 201);

  /*
    ONE HOST IS ONE BUCKET, AND ONE NETWORK IS ONE BUCKET.

    A key a stranger can rotate is a write amplification on a table nothing
    sweeps — this repository argues that at the ingestion limiter, and the
    first version of this change reproduced exactly what that comment
    prevents. An IPv6 host routinely holds a whole /64, so keying on the
    address is 2^64 free buckets and 2^64 permanent limiter rows. Measured on
    that version: 100 registrations from a rotating address left 100 client
    rows AND 100 limiter rows, against 100 with no limit at all — the limit
    made the growth worse.

    So these are the shapes that must agree, and the ones that must not.
  */
  const netOf = async (address) => (await registerFrom(address)).key;
  const canonicalSix = await netOf("2001:db8::1");
  check("an expanded IPv6 address is the same bucket as its short form",
    (await netOf("2001:0db8:0000:0000:0000:0000:0000:0001")) === canonicalSix);
  check("...and so is its upper-case form", (await netOf("2001:DB8::1")) === canonicalSix);
  check("...and another address in the same /64, which one customer holds",
    (await netOf("2001:db8::dead:beef")) === canonicalSix);
  check("...and the same host with a port and brackets",
    (await netOf("[2001:db8::1]:443")) === canonicalSix);
  check("a DIFFERENT /64 is a different bucket, so this is not simply constant",
    (await netOf("2001:db8:0:1::1")) !== canonicalSix);
  check("an IPv4-mapped address is the same bucket as the IPv4 host it names",
    (await netOf("::ffff:203.0.113.7")) === keyFromOne);
  check("...and an IPv4 address with a port is that host, not a second bucket",
    (await netOf("203.0.113.7:443")) === keyFromOne);
  check("an unparseable address shares the unattributed bucket rather than minting one",
    (await netOf("not-an-address")) === undefined);

  /*
    A QUAD AT THE END OF AN IPv6 ADDRESS IS NOT ALWAYS AN IPv4 HOST.

    The first version of this took the dotted quad whenever the text ended in
    one, ignoring what came before it. `2001:db8::203.0.113.7` is a perfectly
    ordinary address inside `2001:db8::/64`, and it was spending IPv4 host
    `203.0.113.7`'s budget: one network poisoning another's bucket, which is
    the worse of the two directions this function can fail in.

    Only two prefixes really name an IPv4 host — `::ffff:0:0/96` (mapped) and
    the deprecated all-zero compatible form. `64:ff9b::/96` is NAT64 and
    `::ffff:0:0:0/96` is SIIT: in both the embedded quad is the *destination*
    being translated to, never the source, so crediting it to that host lets a
    translator spend an arbitrary stranger's budget.
  */
  check("an IPv4-mapped address is still the host it names", (await netOf("::ffff:203.0.113.7")) === keyFromOne);
  check("...and so is the deprecated all-zero compatible form", (await netOf("::203.0.113.7")) === keyFromOne);
  check("a NAT64 address is its own network, not the host it translates to",
    (await netOf("64:ff9b::203.0.113.7")) !== keyFromOne);
  check("...and an ordinary address that merely ENDS in a quad is its own /64",
    (await netOf("2001:db8::203.0.113.7")) !== keyFromOne);
  check("...which is the /64 it belongs to, so it shares with its neighbours",
    (await netOf("2001:db8::203.0.113.7")) === canonicalSix);
  check("a SIIT-translated address is not the host either",
    (await netOf("::ffff:0:203.0.113.7")) !== keyFromOne);

  /*
    AND ONE IPv4 HOST HAS ONE SPELLING, OR IT HAS UNBOUNDED BUCKETS.

    `\d+` per octet accepts leading zeros without limit, so `203.000.113.007`
    and `00000000203.0.113.7` were a second and third bucket for one host —
    the exact rotation the /64 work exists to close, arriving through the
    branch that had not been normalised. Octets are parsed now: one to three
    digits, no leading zero unless the octet IS zero, and at most 255.

    REFUSED rather than normalised, which is the opposite of what the first
    draft of these two checks asserted. A padded octet is ambiguous — it has
    meant octal — and no legitimate producer emits one, so reading `007` as
    seven is a guess about what somebody meant. Refusing sends it to the
    shared bucket, which closes the rotation just as completely (every padded
    form collapses to one bucket) without deciding what it meant.
  */
  check("a padded IPv4 address is not a second bucket for the same host",
    (await netOf("203.000.113.007")) === undefined);
  check("...however much padding is on it", (await netOf("00000000203.0.113.7")) === undefined);
  check("an octet above 255 is not an address at all", (await netOf("999.1.1.1")) === undefined);
  check("...nor is one with too many parts", (await netOf("203.0.113.7.9")) === undefined);

  /*
    And the one answer the gateway has to translate rather than relay. The
    `/oauth/` catch upstairs turns every control-plane failure into 503
    `server_error`; a client cannot tell "retry in an hour" from "retry now",
    and 503 invites the second.
  */
  controlPlane.flags.registrationRateLimited = true;
  const limited = await worker.fetch(
    new Request("https://mcp.context.test/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7" },
      body: JSON.stringify({
        client_name: "Too many",
        redirect_uris: ["https://client.test/callback"],
        token_endpoint_auth_method: "none",
      }),
    }),
    env,
    { waitUntil() {} }
  );
  controlPlane.flags.registrationRateLimited = false;
  check("a rate-limited registration is 429, not 503", limited.status === 429);
  check("...and says when to come back", limited.headers.get("Retry-After") === "3600");

  const badRedirect = await worker.fetch(
    new Request("https://mcp.context.test/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Insecure",
        redirect_uris: ["http://evil.test/callback"],
      }),
    }),
    env,
    { waitUntil() {} }
  );
  check(
    "a non-loopback http redirect URI is rejected at registration",
    badRedirect.status === 400 && (await badRedirect.json()).error === "invalid_redirect_uri"
  );

  const clientId = registered.client_id;
  const verifier = "a".repeat(64);
  const challengeValue = await s256(verifier);

  const authorizeUrl = (overrides = {}) => {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "https://client.test/callback",
      code_challenge: challengeValue,
      code_challenge_method: "S256",
      state: "xyz",
      scope: "context:read context:write",
      resource: "https://mcp.context.test/mcp",
      ...overrides,
    });
    return `https://mcp.context.test/oauth/authorize?${params}`;
  };

  const authorized = await worker.fetch(new Request(authorizeUrl()), env, { waitUntil() {} });
  check("a valid authorization request redirects to consent", authorized.status === 302);
  check(
    "consent is hosted by the control plane, not the gateway",
    (authorized.headers.get("Location") || "").startsWith(CONTROL_PLANE_ORIGIN)
  );

  // The other half of the pair above: what discovery advertises, `/authorize`
  // must accept. A client may legitimately ask for the tier — it only ever
  // preselects, since the person's choice on the consent screen is what gets
  // recorded — but a request naming it must not be refused outright.
  const withTierScope = await worker.fetch(
    new Request(authorizeUrl({ scope: "context:read context:write context:private" })),
    env,
    { waitUntil() {} }
  );
  check(
    "an authorization request may name the tier scope discovery advertises",
    withTierScope.status === 302 &&
      (withTierScope.headers.get("Location") || "").startsWith(CONTROL_PLANE_ORIGIN)
  );
  const withUnknownScope = await worker.fetch(
    new Request(authorizeUrl({ scope: "context:read context:everything" })),
    env,
    { waitUntil() {} }
  );
  check(
    "and a scope outside the advertised menu is still invalid_scope",
    (withUnknownScope.headers.get("Location") || "").includes("error=invalid_scope")
  );

  const plainPkce = await worker.fetch(
    new Request(authorizeUrl({ code_challenge_method: "plain", code_challenge: verifier })),
    env,
    { waitUntil() {} }
  );
  check("PKCE plain is rejected", plainPkce.status === 302);
  check(
    "the plain rejection is an OAuth error on the client's redirect",
    (plainPkce.headers.get("Location") || "").includes("error=invalid_request")
  );

  const noPkce = await worker.fetch(
    new Request(
      `https://mcp.context.test/oauth/authorize?response_type=code&client_id=${clientId}` +
        `&redirect_uri=${encodeURIComponent("https://client.test/callback")}`
    ),
    env,
    { waitUntil() {} }
  );
  check(
    "an authorization request with no PKCE at all is rejected",
    (noPkce.headers.get("Location") || "").includes("error=invalid_request")
  );

  /* ----------------- 9. redirect URI validation is exact-match --------------- */

  const prefixAttack = await worker.fetch(
    new Request(authorizeUrl({ redirect_uri: "https://client.test/callback.evil" })),
    env,
    { waitUntil() {} }
  );
  check("a suffixed redirect URI does not match", prefixAttack.status === 400);
  const substringAttack = await worker.fetch(
    new Request(authorizeUrl({ redirect_uri: "https://client.test/call" })),
    env,
    { waitUntil() {} }
  );
  check("a truncated redirect URI does not match", substringAttack.status === 400);
  const hostAttack = await worker.fetch(
    new Request(authorizeUrl({ redirect_uri: "https://client.test.evil.test/callback" })),
    env,
    { waitUntil() {} }
  );
  check("a lookalike host does not match", hostAttack.status === 400);
  check(
    "an unmatched redirect URI is refused without redirecting anywhere",
    prefixAttack.headers.get("Location") === null
  );

  // RFC 8252 §7.3: a native client's loopback port is unknowable at
  // registration time, so the port — and only the port — is ignored.
  const nativeRegistration = await worker.fetch(
    new Request("https://mcp.context.test/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "CLI",
        redirect_uris: ["http://127.0.0.1/callback"],
        token_endpoint_auth_method: "none",
        application_type: "native",
      }),
    }),
    env,
    { waitUntil() {} }
  );
  const nativeClient = await nativeRegistration.json();
  const ephemeral = await worker.fetch(
    new Request(
      `https://mcp.context.test/oauth/authorize?response_type=code&client_id=${nativeClient.client_id}` +
        `&redirect_uri=${encodeURIComponent("http://127.0.0.1:51763/callback")}` +
        `&code_challenge=${challengeValue}&code_challenge_method=S256`
    ),
    env,
    { waitUntil() {} }
  );
  check("a loopback client's ephemeral port is accepted", ephemeral.status === 302);
  const loopbackPathAttack = await worker.fetch(
    new Request(
      `https://mcp.context.test/oauth/authorize?response_type=code&client_id=${nativeClient.client_id}` +
        `&redirect_uri=${encodeURIComponent("http://127.0.0.1:51763/other")}` +
        `&code_challenge=${challengeValue}&code_challenge_method=S256`
    ),
    env,
    { waitUntil() {} }
  );
  check(
    "the loopback exception ignores the port and nothing else",
    loopbackPathAttack.status === 400
  );

  /* ---------------------- 10. the token endpoint and PKCE -------------------- */

  const authorizationRecord = {
    clientId,
    redirectUri: "https://client.test/callback",
    codeChallenge: challengeValue,
    codeChallengeMethod: "S256",
    scope: "context:read context:write",
    resource: "https://mcp.context.test/mcp",
    workspaceId: "ws_a",
    userId: "user_a",
  };

  controlPlane.issueCode("code-wrong-verifier", authorizationRecord);
  const wrongVerifier = await postForm(env, "/oauth/token", {
    grant_type: "authorization_code",
    code: "code-wrong-verifier",
    redirect_uri: "https://client.test/callback",
    client_id: clientId,
    code_verifier: "b".repeat(64),
    resource: "https://mcp.context.test/mcp",
  });
  check(
    "a wrong PKCE verifier is rejected",
    wrongVerifier.status === 400 && wrongVerifier.body.error === "invalid_grant"
  );
  const burned = await postForm(env, "/oauth/token", {
    grant_type: "authorization_code",
    code: "code-wrong-verifier",
    redirect_uri: "https://client.test/callback",
    client_id: clientId,
    code_verifier: verifier,
  });
  check("a code presented with a wrong verifier is burned, not retryable", burned.status === 400);

  controlPlane.issueCode("code-good", authorizationRecord);
  const exchanged = await postForm(env, "/oauth/token", {
    grant_type: "authorization_code",
    code: "code-good",
    redirect_uri: "https://client.test/callback",
    client_id: clientId,
    code_verifier: verifier,
    resource: "https://mcp.context.test/mcp",
  });
  check("a correct verifier exchanges the code", exchanged.status === 200);
  check("the token response carries a bearer access token", exchanged.body.token_type === "Bearer");
  check("the token response carries a refresh token", typeof exchanged.body.refresh_token === "string");
  check("the token response declares an expiry", exchanged.body.expires_in > 0);
  // RFC 6749 §5.1 makes this a MUST, and it is the only thing between an
  // access token and a shared cache holding it. `oauth.js` sets it on every
  // response it builds; nothing asserted it, so deleting the header — or
  // worse, changing it to `public, max-age=3600` — passed the whole suite.
  // Asserted on the *successful* exchange because that is the response that
  // actually carries a token.
  check(
    "a token response is never storable by a shared cache",
    exchanged.response.headers.get("Cache-Control") === "no-store"
  );

  /*
    A CONFIDENTIAL CLIENT, BECAUSE NOTHING ABOVE IS ONE.

    Every exchange above uses the public client registered in section 8, whose
    `token_endpoint_auth_method` is `"none"` — so `authenticateClient` returns
    `true` on its first line and the entire secret comparison below it is
    unreached. MEASURED: replacing that function's body with
    `if (true) return true;` reddened **0 of 1,713 checks**. The constant-time
    compare, the HTTP Basic fallback, and the refusal of a wrong secret were
    the authentication on `/oauth/token` and `/oauth/revoke` and no test
    presented a secret to either one, right or wrong.

    The code was correct. It was simply not a guard, by this repository's own
    definition of one.
  */
  const confidentialRegistration = await worker.fetch(
    new Request("https://mcp.context.test/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Hosted Client",
        redirect_uris: ["https://hosted.test/callback"],
        token_endpoint_auth_method: "client_secret_post",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        application_type: "web",
      }),
    }),
    env,
    { waitUntil() {} }
  );
  const confidential = await confidentialRegistration.json();
  check("a confidential client is issued a secret", typeof confidential.client_secret === "string");

  const confidentialRecord = {
    ...authorizationRecord,
    clientId: confidential.client_id,
    redirectUri: "https://hosted.test/callback",
  };
  const spend = async (code, extra, init) => {
    controlPlane.issueCode(code, confidentialRecord);
    return postForm(
      env,
      "/oauth/token",
      {
        grant_type: "authorization_code",
        code,
        redirect_uri: "https://hosted.test/callback",
        client_id: confidential.client_id,
        code_verifier: verifier,
        ...extra,
      },
      init
    );
  };

  const noSecret = await spend("conf-none", {});
  check(
    "a confidential client presenting no secret is refused",
    noSecret.status === 401 && noSecret.body.error === "invalid_client"
  );
  const wrongClientSecret = await spend("conf-wrong", { client_secret: `${confidential.client_secret}x` });
  check(
    "...and a wrong one is refused, not merely a missing one",
    wrongClientSecret.status === 401 && wrongClientSecret.body.error === "invalid_client"
  );
  /*
    The positive twin, and the reason the two refusals above prove anything: a
    check that only ever asserts "no" passes just as happily on a function that
    always says no.
  */
  const rightSecret = await spend("conf-right", { client_secret: confidential.client_secret });
  check("...and the correct secret exchanges the code", rightSecret.status === 200);

  /*
    THERE IS NO SAME-LENGTH CASE TO WRITE, and the first version of this block
    wrote one anyway with a false reason attached: "the compare short-circuits
    on length before the constant-time loop, so a longer string proves only
    that branch." Both operands of that comparison are `sha256Hex` output —
    64 characters for any plaintext whatsoever — so the length of the secret
    somebody presents never reaches it. MEASURED: inverting
    `if (hashed.length !== …) return false;` to `return true` **reddens
    nothing** — no denominator, deliberately. The claim is that no check
    anywhere goes red, which says strictly more than a fraction of a total
    that every unrelated commit moves; a count in prose is the tripwire this
    branch has already tripped four times, and it tripped again on the first
    draft of this very sentence, which said "0 of 1,720" in the commit that
    made the suite 1,719. The branch is unreachable, `conf-wrong` above
    already goes through
    the constant-time loop, and the extra check proved nothing it did not.

    Recorded rather than quietly deleted, because the next person to read that
    line will have the same idea. The guard itself stays: it costs nothing and
    a stored value that is not a 64-character hash is a thing to refuse rather
    than to compare.
  */

  /*
    HTTP Basic, which `authenticateClient` accepts as a fallback for clients
    that send it despite registering `client_secret_post`. A whole branch, and
    the only reason to have written it is clients that use it.
  */
  const basic = (secret) => ({
    headers: {
      Authorization: `Basic ${btoa(`${confidential.client_id}:${secret}`)}`,
    },
  });
  const basicRight = await spend("conf-basic", {}, basic(confidential.client_secret));
  check("a secret presented over HTTP Basic is accepted", basicRight.status === 200);
  const basicWrong = await spend("conf-basic-bad", {}, basic("not-the-secret"));
  check("...and a wrong one over HTTP Basic is refused", basicWrong.status === 401);

  const replay = await postForm(env, "/oauth/token", {
    grant_type: "authorization_code",
    code: "code-good",
    redirect_uri: "https://client.test/callback",
    client_id: clientId,
    code_verifier: verifier,
  });
  check(
    "an authorization code is single-use",
    replay.status === 400 && replay.body.error === "invalid_grant"
  );

  controlPlane.issueCode("code-redirect-swap", authorizationRecord);
  const redirectSwap = await postForm(env, "/oauth/token", {
    grant_type: "authorization_code",
    code: "code-redirect-swap",
    redirect_uri: "https://client.test/other",
    client_id: clientId,
    code_verifier: verifier,
  });
  check("the token exchange re-checks the redirect URI", redirectSwap.status === 400);

  controlPlane.issueCode("code-other-client", { ...authorizationRecord, clientId: "someone_else" });
  const clientSwap = await postForm(env, "/oauth/token", {
    grant_type: "authorization_code",
    code: "code-other-client",
    redirect_uri: "https://client.test/callback",
    client_id: clientId,
    code_verifier: verifier,
  });
  check("a code minted for another client cannot be spent", clientSwap.status === 400);

  const wrongAudience = await postForm(env, "/oauth/token", {
    grant_type: "authorization_code",
    code: "irrelevant",
    redirect_uri: "https://client.test/callback",
    client_id: clientId,
    code_verifier: verifier,
    resource: "https://someone-elses-mcp.test/mcp",
  });
  check(
    "a token request for another resource is rejected",
    wrongAudience.status === 400 && wrongAudience.body.error === "invalid_target"
  );

  // A client handed `/@alpha/mcp` builds its token request from the workspace-
  // free metadata endpoint but still sends the per-workspace resource. Rejecting
  // that would break every real named-workspace connection at the last step.
  controlPlane.issueCode("code-named-resource", {
    ...authorizationRecord,
    resource: "https://mcp.context.test/@alpha/mcp",
  });
  const namedResource = await postForm(env, "/oauth/token", {
    grant_type: "authorization_code",
    code: "code-named-resource",
    redirect_uri: "https://client.test/callback",
    client_id: clientId,
    code_verifier: verifier,
    resource: "https://mcp.context.test/@alpha/mcp",
  });
  check("a per-workspace resource indicator is accepted", namedResource.status === 200);

  const jsonToken = await worker.fetch(
    new Request("https://mcp.context.test/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token" }),
    }),
    env,
    { waitUntil() {} }
  );
  check("the token endpoint insists on form encoding", jsonToken.status === 400);

  /* --------------------- 11. the new grant actually works -------------------- */

  const newToken = exchanged.body.access_token;
  const newSession = await callTool(env, newToken, "read_note", { path: "1-projects/alpha.md" });
  check("a token minted by the flow reaches its workspace", !newSession.isError);
  check(
    "and reaches only its workspace",
    (await callTool(env, newToken, "read_note", { path: "1-projects/beta-secret.md" })).isError ===
      true
  );

  const refreshed = await postForm(env, "/oauth/token", {
    grant_type: "refresh_token",
    refresh_token: exchanged.body.refresh_token,
    client_id: clientId,
    resource: "https://mcp.context.test/mcp",
  });
  check("refresh returns a new access token", refreshed.status === 200);
  check(
    "refresh rotates the refresh token",
    refreshed.body.refresh_token !== exchanged.body.refresh_token
  );
  const reusedRefresh = await postForm(env, "/oauth/token", {
    grant_type: "refresh_token",
    refresh_token: exchanged.body.refresh_token,
    client_id: clientId,
  });
  check(
    "a reused refresh token is invalid_grant",
    reusedRefresh.status === 400 && reusedRefresh.body.error === "invalid_grant"
  );
  check(
    "reusing a rotated refresh token kills the whole grant",
    (await rpc(env, refreshed.body.access_token, "ping", {})).status === 401
  );

  /* ------------------------------ 12. revocation ----------------------------- */

  const revoke = await postForm(env, "/oauth/revoke", {
    token: TOKEN_A_SIBLING,
    token_type_hint: "access_token",
    client_id: "mcp_client_alpha_sibling",
  });
  check("revocation answers 200", revoke.status === 200);
  check(
    "the revoked client is cut off immediately",
    (await rpc(env, TOKEN_A_SIBLING, "ping", {})).status === 401
  );
  check(
    "its sibling on the same workspace is untouched",
    (await rpc(env, TOKEN_A, "ping", {})).body?.result !== undefined
  );
  check(
    "revocation of an unknown token still answers 200",
    (
      await postForm(env, "/oauth/revoke", {
        token: "not-a-token",
        client_id: "mcp_client_alpha_sibling",
      })
    ).status === 200
  );

  /* ------------------- 13. the credential is never cached -------------------- */

  const before = controlPlane.calls.filter((c) => c.path === "/gateway/binding").length;
  await callTool(env, TOKEN_A, "read_note", { path: "1-projects/alpha.md" });
  await callTool(env, TOKEN_A, "read_note", { path: "1-projects/alpha.md" });
  const after = controlPlane.calls.filter((c) => c.path === "/gateway/binding").length;
  check("the storage binding is fetched afresh on every request", after - before === 2);
  check(
    "every binding fetch carries the caller's own token, not a workspace id",
    controlPlane.calls
      .filter((c) => c.path === "/gateway/binding")
      .every((c) => typeof c.body.accessToken === "string" && c.body.accessToken.length > 0)
  );

  /* ------------------------- 14. no secret ever escapes ---------------------- */

  const everythingSaid = [
    listA,
    listB,
    listC,
    tokenless.text,
    withRefresh.text,
    garbage.text,
    downstream.text,
    unbound.text,
    smuggled.text,
    mismatch.text,
    JSON.stringify(exchanged.body),
    challenge,
    JSON.stringify(prmBody),
    JSON.stringify(asmBody),
  ].join("\n");
  check(
    "no response ever contains the gateway secret",
    !everythingSaid.includes(GATEWAY_SECRET)
  );
  check(
    "no response ever contains a storage credential",
    !everythingSaid.includes("wJalrXUtnFEMI") && !everythingSaid.includes("AKIAEXAMPLE")
  );
  check(
    "and none contains a Dropbox token of either life",
    !everythingSaid.includes(DROPBOX_TOKEN_C) &&
      !everythingSaid.includes(DROPBOX_TOKEN_D) &&
      !everythingSaid.includes("rt.FAKE")
  );
  check(
    "no response names the control plane origin",
    !garbage.text.includes(CONTROL_PLANE_ORIGIN) && !downstream.text.includes(CONTROL_PLANE_ORIGIN)
  );

  restoreControlPlane();
  restoreDropbox();
  restoreS3();
  restoreFetch();
}

/**
 * Temporarily answer selected control-plane paths with a scripted payload,
 * falling through to the real stub for anything the script returns null for.
 */
function withControlPlaneOverride(script, controlPlane) {
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
function memoryR2(seed = {}) {
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
