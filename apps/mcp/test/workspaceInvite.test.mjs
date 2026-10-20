/**
 * Tex invites people into a shared workspace, and offers one when work is
 * done with somebody else (the owner, 2026-10-20;
 * docs/decisions/gateway-protocol/workspace-setup.md).
 *
 * An invitation is an email that cannot be unsent, so `invite` waits for the
 * person's yes like a handle claim does, naming every invitee in the ask; and
 * `create_workspace` with `invite` makes the workspace and asks them in under
 * one yes (`tools/irreversible.js`). Through the worker, against the stub
 * control plane, which clears as the real route does.
 *
 * Sabotage (temporary local edits, reverted; failures measured):
 *   `irreversibleOf` answering null for invite_member (an invite runs at once)  2
 *   `toolCreateWorkspace` dropping `invitations` on the way out                  2
 *   `afterYes` offering nothing after a texted create                            1
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import worker from "../src/index.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub, createS3Backend } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";
import { isHeld, releaseNewest } from "./egressApproval.mjs";
import { fakeModel } from "./agentEgressFixtures.mjs";
import { AI_GATEWAY_ENV, AI_GATEWAY_ORIGIN, BUILTIN_ALLOWED } from "./agentModelFixture.mjs";

const S3_ENDPOINT = "https://s3.example-workspace-invite.test";
const OWNER = `cat_wsinvite_owner_${"0".repeat(22)}`;
const READONLY = `cat_wsinvite_ro_${"0".repeat(25)}`;
const MEMBER = `cat_wsinvite_member_${"0".repeat(21)}`;
const CONSOLE = `cat_wsinvite_console_${"0".repeat(20)}`;
const TEXTS = `cat_wsinvite_texts_${"0".repeat(22)}`;
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


const inviteCalls = () => controlPlane.workspaceSetupCalls.filter((entry) => entry.path === "/gateway/workspaces/invite");

test("invite waits for the person's yes, names who would be emailed, and then reaches the control plane once", async () => {
  const people = [{ who: "ada@example.com" }, { who: "@bart", role: "member" }];
  const before = inviteCalls().length;
  const held = await manage(OWNER, "invite", { people }, { context: "@homer-team" });
  assert.equal(isHeld({ isError: held.isError, content: [{ text: held.text }] }), true, held.text);
  assert.match(held.text, /invite ada@example\.com as an editor and @bart as a member to @homer-team \(Context emails them\)/);
  assert.match(held.text, /cannot be unsent/);
  assert.equal(inviteCalls().length, before, "nobody was emailed before the yes");

  assert.equal(await releaseNewest(env, CONSOLE), true);
  assert.equal(inviteCalls().length, before + 1);
  const sent = inviteCalls().at(-1);
  assert.equal(sent.workspaceId, "ws_team");
  assert.deepEqual(sent.invitations, [
    { invitee: "ada@example.com", role: "editor" },
    { invitee: "@bart", role: "member" },
  ]);
  const answer = await manage(OWNER, "invite", { people }, { context: "@homer-team" });
  assert.equal(answer.isError, false, answer.text);
  assert.match(answer.text, /invited ada@example\.com as an editor and @bart as a member/);
  assert.equal(inviteCalls().length, before + 1, "the re-call is handed the released result");
});

test("an invite that would be refused anyway is refused in words, not held", async () => {
  const before = controlPlane.workspaceSetupCalls.length;
  for (const people of [
    [],
    [{ who: "" }],
    [{ who: "ada@example.com", role: "owner" }],
    [{ who: "bo@example.com as a member, and nobody else" }],
  ]) {
    const answer = await manage(OWNER, "invite", { people }, { context: "@homer-team" });
    assert.equal(answer.isError, true);
    assert.doesNotMatch(answer.text, /^Not done: this would/);
  }
  assert.equal(controlPlane.workspaceSetupCalls.length, before);
});

test("a personal workspace is never opened to somebody else, even after a yes", async () => {
  const people = [{ who: "ada@example.com" }];
  assert.equal((await manage(OWNER, "invite", { people })).isError, true);
  assert.equal(await releaseNewest(env, CONSOLE), true);
  const answer = await manage(OWNER, "invite", { people });
  assert.equal(answer.isError, true);
  assert.match(answer.text, /shared workspace/);
});

test("create_workspace with invite makes it and asks them in under one yes", async () => {
  const asked = { slug: "bakery-co", name: "Bakery Co", invite: [{ who: "ada@example.com" }] };
  const held = await manage(OWNER, "create_workspace", asked);
  assert.match(held.text, /claim the handle @bakery-co for a new shared workspace \(handles are permanent\), and invite ada@example\.com as an editor/);
  assert.equal(await releaseNewest(env, CONSOLE), true);
  const created = controlPlane.workspaceSetupCalls.findLast((entry) => entry.slug === "bakery-co" && entry.dryRun === false);
  assert.deepEqual(created.invitations, [{ invitee: "ada@example.com", role: "editor" }]);
  const answer = await manage(OWNER, "create_workspace", asked);
  assert.match(answer.text, /invited ada@example\.com as an editor/);

  const before = controlPlane.workspaceSetupCalls.length;
  const bad = await manage(OWNER, "create_workspace", { slug: "bakery-bad", name: "Bad", invite: [{ who: "not an address" }] });
  assert.equal(bad.isError, true);
  assert.doesNotMatch(bad.text, /^Not done: this would/, "a list the tool will refuse claims no handle and asks nothing");
  assert.equal(controlPlane.workspaceSetupCalls.length, before);

  const dry = await manage(OWNER, "create_workspace", { slug: "bakery-two", dry_run: true, invite: [{ who: "ada@example.com" }] });
  assert.equal(dry.isError, false, dry.text);
  assert.equal(controlPlane.workspaceSetupCalls.at(-1).invitations, undefined, "a dry run invites nobody");
});

test("Tex offers a shared workspace for work with someone, and one texted YES makes it, invites them, and offers the next step", async () => {
  model.requests.length = 0;
  model.install([
    {
      toolCalls: [
        {
          name: "manage",
          args: { action: "create_workspace", args: { slug: "pottery-co", name: "Pottery Co", invite: [{ who: "lisa@example.com" }] } },
        },
      ],
    },
    { text: "Since you run the pottery stall with Lisa, a shared workspace would let you both keep its notes together." },
  ]);
  const offer = await text("Lisa and I are starting a pottery stall at the market, can you note our supplier list");
  const system = JSON.stringify(model.requests[0]);
  assert.match(system, /done with at least one other person/);
  assert.match(offer, /I need your OK: claim the handle @pottery-co .*and invite lisa@example\.com as an editor/);
  assert.equal(controlPlane.workspaceSetupCalls.some((entry) => entry.slug === "pottery-co" && entry.dryRun === false), false);

  const yes = await text("YES");
  assert.match(yes, /^Done, I claimed the handle @pottery-co .*and invited lisa@example\.com as an editor/);
  assert.match(yes, /Want me to set up its folders and move your notes about it there\?/);
  const created = controlPlane.workspaceSetupCalls.findLast((entry) => entry.slug === "pottery-co" && entry.dryRun === false);
  assert.deepEqual(created.invitations, [{ invitee: "lisa@example.com", role: "editor" }]);
});

test("a connection that cannot write invites nobody", async () => {
  const before = controlPlane.workspaceSetupCalls.length;
  const answer = await manage(READONLY, "invite", { people: [{ who: "ada@example.com" }] }, { context: "@homer-team" });
  assert.equal(answer.isError, true);
  assert.equal(controlPlane.workspaceSetupCalls.length, before);
});

test("housekeeping counts an invite as letting more people see something", async () => {
  const { mightWiden } = await import("../src/privacy/egress.js");
  assert.equal(mightWiden("invite_member", { people: [{ who: "ada@example.com" }] }), true);
});
