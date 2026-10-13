import { test } from "node:test";
import assert from "node:assert/strict";
import { handleGatewayJobMessage, moveRetryForText } from "../src/moves/queueConsumer.js";
import { recordChange } from "../src/activity/record.js";

const env = { CONTROL_PLANE_URL: "https://control-plane.test", GATEWAY_SECRET: "test-secret" };

test("temporary materialization failures back off and stop after five tries", () => {
  const error = "move move-eeeeeeeeeeee: materialization paused: moving collaboration history: storage write failed";
  assert.deepEqual(moveRetryForText(error, 0), { delaySeconds: 30, transientFailures: 1 });
  assert.deepEqual(moveRetryForText(error, 4), { delaySeconds: 480, transientFailures: 5 });
  assert.equal(moveRetryForText(error, 5), null);
  assert.equal(moveRetryForText("not found", 0), null);
});

async function withFetch(fetchImpl, run) {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await run();
  } finally {
    globalThis.fetch = oldFetch;
  }
}

test("a redelivered move waits for the running lease instead of acknowledging its only message", async () => {
  const sent = [];
  await withFetch(async () => new Response(JSON.stringify({ job: { retryAfterMs: 1_500 } }), {
    headers: { "content-type": "application/json" },
  }), async () => {
    await handleGatewayJobMessage({
      body: { ticket: "opaque-ticket" },
      retry: () => assert.fail("a new message should be scheduled"),
    }, { ...env, GATEWAY_JOBS: { send: (...args) => sent.push(args) } });
  });
  assert.deepEqual(sent, [[{ ticket: "opaque-ticket" }, { delaySeconds: 3 }]]);
});

test("a failed delayed send retries the current Queue message", async () => {
  const retries = [];
  await withFetch(async () => new Response(JSON.stringify({ job: { retryAfterMs: 1_500 } }), {
    headers: { "content-type": "application/json" },
  }), async () => {
    await handleGatewayJobMessage({
      body: { ticket: "opaque-ticket" },
      retry: (options) => retries.push(options),
    }, { ...env, GATEWAY_JOBS: { send: async () => { throw new Error("unavailable"); } } });
  });
  assert.deepEqual(retries, [{ delaySeconds: 30 }]);
});

test("a transient control-plane failure retries the Queue message", async () => {
  const retries = [];
  await withFetch(async () => { throw new Error("unavailable"); }, async () => {
    await handleGatewayJobMessage({
      body: { ticket: "opaque-ticket" },
      retry: (options) => retries.push(options),
    }, env);
  });
  assert.deepEqual(retries, [{ delaySeconds: 30 }]);
});

test("a terminal ticket is acknowledged without another retry", async () => {
  const retries = [];
  await withFetch(async () => new Response(JSON.stringify({ job: null }), {
    headers: { "content-type": "application/json" },
  }), async () => {
    await handleGatewayJobMessage({
      body: { ticket: "opaque-ticket" },
      retry: (options) => retries.push(options),
    }, env);
  });
  assert.deepEqual(retries, []);
});

test("a move finished by a queued job re-checks the tree of the job's workspace", async () => {
  // The queue consumer's store had no change reporters, so a move the
  // background job finished never reached the Convex tree until a sweep.
  // Sabotage: drop `attachChangeReporters` from the consumer and this fails.
  const posted = [];
  const bucket = {
    get: async () => null,
    put: async () => ({ etag: "e" }),
    delete: async () => {},
    list: async () => ({ objects: [], truncated: false }),
  };
  const opened = {
    job: { kind: "materialize_move", moveId: "move-1", workspaceId: "ws_job", actorUserId: "u1" },
    binding: {
      status: "active",
      workspaceId: "ws_job",
      provider: "r2-binding",
      bindingName: "TEST_BUCKET",
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: false },
    },
  };
  await withFetch(async (url, init) => {
    const path = new URL(url).pathname;
    posted.push({ path, body: JSON.parse(init.body) });
    if (path === "/gateway/tree/touch") {
      // A slow answer: the job must still wait for it before reporting done.
      await new Promise((resolve) => setTimeout(resolve, 30));
      posted.push({ path: "touch settled" });
    }
    return new Response(JSON.stringify(path === "/gateway/jobs/open" ? { job: opened } : { ok: true }), {
      headers: { "content-type": "application/json" },
    });
  }, async () => {
    await handleGatewayJobMessage(
      { body: { ticket: "opaque-ticket" }, retry: () => assert.fail("no retry expected") },
      { ...env, NATIVE_BINDINGS: "TEST_BUCKET", TEST_BUCKET: bucket },
      {
        materialize: async (store) => {
          await recordChange(store, "materialize_move", "private", ["1-projects/a", "2-areas/a"], {});
          return { content: [{ type: "text", text: "move move-1: complete" }] };
        },
      },
    );
  });
  const touches = posted.filter((call) => call.path === "/gateway/tree/touch");
  assert.equal(touches.length, 1, "the finished move was not reported to the tree");
  assert.equal(touches[0].body.workspaceId, "ws_job");
  assert.deepEqual(touches[0].body.paths, ["1-projects/a", "2-areas/a"]);
  // Sent before the job is reported done, so the worker is not torn down first.
  const reported = posted.findIndex((call) => call.path === "/gateway/jobs/report");
  const settled = posted.findIndex((call) => call.path === "touch settled");
  assert.ok(settled !== -1 && reported > settled, "the touch was not settled before the job was reported");
});
