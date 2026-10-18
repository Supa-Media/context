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
 * A real create claims a handle that is never freed, so it waits for the
 * person's yes on every gateway, and from a texted turn too; a dry run never
 * does (`handleClaimOf` in `tools/session.js`).
 *
 * Sabotage (temporary local edits, reverted; failures measured):
 *   `workspaceSetup.layout` sent with a fixed workspace, not the addressed one  1
 *   `handleClaimOf` answering null (a claim runs at once)                      3
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import worker from "../src/index.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub, createS3Backend } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";
import { isHeld, releaseNewest } from "./egressApproval.mjs";
import { fakeModel } from "./agentEgressFixtures.mjs";
import { AI_GATEWAY_ENV, AI_GATEWAY_ORIGIN, BUILTIN_ALLOWED } from "./agentModelFixture.mjs";

const S3_ENDPOINT = "https://s3.example-workspace-setup.test";
const OWNER = `cat_wssetup_owner_${"0".repeat(22)}`;
const READONLY = `cat_wssetup_ro_${"0".repeat(25)}`;
const MEMBER = `cat_wssetup_member_${"0".repeat(21)}`;
const CONSOLE = `cat_wssetup_console_${"0".repeat(20)}`;
const TEXTS = `cat_wssetup_texts_${"0".repeat(22)}`;
const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, ...AI_GATEWAY_ENV };
const model = fakeModel();

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

/** A text to the assistant, as the texting thread sends it. */
async function text(question) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/agent", {
      method: "POST",
      headers: { Authorization: `Bearer ${TEXTS}`, "Content-Type": "application/json" },
      body: JSON.stringify({ question, conversation: "texts" }),
    }),
    env,
    ctx,
  );
  const body = JSON.parse(await response.text());
  await settle();
  return body?.answer ?? "";
}

let controlPlane;
let restoreS3;
let restoreControlPlane;
let previousFetch;
before(async () => {
  restoreS3 = createS3Backend(S3_ENDPOINT).install();
  controlPlane = createControlPlaneStub();
  restoreControlPlane = controlPlane.install();
  previousFetch = globalThis.fetch;
  const withStubs = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    return url.startsWith(AI_GATEWAY_ORIGIN) ? model.handle(url, init) : withStubs(input, init);
  };
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
  for (const [accessToken, clientId] of [
    [CONSOLE, "context_console"],
    [TEXTS, "context_texts"],
  ]) {
    await controlPlane.addGrant({
      workspaceId: "ws_home",
      userId: "user_homer",
      accessToken,
      clientId,
      scopes: ["context:read", "context:write", "context:private"],
      alsoMemberOf: [{ workspaceId: "ws_team", role: "owner" }],
    });
  }
  controlPlane.setBuiltinVerdict("ws_home", BUILTIN_ALLOWED);
  await controlPlane.addGrant({
    workspaceId: "ws_other",
    userId: "user_marge",
    accessToken: MEMBER,
    alsoMemberOf: [{ workspaceId: "ws_team", role: "member" }],
  });
});
after(() => {
  if (previousFetch) globalThis.fetch = previousFetch;
  restoreControlPlane?.();
  restoreS3?.();
});

const setupCalls = () => controlPlane.workspaceSetupCalls;

test("create_workspace checks a handle, then claims it as the connection's own person once they say yes", async () => {
  const free = await manage(OWNER, "create_workspace", { slug: "@Springfield-Co", dry_run: true });
  assert.equal(free.isError, false, free.text);
  assert.match(free.text, /@springfield-co is free\. Nothing was claimed/);

  const reserved = await manage(OWNER, "create_workspace", { slug: "brain", dry_run: true });
  assert.match(reserved.text, /not available: That name is reserved/);

  const claims = () => setupCalls().filter((entry) => entry.dryRun === false).length;
  const claimsBefore = claims();
  const asked = { slug: "springfield-co", name: "Springfield Co" };
  const held = await manage(OWNER, "create_workspace", asked);
  assert.equal(isHeld({ isError: held.isError, content: [{ text: held.text }] }), true, held.text);
  assert.match(held.text, /claim the handle @springfield-co/);
  assert.match(held.text, /never/);
  assert.equal(claims(), claimsBefore, "nothing reached the control plane before the yes");

  assert.equal(await releaseNewest(env, CONSOLE), true);
  assert.equal(claims(), claimsBefore + 1, "the yes runs the claim once");
  const made = await manage(OWNER, "create_workspace", asked);
  assert.equal(made.isError, false, made.text);
  assert.equal(claims(), claimsBefore + 1, "the re-call is handed the released result, not run again");
  assert.match(made.text, /created the shared workspace @springfield-co/);
  assert.match(made.text, /action: "layout"/);
  const last = setupCalls().at(-1);
  assert.deepEqual([last.userId, last.slug, last.dryRun], ["user_homer", "springfield-co", false]);

  assert.equal((await manage(OWNER, "create_workspace", { slug: "springfield-co", name: "Again" })).isError, true);
  assert.equal(await releaseNewest(env, CONSOLE), true);
  const again = await manage(OWNER, "create_workspace", { slug: "springfield-co", name: "Again" });
  assert.equal(again.isError, true);
  assert.match(again.text, /taken/);
});

test("a dry run is never held, and a claim always is", async () => {
  const before = setupCalls().length;
  const check = await manage(OWNER, "create_workspace", { slug: "switched-off-co", dry_run: true });
  assert.equal(check.isError, false, check.text);
  assert.equal(setupCalls().length, before + 1);

  const claim = await manage(OWNER, "create_workspace", { slug: "switched-off-co", name: "Switched Off" });
  assert.equal(claim.isError, true, claim.text);
  assert.match(claim.text, /claim the handle @switched-off-co/);
  assert.equal(setupCalls().length, before + 1, "the claim did not reach the control plane");
});

test("Tex asks by text before claiming a handle, and the texted YES claims it", async () => {
  const claims = () => setupCalls().filter((entry) => entry.dryRun === false).length;
  const before = claims();
  model.install([
    {
      toolCalls: [
        { name: "manage", args: { action: "create_workspace", args: { slug: "woodshop", name: "Woodshop" } } },
      ],
    },
    { text: "I can set up @woodshop for you." },
  ]);
  const asked = await text("make me a workspace called Woodshop, @woodshop");
  assert.match(asked, /I need your OK: claim the handle @woodshop/);
  assert.match(asked, /Reply YES/);
  assert.equal(claims(), before, "a turn that read nothing still waits: the handle is permanent");

  const yes = await text("YES");
  assert.match(yes, /^Done: claim the handle @woodshop/);
  assert.equal(claims(), before + 1);
  assert.equal(setupCalls().at(-1).slug, "woodshop");
});

test("on a texted turn, Tex gets the Gmail link and lays out a workspace (onboarding by text)", async () => {
  const before = setupCalls().length;
  model.requests.length = 0;
  model.install([
    {
      toolCalls: [
        { name: "manage", args: { action: "connect_google", args: { kind: "gmail" } } },
        { name: "manage", args: { action: "layout", args: { template: "business" }, context: "@homer-team" } },
      ],
    },
    { text: "Tap Connect on this page, then text me." },
  ]);
  assert.equal(await text("ready"), "Tap Connect on this page, then text me.");
  assert.equal(setupCalls().length, before + 2, "both reached the control plane");
  assert.equal(setupCalls().at(-1).workspaceId, "ws_team");
  // What the model read back: the app's page, and that a new person signs in by phone first.
  const results = JSON.stringify(model.requests.at(-1));
  assert.match(results, /console\/@homer\?settings=integrations/);
  assert.match(results, /phone number/);
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

test("folder_job gives a job to a folder an owner names, takes one away, or makes it; refusals come back in words", async () => {
  const nested = await manage(OWNER, "folder_job", { job: "tex", path: "Life/Assistant/" });
  assert.equal(nested.isError, false, nested.text);
  assert.match(nested.text, /Life\/Assistant is the Tex folder now. Nothing moved/);
  assert.deepEqual([setupCalls().at(-1).job, setupCalls().at(-1).jobPath], ["tex", "Life/Assistant"]);

  const removed = await manage(OWNER, "folder_job", { job: "clients", remove: true });
  assert.match(removed.text, /there is no Clients folder now/);
  assert.equal(setupCalls().at(-1).jobPath, null);

  const made = await manage(OWNER, "folder_job", { job: "products" });
  assert.match(made.text, /added 6-products/);

  const archive = await manage(OWNER, "folder_job", { job: "archive", path: "Life/Old" });
  assert.equal(archive.isError, true);
  assert.match(archive.text, /Archive stays at the top/);

  const member = await manage(MEMBER, "folder_job", { job: "projects", path: "Work" }, { context: "@homer-team" });
  assert.equal(member.isError, true);

  const before = setupCalls().length;
  const unknown = await manage(OWNER, "folder_job", { job: "recipes" });
  assert.match(unknown.text, /no "recipes" job.*about\.md/);
  const both = await manage(OWNER, "folder_job", { job: "clients", path: "Work", remove: true });
  assert.match(both.text, /path or remove, not both/);
  const tex = await manage(OWNER, "folder_job", { job: "tex" });
  assert.match(tex.text, /made the first time it is used/);
  assert.equal(setupCalls().length, before);
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
