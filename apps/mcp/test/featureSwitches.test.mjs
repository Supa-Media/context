/**
 * The admin console's feature switches as the gateway reads them: the
 * `features` sibling on `/gateway/binding` (`controlPlane/session.js`) and
 * the store a session gets (`sessionStore.js`). Vault key use is the first:
 * a store carries `vaultProxy` only while staff switched it on, so
 * `vault_list` `fetch` refuses everywhere else.
 *
 * Sabotage (temporary local edit, reverted): defining `vaultProxy` whatever
 * the switch says fails "off by default"; reading `features.vaultKeyUse` as
 * truthy rather than `=== true` fails the parse test.
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

async function storeWith(features) {
  const controlPlane = { getStorageBinding: async () => ({ binding: BINDING, pendingMoves: [], idLayout: null, features }) };
  return storeForSession({ workspaceId: "w1", accessToken: "tok" }, { NATIVE_BINDINGS: "TEST_BUCKET", TEST_BUCKET: bucket() }, controlPlane);
}

test("off by default: a store carries no vault proxy unless key use is switched on", async () => {
  assert.equal((await storeWith(undefined)).vaultProxy, undefined);
  assert.equal((await storeWith({ vaultKeyUse: false })).vaultProxy, undefined);
  const on = await storeWith({ vaultKeyUse: true });
  assert.equal(typeof on.vaultProxy?.fetch, "function");
  // Non-enumerable, like every seam on the store.
  assert.ok(!Object.keys(on).includes("vaultProxy"));
});

test("getStorageBinding reads features off the response, and only a literal true is on", async () => {
  const env = { CONTROL_PLANE_URL: "https://cp.example", GATEWAY_SECRET: "secret" };
  const answering = (body) =>
    createControlPlane(env, {
      fetchImpl: async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
    });
  assert.deepEqual((await answering({ binding: BINDING, features: { vaultKeyUse: true } }).getStorageBinding("tok", "w1")).features, { vaultKeyUse: true });
  for (const features of [undefined, { vaultKeyUse: "true" }, { vaultKeyUse: 1 }, "on"]) {
    assert.deepEqual((await answering({ binding: BINDING, features }).getStorageBinding("tok", "w1")).features, { vaultKeyUse: false });
  }
});
