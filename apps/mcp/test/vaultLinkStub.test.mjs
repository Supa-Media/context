/**
 * The control-plane stub answers `/gateway/vault/request` the way the real
 * route does, so a bench world (and any gateway test) can mint a vault link.
 * Without it every `vault_add_link` in a bench run failed with "The vault is
 * not available", which failed the save-a-login gate for every setup however
 * well the model did (2026-10-14).
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import worker from "../src/index.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub, createS3Backend } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";

const S3_ENDPOINT = "https://s3.example-vault-link-stub.test";
const TOKEN_OWNER = `cat_vaultstub_owner_${"0".repeat(20)}`;
const TOKEN_OTHER = `cat_vaultstub_other_${"0".repeat(20)}`;
const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET };

function binding(bucket) {
  return {
    provider: "s3",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket,
    accessKeyId: "AKIAEXAMPLEEXAMPLEVL",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEVL",
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
  return { text: body?.result?.content?.[0]?.text || "", isError: body?.result?.isError === true };
}

let controlPlane;
let restoreS3;
let restoreControlPlane;
before(async () => {
  restoreS3 = createS3Backend(S3_ENDPOINT).install();
  controlPlane = createControlPlaneStub();
  restoreControlPlane = controlPlane.install();
  controlPlane.addWorkspace("ws_vault_a", "vaulta", binding("vault-a"));
  controlPlane.addWorkspace("ws_vault_b", "vaultb", binding("vault-b"));
  await controlPlane.addGrant({ workspaceId: "ws_vault_a", role: "owner", userId: "user_a", accessToken: TOKEN_OWNER, scopes: ["context:read", "context:write"], clientId: "mcp_client_vault_a" });
  await controlPlane.addGrant({ workspaceId: "ws_vault_b", role: "owner", userId: "user_b", accessToken: TOKEN_OTHER, scopes: ["context:read", "context:write"], clientId: "mcp_client_vault_b" });
});
after(() => {
  restoreControlPlane?.();
  restoreS3?.();
});

test("vault_add_link gets a private link from the stub, with the form's prefill on it", async () => {
  const answer = await call(TOKEN_OWNER, "vault_add_link", { type: "login", name: "Streamly", site: "streamly.example" });
  assert.equal(answer.isError, false, answer.text);
  assert.match(answer.text, /Link to save the login: https:\/\/\S+name=Streamly/);
  assert.match(answer.text, /expires in 30 minutes/);
  assert.equal(controlPlane.vaultCalls.at(-1).workspaceId, "ws_vault_a");
});

test("no link is minted in a workspace the connection cannot reach", async () => {
  const before = controlPlane.vaultCalls.length;
  const answer = await call(TOKEN_OTHER, "vault_add_link", { type: "login", site: "streamly.example", context: "@vaulta" });
  assert.equal(answer.isError, true);
  assert.equal(controlPlane.vaultCalls.length, before);
});
