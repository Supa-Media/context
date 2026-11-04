/**
 * `pair_device` (`manage` action `pair_device`) and `mail: { join, device }`: a Claude Code or Codex session approves
 * the code its own computer's runner shows, from the Context connection it already has, and then joins a note's mail
 * as that computer so mail is pushed to it (owner, 2026-11-04: "we can have them pair using the mcp somehow because
 * my claude and codex vms would already be connected to the MCP").
 *
 * The gateway decides nothing here: it forwards the connection's own token, the workspace it resolved and the code
 * to the control plane, and turns the answer into a sentence. Who may pair, into which workspace, and that the
 * device is mail-only and ends with this grant are the control plane's
 * (`apps/convex/__tests__/texMachineDevices.test.ts`).
 *
 * Sabotage record (applied, suite run, named test observed failing, reverted):
 *  1. `store.pairDevice` sending another workspace than the session's → "manage pair_device reaches the control
 *     plane with the connection's own token, its workspace and the code".
 *  2. the mail tool dropping `device` on join → "joining a note's mail as a device binds the mailbox to it".
 *  3. `joinedText` giving a device the polling rhythm → the same test (live check, 2026-11-04: a joined VM was told
 *     to set a 5-minute timer it does not need).
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import worker from "../src/index.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub, createS3Backend } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";
import { fullToolList } from "./fullToolList.mjs";
import { texStoreNamespace } from "./texStoreFixture.mjs";

const S3_ENDPOINT = "https://s3.example-pair-device.test";
const TOKEN = `cat_pairdevice_owner_${"0".repeat(19)}`;
const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, TEX_STORE: texStoreNamespace().namespace, GATEWAY_SECRET };

function binding(bucket) {
  return {
    provider: "s3",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket,
    accessKeyId: "AKIAEXAMPLEEXAMPLEPD",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEPD",
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
    ctx
  );
  const body = JSON.parse(await response.text());
  await settle();
  return { text: body?.result?.content?.[0]?.text || "", isError: body?.result?.isError === true };
}

const pair = (code) => call(TOKEN, "manage", { action: "pair_device", args: { code } });

let controlPlane;
let restoreS3;
let restoreControlPlane;
before(async () => {
  const s3 = createS3Backend(S3_ENDPOINT);
  restoreS3 = s3.install();
  controlPlane = createControlPlaneStub();
  restoreControlPlane = controlPlane.install();
  controlPlane.addWorkspace("ws_vm", "vmowner", binding("vm-bucket"));
  s3.bucketFor("vm-bucket").set("index.md", { body: "# Front page", etag: "i0" });
  s3.bucketFor("vm-bucket").set("projects/a.md", { body: "# Plan\n", etag: "a0" });
  await controlPlane.addGrant({
    workspaceId: "ws_vm",
    role: "owner",
    userId: "user_vm",
    accessToken: TOKEN,
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "mcp_client_claude_code",
  });
});
beforeEach(() => {
  controlPlane.devices.asks.length = 0;
  controlPlane.devices.answer = { name: "Claude Code · repo", os: "linux" };
});
after(() => {
  restoreControlPlane?.();
  restoreS3?.();
});

test("it is offered to the connection, and manage lists it", async () => {
  const names = (await fullToolList(env, TOKEN)).map((tool) => tool.name);
  assert.ok(names.includes("pair_device"));
});

test("manage pair_device reaches the control plane with the connection's own token, its workspace and the code", async () => {
  const answer = await pair("kq7-4mp");
  assert.equal(answer.isError, false, answer.text);
  assert.match(answer.text, /Paired: Claude Code · repo \(linux\)/);
  assert.match(answer.text, /mail only/);
  assert.match(answer.text, /device: "<device id>"/);
  assert.deepEqual(controlPlane.devices.asks, [{ accessToken: TOKEN, workspaceId: "ws_vm", code: "kq7-4mp" }]);
});

test("a malformed code is refused before the control plane is asked, and a refusal is a sentence", async () => {
  assert.equal((await pair("not a code")).isError, true);
  assert.deepEqual(controlPlane.devices.asks, []);
  controlPlane.devices.answer = { status: 404 };
  const missing = await pair("ZZZ-ZZZ");
  assert.equal(missing.isError, true);
  assert.match(missing.text, /no computer is showing that code/);
  controlPlane.devices.answer = { status: 429 };
  assert.match((await pair("ZZZ-ZZZ")).text, /too many codes/);
});

test("joining a note's mail as a device binds the mailbox to it; someone else's device is refused", async () => {
  controlPlane.devices.machines.set("mch_vm00001", { ownerId: "user_vm", workspaceId: "ws_vm" });
  controlPlane.devices.machines.set("mch_other01", { ownerId: "user_other", workspaceId: "ws_other" });
  const joined = await call(TOKEN, "write_note", { path: "projects/a.md", mail: { join: "vm-builder", device: "mch_vm00001" } });
  assert.equal(joined.isError, false, joined.text);
  const row = [...controlPlane.mailboxes.values()].find((box) => box.name === "vm-builder");
  assert.equal(row?.machineId, "mch_vm00001");
  // Its mail is pushed to it, so it is told to keep `mail wait` running and never to set a polling timer.
  assert.match(joined.text, /context-machine mail wait/);
  assert.doesNotMatch(joined.text, /timer|every 5 minutes|sleep 300/i);

  const refused = await call(TOKEN, "write_note", { path: "projects/a.md", mail: { join: "vm-two", device: "mch_other01" } });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /not a live device of this person's/);
  const malformed = await call(TOKEN, "write_note", { path: "projects/a.md", mail: { join: "vm-three", device: "../x" } });
  assert.equal(malformed.isError, true);
});
