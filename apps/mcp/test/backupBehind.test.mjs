// The request's `defer` is laid on the session store's backup-behind door (`http/requestStore.js`), so the bucket's
// backup write can finish after the response when the request has a `ctx.waitUntil`, and is awaited when it has none.
import { test } from "node:test";
import assert from "node:assert/strict";

import { decorateRequestStore } from "../src/http/requestStore.js";

const session = { workspaceId: "ws", accessToken: "token", actorClientName: null };
const options = (ctx) => ({ session, env: {}, controlPlane: {}, ctx, request: new Request("https://example.test/mcp"), origin: "https://example.test" });

test("decorateRequestStore with a ctx that has waitUntil lays a defer function on the backup-behind door", async () => {
  const store = { backupBehind: { defer: null } };
  const handed = [];
  decorateRequestStore(store, options({ waitUntil: (promise) => handed.push(promise) }));
  assert.equal(typeof store.backupBehind.defer, "function");
  assert.equal(store.backupBehind.defer, store.defer);
  store.backupBehind.defer(Promise.resolve("work"));
  assert.equal(handed.length, 1, "the work was not handed to waitUntil");
});

test("decorateRequestStore with no ctx leaves the backup-behind door's defer null", () => {
  const store = { backupBehind: { defer: null } };
  decorateRequestStore(store, options(null));
  assert.equal(store.defer, null);
  assert.equal(store.backupBehind.defer, null);
});

test("a context a call opens beside its own writes its backup copy behind the response too", async () => {
  // ChatGPT's edits in a shared workspace took 3.5 s on 2026-11-03: the backup copy of every write the object's merge
  // made was awaited, since the opened store's door was never given the request's defer.
  const { attachContextOpener, onceEach } = await import("../src/http/contextOpener.js");
  const caller = { workspaceId: "ws_mine", grantScopes: ["context:read"], workspaces: [{ workspaceId: "ws_w2", slug: "team-w2", kind: "shared", role: "member" }] };
  Object.defineProperty(caller, "accessToken", { value: "fake-token" });
  const store = { backupBehind: { defer: null } };
  const handed = [];
  decorateRequestStore(store, options({ waitUntil: (promise) => handed.push(promise) }));
  const opened = { backupBehind: { defer: null } };
  attachContextOpener(store, caller, { env: {}, controlPlane: { reportSearchIndexProgress: async () => {}, notifyFormSubmission: async () => {} }, origin: "https://example.test", openOnce: onceEach(async () => opened), pinnedName: "@context-lc" });
  const { store: other } = await store.openContext("@team-w2");
  assert.equal(other, opened);
  assert.equal(other.backupBehind.defer, store.defer, "the opened context's backup copies are awaited");
});
