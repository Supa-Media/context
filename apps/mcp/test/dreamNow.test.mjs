/**
 * `dream_now` (`manage` action `dream_now`): the person's own agent starts
 * Tex's dream now instead of at 3 am (owner, 2026-10-17, for onboarding).
 *
 * The gateway decides nothing but the tier: it forwards the connection's own
 * token and the workspace it resolved to `/gateway/dreams/start`, and turns the
 * control plane's code into a sentence the agent can pass on. Who may ask, the
 * Premium gate and the window are the control plane's
 * (`apps/convex/__tests__/dreamNow.test.ts`).
 */
/*
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   `toolDreamNow` not refusing below the private tier
 *     → "a connection below the owner's tier is refused before the control plane is asked" fails
 *   `dream_now` dropped from PRIVATE_TIER_ONLY_TOOLS
 *     → "it is offered to the owner's connection only" fails
 *   `store.dreamNow` sending another workspace id than the session's
 *     → "manage dream_now reaches the control plane…", "the older name answers
 *       the same" and "every answer is a sentence…" fail
 *   the dream dispatcher allowing every tool
 *     → "a dream cannot start a dream" fails
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import worker from "../src/index.js";
import { dreamCallTool } from "../src/agent/dream.js";
import { agentTools } from "../src/agent/turn.js";
import { textingWriteTools } from "../src/agent/textingWrites.js";
import { sixToolsOver } from "../src/agent/sixTools.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub, createS3Backend } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";
import { fullToolList } from "./fullToolList.mjs";
import { texStoreNamespace } from "./texStoreFixture.mjs";

const S3_ENDPOINT = "https://s3.example-dream-now.test";
const TOKEN_OWNER = `cat_dreamnow_owner_${"0".repeat(21)}`;
const TOKEN_EDITOR = `cat_dreamnow_editor_${"0".repeat(20)}`;
const TOKEN_READ_ONLY = `cat_dreamnow_readonly_${"0".repeat(18)}`;
const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, TEX_STORE: texStoreNamespace().namespace, GATEWAY_SECRET };

function binding(bucket) {
  return {
    provider: "s3",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket,
    accessKeyId: "AKIAEXAMPLEEXAMPLEDN",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEDN",
    forcePathStyle: true,
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true, serverSideCopy: "same-store" },
    status: "active",
  };
}

async function rpc(token, method, params) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    env,
    ctx
  );
  const body = JSON.parse(await response.text());
  await settle();
  return body?.result;
}

async function call(token, name, args) {
  const result = await rpc(token, "tools/call", { name, arguments: args });
  return { text: result?.content?.[0]?.text || "", isError: result?.isError === true };
}

const manageDreamNow = (token) => call(token, "manage", { action: "dream_now", args: {} });

let controlPlane;
let restoreS3;
let restoreControlPlane;
before(async () => {
  const s3 = createS3Backend(S3_ENDPOINT);
  restoreS3 = s3.install();
  controlPlane = createControlPlaneStub();
  restoreControlPlane = controlPlane.install();
  controlPlane.addWorkspace("ws_dream", "dreamer", binding("dream-bucket"));
  s3.bucketFor("dream-bucket").set("index.md", { body: "# Front page", etag: "i0" });
  await controlPlane.addGrant({
    workspaceId: "ws_dream",
    role: "owner",
    userId: "user_dreamer",
    accessToken: TOKEN_OWNER,
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "mcp_client_dream",
  });
  await controlPlane.addGrant({
    workspaceId: "ws_dream",
    role: "editor",
    userId: "user_guest",
    accessToken: TOKEN_EDITOR,
    scopes: ["context:read", "context:write"],
    clientId: "mcp_client_dream_editor",
  });
  await controlPlane.addGrant({
    workspaceId: "ws_dream",
    role: "owner",
    userId: "user_dreamer",
    accessToken: TOKEN_READ_ONLY,
    scopes: ["context:read"],
    clientId: "mcp_client_dream_ro",
  });
});
beforeEach(() => {
  controlPlane.dreams.asks.length = 0;
  controlPlane.dreams.state.answer = { status: "started" };
});
after(() => {
  restoreControlPlane?.();
  restoreS3?.();
});

test("it is offered to the owner's connection only", async () => {
  const owner = (await fullToolList(env, TOKEN_OWNER)).map((tool) => tool.name);
  assert.ok(owner.includes("dream_now"));
  for (const token of [TOKEN_EDITOR, TOKEN_READ_ONLY]) {
    const names = (await fullToolList(env, token)).map((tool) => tool.name);
    assert.ok(!names.includes("dream_now"), `offered to ${token}`);
  }
});

test("manage dream_now reaches the control plane with the connection's own token and its workspace", async () => {
  const answer = await manageDreamNow(TOKEN_OWNER);
  assert.equal(answer.isError, false, answer.text);
  assert.match(answer.text, /^Started/);
  assert.match(answer.text, /tex\/about\.md/);
  assert.deepEqual(controlPlane.dreams.asks, [{ accessToken: TOKEN_OWNER, workspaceId: "ws_dream", userId: "user_dreamer" }]);
});

test("the older name answers the same", async () => {
  const answer = await call(TOKEN_OWNER, "dream_now", {});
  assert.equal(answer.isError, false, answer.text);
  assert.equal(controlPlane.dreams.asks.length, 1);
});

test("a connection below the owner's tier is refused before the control plane is asked", async () => {
  const answer = await manageDreamNow(TOKEN_EDITOR);
  assert.equal(answer.isError, true);
  assert.match(answer.text, /only the owner/i);
  assert.equal(controlPlane.dreams.asks.length, 0);
  assert.equal(controlPlane.calls.filter((entry) => entry.path === "/gateway/dreams/start" && entry.body.accessToken === TOKEN_EDITOR).length, 0);
});

test("a read-only connection cannot call it", async () => {
  const answer = await manageDreamNow(TOKEN_READ_ONLY);
  assert.equal(answer.isError, true);
  assert.equal(controlPlane.dreams.asks.length, 0);
});

test("every answer is a sentence the agent can pass on", async () => {
  const cases = [
    [{ status: "running" }, false, /already under way/i],
    [{ status: "recent", retryAt: Date.parse("2026-10-17T18:00:00Z") }, true, /recently.*2026-10-17T18:00:00Z/],
    [{ status: "not_included" }, true, /include dreams/],
    [{ status: "daily_limit" }, true, /used up/],
    [{ status: "unavailable" }, true, /switched off/],
    [{ status: "not_texting" }, true, /linked phone/],
    [{ status: "a sentence the control plane should never send" }, true, /only the owner/i],
    [null, true, /only the owner/i],
  ];
  for (const [answer, isError, sentence] of cases) {
    controlPlane.dreams.state.answer = answer;
    const result = await manageDreamNow(TOKEN_OWNER);
    assert.equal(result.isError, isError, JSON.stringify(answer));
    assert.match(result.text, sentence, JSON.stringify(answer));
  }
});

test("a texted turn is shown manage dream_now; the app panel is not", async () => {
  const offered = await fullToolList(env, TOKEN_OWNER);
  const texting = textingWriteTools(offered, { texting: true });
  const manage = sixToolsOver(texting).tools.find((tool) => tool.name === "manage");
  assert.match(manage.description, /- dream_now: /);
  assert.ok(!agentTools(offered).some((tool) => tool.name === "dream_now"));
  assert.deepEqual(textingWriteTools(offered, { texting: false }), []);
});

test("a dream cannot start a dream", async () => {
  const reached = [];
  const callTool = dreamCallTool(async (name) => {
    reached.push(name);
    return { content: [{ type: "text", text: "ok" }] };
  });
  const answer = await callTool("dream_now", {});
  assert.equal(answer.isError, true);
  assert.deepEqual(reached, []);
});
