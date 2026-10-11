import { test } from "node:test";
import assert from "node:assert/strict";
import { createJobMethods } from "../src/controlPlane/jobs.js";
import { attachGatewayJobQueue } from "../src/http/routing.js";

test("an existing move worker does not send a second queue message", async () => {
  const controlPlane = createJobMethods({
    post: async () => ({ alreadyActive: true, ticket: null }),
    required: (value, key) => value[key],
  });
  let sends = 0;
  const store = {};
  attachGatewayJobQueue(store, { accessToken: "test", workspaceId: "workspace" }, controlPlane, {
    GATEWAY_JOBS: { send: async () => { sends += 1; } },
  });
  assert.equal(await store.enqueueGatewayJob({ kind: "materialize_move", moveId: "move-aaaaaaaaaaaa" }), false);
  assert.equal(sends, 0);
});

test("a newly minted move worker sends its ticket exactly once", async () => {
  const controlPlane = createJobMethods({
    post: async () => ({ ticket: "test-ticket" }),
    required: (value, key) => value[key],
  });
  const messages = [];
  const store = {};
  attachGatewayJobQueue(store, { accessToken: "test", workspaceId: "workspace" }, controlPlane, {
    GATEWAY_JOBS: { send: async (message) => { messages.push(message); } },
  });
  assert.equal(await store.enqueueGatewayJob({ kind: "materialize_move", moveId: "move-aaaaaaaaaaaa" }), true);
  assert.deepEqual(messages, [{ ticket: "test-ticket", kind: "materialize_move", moveId: "move-aaaaaaaaaaaa" }]);
});
