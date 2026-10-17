/**
 * Setting a workspace up from an agent: `manage` actions create_workspace,
 * layout and connect_google (Dev2, 2026-10-17;
 * docs/decisions/gateway-protocol/workspace-setup.md).
 *
 * Through the worker, against the stub control plane (which clears as the real
 * route does): the action translates to its tool, the call goes out with the
 * connection's own token and the workspace it was addressed to, and a
 * connection that may not write never reaches the control plane at all.
 *
 * `EGRESS_APPROVALS` is unset here, so the egress gate holds as it does on a
 * self-hosted gateway: the layout and connect calls addressed to another
 * workspace run because the three tools are classified as never widening
 * (`NEVER_WIDENS` in `privacy/egress.js`), not because the gate is off.
 *
 * Sabotage (temporary local edits, reverted; failures measured):
 *   `workspaceSetup.layout` sent with a fixed workspace, not the addressed one  1
 *   `NEVER_WIDENS` emptied (the gate holds them as writes elsewhere)            2
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import worker from "../src/index.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub, createS3Backend } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";

const S3_ENDPOINT = "https://s3.example-workspace-setup.test";
const OWNER = `cat_wssetup_owner_${"0".repeat(22)}`;
const READONLY = `cat_wssetup_ro_${"0".repeat(25)}`;
const MEMBER = `cat_wssetup_member_${"0".repeat(21)}`;
const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET };

function binding(bucket) {
  return {
    provider: "s3",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket,
    accessKeyId: "AKIAEXAMPLEEXAMPLEWS",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEWS",
    forcePathStyle: true,
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true, serverSideCopy: "same-store" },
    status: "active",
  };
}

async function call(token, name, args) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    env,
    ctx,
  );
  const body = JSON.parse(await response.text());
  await settle();
  return { text: body?.result?.content?.[0]?.text || body?.error?.message || "", isError: body?.result?.isError === true || !!body?.error };
}

const manage = (token, action, args, extra = {}) => call(token, "manage", { action, args, ...extra });

let controlPlane;
let restoreS3;
let restoreControlPlane;
before(async () => {
  restoreS3 = createS3Backend(S3_ENDPOINT).install();
  controlPlane = createControlPlaneStub();
  restoreControlPlane = controlPlane.install();
  controlPlane.addWorkspace("ws_home", "homer", binding("ws-home"));
  controlPlane.addWorkspace("ws_team", "homer-team", binding("ws-team"), { kind: "shared" });
  controlPlane.addWorkspace("ws_other", "marge", binding("ws-other"));
  await controlPlane.addGrant({
    workspaceId: "ws_home",
    userId: "user_homer",
    accessToken: OWNER,
    scopes: ["context:read", "context:write", "context:private"],
    alsoMemberOf: [{ workspaceId: "ws_team", role: "owner" }],
  });
  await controlPlane.addGrant({ workspaceId: "ws_home", userId: "user_homer", accessToken: READONLY, scopes: ["context:read"] });
  await controlPlane.addGrant({
    workspaceId: "ws_other",
    userId: "user_marge",
    accessToken: MEMBER,
    alsoMemberOf: [{ workspaceId: "ws_team", role: "member" }],
  });
});
after(() => {
  restoreControlPlane?.();
  restoreS3?.();
});

const setupCalls = () => controlPlane.workspaceSetupCalls;

test("create_workspace checks a handle, then claims it as the connection's own person", async () => {
  const free = await manage(OWNER, "create_workspace", { slug: "@Springfield-Co", dry_run: true });
  assert.equal(free.isError, false, free.text);
  assert.match(free.text, /@springfield-co is free\. Nothing was claimed/);

  const reserved = await manage(OWNER, "create_workspace", { slug: "brain", dry_run: true });
  assert.match(reserved.text, /not available: That name is reserved/);

  const made = await manage(OWNER, "create_workspace", { slug: "springfield-co", name: "Springfield Co" });
  assert.equal(made.isError, false, made.text);
  assert.match(made.text, /created the shared workspace @springfield-co/);
  assert.match(made.text, /action: "layout"/);
  const last = setupCalls().at(-1);
  assert.deepEqual([last.userId, last.slug, last.dryRun], ["user_homer", "springfield-co", false]);

  const again = await manage(OWNER, "create_workspace", { slug: "springfield-co", name: "Again" });
  assert.equal(again.isError, true);
  assert.match(again.text, /taken/);
});

test("a connection that cannot write never reaches the control plane", async () => {
  const before = setupCalls().length;
  for (const [action, args] of [
    ["create_workspace", { slug: "readonly-co", name: "Nope" }],
    ["layout", { template: "para" }],
    ["connect_google", { kind: "gmail" }],
  ]) {
    const answer = await manage(READONLY, action, args);
    assert.equal(answer.isError, true, `${action}: ${answer.text}`);
  }
  assert.equal(setupCalls().length, before);
});

test("layout goes to the workspace the call addressed, and only an owner chooses one", async () => {
  const owner = await manage(OWNER, "layout", { template: "business" }, { context: "@homer-team" });
  assert.equal(owner.isError, false, owner.text);
  assert.match(owner.text, /4-clients, 5-teams/);
  assert.equal(setupCalls().at(-1).workspaceId, "ws_team");

  const member = await manage(MEMBER, "layout", { template: "para" }, { context: "@homer-team" });
  assert.equal(member.isError, true);

  const folder = await manage(OWNER, "layout", { folder: "products" });
  assert.equal(folder.isError, false, folder.text);
  assert.match(folder.text, /added 6-products/);
  assert.equal(setupCalls().at(-1).workspaceId, "ws_home");

  const both = await manage(OWNER, "layout", { template: "para", folder: "teams" });
  assert.equal(both.isError, true);
  assert.match(both.text, /one of template or folder/);
});

test("a stranger cannot lay out or connect through somebody else's workspace", async () => {
  const before = setupCalls().length;
  const layout = await manage(MEMBER, "layout", { template: "para" }, { context: "@homer" });
  assert.equal(layout.isError, true);
  const google = await manage(MEMBER, "connect_google", { kind: "gmail" }, { context: "@homer" });
  assert.equal(google.isError, true);
  assert.equal(setupCalls().length, before);
});

test("connect_google hands back the app's page in the personal workspace, and refuses a shared one", async () => {
  const home = await manage(OWNER, "connect_google", { kind: "gmail" });
  assert.equal(home.isError, false, home.text);
  assert.match(home.text, /Link to connect Gmail: https:\/\/app\.context\.test\/console\/@homer\?settings=integrations/);
  assert.doesNotMatch(home.text, /accounts\.google\.com/);

  const team = await manage(OWNER, "connect_google", { kind: "calendar" }, { context: "@homer-team" });
  assert.equal(team.isError, true);
  assert.match(team.text, /personal workspace/);
});

test("orient's manual lists the three actions", async () => {
  const manual = await call(OWNER, "orient", { about: "tools" });
  for (const action of ["create_workspace", "layout", "connect_google"]) {
    assert.match(manual.text, new RegExp(`- ${action} —`));
  }
});
