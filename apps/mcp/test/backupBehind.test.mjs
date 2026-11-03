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
