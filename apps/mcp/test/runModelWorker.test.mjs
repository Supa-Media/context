/*
 * `manage` action `run_model` through the whole Worker (`src/index.js`): the session the control plane resolves, the
 * binding `routing.js` attaches, the staff gate in `tools/session.js` and the run in `tools/runModel.js`, end to end.
 * `runModel.test.mjs` proves each refusal on its own; this proves an editor of `@context-lc` really gets the model's
 * answer, and a member of it the refusal, over the same MCP request any client sends.
 *
 * Sabotage record (2026-11-13): `routing.js` attaching no binding -> the editor's test fails; the session gate in
 * `tools/session.js` switched off -> both still pass, because `runLabModel` checks the role again (two gates, each
 * proven: the session gate by `runModel.test.mjs`).
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import worker from "../src/index.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub, createS3Backend } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";
import { texStoreNamespace } from "./texStoreFixture.mjs";

const S3_ENDPOINT = "https://s3.example-run-model.test";
const TOKEN_EDITOR = `cat_runmodel_editor_${"0".repeat(20)}`;
const TOKEN_MEMBER = `cat_runmodel_member_${"0".repeat(20)}`;
const ran = [];
const AI = {
  async run(model, input) {
    ran.push({ model, input });
    return { answers: { tier: { choice: "lookup", confidence: 0.9 } } };
  },
};
const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, TEX_STORE: texStoreNamespace().namespace, GATEWAY_SECRET, AI };

function binding(bucket) {
  return {
    provider: "s3",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket,
    accessKeyId: "AKIAEXAMPLEEXAMPLERM",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLERM",
    forcePathStyle: true,
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true, serverSideCopy: "same-store" },
    status: "active",
  };
}

async function call(token, args) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "manage", arguments: { action: "run_model", args } } }),
    }),
    env,
    ctx,
  );
  const body = JSON.parse(await response.text());
  await settle();
  return { text: body?.result?.content?.[0]?.text || "", isError: body?.result?.isError === true };
}

let restore = [];
before(async () => {
  const s3 = createS3Backend(S3_ENDPOINT);
  restore.push(s3.install());
  const controlPlane = createControlPlaneStub();
  restore.push(controlPlane.install());
  controlPlane.addWorkspace("ws_mine", "mine", binding("rm-mine"));
  controlPlane.addWorkspace("ws_pinned", "context-lc", binding("rm-pinned"), { kind: "shared" });
  const scopes = ["context:read", "context:write", "context:private"];
  await controlPlane.addGrant({ workspaceId: "ws_mine", role: "owner", userId: "user_staff", accessToken: TOKEN_EDITOR, scopes, clientId: "mcp_client_rm_staff", alsoMemberOf: [{ workspaceId: "ws_pinned", role: "editor" }] });
  await controlPlane.addGrant({ workspaceId: "ws_mine", role: "owner", userId: "user_member", accessToken: TOKEN_MEMBER, scopes, clientId: "mcp_client_rm_member", alsoMemberOf: [{ workspaceId: "ws_pinned", role: "member" }] });
});
after(() => {
  for (const undo of restore.reverse()) undo?.();
});

test("an editor of @context-lc runs Clef with the gateway's own binding and gets its raw answer", async () => {
  ran.length = 0;
  const input = { model: "clef", state: "a text", questions: { tier: { type: "choice", options: ["lookup", "change", "think"] } } };
  const answer = await call(TOKEN_EDITOR, { model: "@cf/cloudflare/clef", input });
  assert.equal(answer.isError, false, answer.text);
  assert.deepEqual(JSON.parse(answer.text), { answers: { tier: { choice: "lookup", confidence: 0.9 } } });
  assert.deepEqual(ran, [{ model: "@cf/cloudflare/clef", input }]);
});

test("a member of @context-lc is refused and the binding is never reached", async () => {
  ran.length = 0;
  const answer = await call(TOKEN_MEMBER, { model: "@cf/cloudflare/clef", input: { state: "x", questions: {} } });
  assert.equal(answer.isError, true);
  assert.match(answer.text, /people who edit @context-lc/);
  assert.deepEqual(ran, []);
});
