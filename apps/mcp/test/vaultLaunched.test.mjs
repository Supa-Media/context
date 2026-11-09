/**
 * Vault key use, launched for everyone (the owner, 2026-11-08: "let's clean up
 * the vault flag, it's been on for ages"). Every store a session opens carries
 * `vaultProxy`, whatever the control plane's answer says, and the answer's
 * retired `features` sibling is no longer read.
 *
 * Sabotage (temporary local edit, reverted): putting the old
 * `opened.features?.vaultKeyUse === true` guard back in `sessionStore.js`
 * fails "every store carries the vault proxy".
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { storeForSession } from "../src/sessionStore.js";
import { createControlPlane } from "../src/controlPlane/index.js";

const BINDING = {
  status: "active",
  workspaceId: "w1",
  provider: "r2-binding",
  bindingName: "TEST_BUCKET",
  capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: false },
};

function bucket() {
  const objects = new Map();
  return {
    capabilities: BINDING.capabilities,
    async get(key) {
      const body = objects.get(key);
      return body === undefined ? null : { key, etag: "e", text: async () => body, arrayBuffer: async () => new TextEncoder().encode(body).buffer };
    },
    async head(key) {
      return objects.has(key) ? { etag: "e", size: objects.get(key).length } : null;
    },
    async put(key, body) {
      objects.set(key, String(body));
      return { etag: "e" };
    },
    async delete(key) {
      objects.delete(key);
    },
    async list() {
      return { objects: [], truncated: false };
    },
  };
}

async function storeWith(extra) {
  const controlPlane = { getStorageBinding: async () => ({ binding: BINDING, idLayout: null, ...extra }) };
  return storeForSession({ workspaceId: "w1", accessToken: "tok" }, { NATIVE_BINDINGS: "TEST_BUCKET", TEST_BUCKET: bucket() }, controlPlane);
}

test("every store carries the vault proxy, with or without the retired switch", async () => {
  for (const extra of [{}, { features: { vaultKeyUse: false } }, { features: { vaultKeyUse: true } }]) {
    const store = await storeWith(extra);
    assert.equal(typeof store.vaultProxy?.fetch, "function");
    // Non-enumerable, like every seam on the store.
    assert.ok(!Object.keys(store).includes("vaultProxy"));
  }
});

test("getStorageBinding no longer reads a features sibling", async () => {
  const env = { CONTROL_PLANE_URL: "https://cp.example", GATEWAY_SECRET: "secret" };
  const controlPlane = createControlPlane(env, {
    fetchImpl: async () =>
      new Response(JSON.stringify({ binding: BINDING, features: { vaultKeyUse: true } }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  const answer = await controlPlane.getStorageBinding("tok", "w1");
  assert.equal("features" in answer, false);
});
