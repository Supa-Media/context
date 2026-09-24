/**
 * `scope_info { workspaces: true }`: how a CLI learns which workspaces a
 * sign-in reaches, as data rather than as orientation prose, so an installer
 * can offer them by name and file a capture in the personal one. An argument
 * on an existing tool rather than a new tool, because clients cache the tool
 * list and a new name reaches none of them.
 *
 * A fixture of its own (one person, a personal and a shared workspace, and a
 * third they are not in), in its own file because `crossContext.test.mjs` is
 * past the size allowance and may not grow.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import worker from "../src/index.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub, createS3Backend } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";

const S3_ENDPOINT = "https://s3.example-scope-info.test";
const TOKEN_OWNER = `cat_scope_owner_${"0".repeat(24)}`;
const TOKEN_READ_ONLY = `cat_scope_readonly_${"0".repeat(21)}`;
const PRIVACY_MANIFEST =
  "---\nrole: privacy-manifest\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  1-projects: team\n\nnote_overrides:\n  # none\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";
const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET };

function binding(bucket, key) {
  return {
    provider: "s3",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket,
    accessKeyId: `AKIAEXAMPLEEXAMPLE${key}`,
    secretAccessKey: `wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLE${key}`,
    forcePathStyle: true,
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true, serverSideCopy: "same-store" },
    status: "active",
  };
}

async function scopeInfo(token, args) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "scope_info", arguments: args } }),
    }),
    env,
    ctx
  );
  const body = JSON.parse(await response.text());
  await settle();
  return body?.result?.content?.[0]?.text || "";
}

function workspacesOf(text) {
  const block = /## Workspaces\n+```json\n([\s\S]*?)\n```/.exec(text);
  return block ? JSON.parse(block[1]) : null;
}

let restoreS3;
let restoreControlPlane;
before(async () => {
  const s3 = createS3Backend(S3_ENDPOINT);
  restoreS3 = s3.install();
  const controlPlane = createControlPlaneStub();
  restoreControlPlane = controlPlane.install();
  controlPlane.addWorkspace("ws_mine", "mine", binding("scope-mine", "AA"));
  controlPlane.addWorkspace("ws_team", "team-kind", binding("scope-team", "BB"), { kind: "shared" });
  controlPlane.addWorkspace("ws_stranger", "stranger", binding("scope-stranger", "CC"), { kind: "shared" });
  for (const bucket of ["scope-mine", "scope-team", "scope-stranger"]) {
    s3.bucketFor(bucket).set("privacy.md", { body: PRIVACY_MANIFEST, etag: "p0" });
  }
  const person = { workspaceId: "ws_mine", role: "owner", userId: "user_scope", alsoMemberOf: [{ workspaceId: "ws_team", role: "member" }] };
  await controlPlane.addGrant({ ...person, accessToken: TOKEN_OWNER, scopes: ["context:read", "context:write"], clientId: "mcp_client_scope" });
  await controlPlane.addGrant({ ...person, accessToken: TOKEN_READ_ONLY, scopes: ["context:read"], clientId: "mcp_client_scope_ro" });
});
after(() => {
  restoreControlPlane?.();
  restoreS3?.();
});

test("scope_info lists the workspaces a sign-in reaches, as data", async () => {
  const listed = workspacesOf(await scopeInfo(TOKEN_OWNER, { workspaces: true }));
  const bySlug = Object.fromEntries(listed.map((entry) => [entry.slug, entry]));
  assert.equal(listed.length, 2);
  assert.deepEqual(bySlug.mine, { slug: "mine", role: "owner", kind: "personal", current: true });
  assert.deepEqual(bySlug["team-kind"], { slug: "team-kind", role: "member", kind: "shared", current: false });
});

test("...and names nothing the grant does not cover", async () => {
  assert.ok(!(await scopeInfo(TOKEN_OWNER, { workspaces: true })).includes("stranger"));
});

test("...and a read-only sign-in is told the same list, since it describes itself", async () => {
  const listed = workspacesOf(await scopeInfo(TOKEN_READ_ONLY, { workspaces: true }));
  assert.deepEqual(listed.map((entry) => entry.slug).sort(), ["mine", "team-kind"]);
});

test("...and without the argument the answer carries no list", async () => {
  assert.equal(workspacesOf(await scopeInfo(TOKEN_OWNER, {})), null);
});

test("...and an argument scope_info does not declare is still refused", async () => {
  assert.match(await scopeInfo(TOKEN_OWNER, { workspace_list: true }), /unknown|not allowed|unexpected/i);
});
