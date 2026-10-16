/**
 * Index passes wait for the turn (`src/search/heldPasses.js`).
 *
 * A search starts an index pass behind its response. In an assistant's turn
 * every call shares one Worker invocation and its six connections, so those
 * passes queued the rest of the turn behind them: on production, 2026-10-16,
 * one Tex turn issued about 2,000 subrequests, a search that answers in under
 * a second took over ten, and Dev2 saw it in the logs. These checks pin that a
 * turn's passes start only once the turn is over, that each workspace's pass
 * runs once, and that nothing is dropped.
 *
 * Sabotage record (temporary local edits, reverted):
 *   `deferSearchPass` starting the pass instead of holding it → "a Tex turn's searches start no index pass until the model has answered" fails
 *   `/agent` calling `handleAgent` without `withSearchPassesHeld` → the same check fails, three passes per workspace before the last round
 *   `release` starting nothing                                → "...and the pass still runs, behind the reply" and "a held pass starts on release, once per workspace" fail
 *   the per-workspace key dropped (every pass kept)           → "a held pass starts on release, once per workspace" fails
 *   `withMeaning` reading snippets one at a time again        → "the notes found only by meaning are read at once, in order" fails
 *   `toolSearchNotes` awaiting its own workspace first again  → "a Tex turn's searches start no index pass…" fails (searched at once)
 */

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { createWorkerCtx } from "./workerCtx.mjs";
import { createControlPlaneStub, createS3Backend, CONTROL_PLANE_ORIGIN, GATEWAY_SECRET } from "./controlPlaneStub.mjs";
import { AI_GATEWAY_ENV, AI_GATEWAY_ORIGIN, BUILTIN_ALLOWED } from "./agentModelFixture.mjs";
import { deferSearchPass, holdSearchPasses } from "../src/search/heldPasses.js";
import { MEANING_DIMENSIONS } from "../src/search/meaning/embed.js";
import { attachMeaningIndex } from "../src/search/meaning/store.js";
import { meaningMatches, withMeaning } from "../src/search/meaning/serve.js";

/** A store whose `defer` records what it was handed. */
function deferringStore(workspaceId) {
  const deferred = [];
  return { deferred, store: { actor: { workspaceId }, defer: (work) => deferred.push(work) } };
}

test("a held pass starts on release, once per workspace", async () => {
  const { store, deferred } = deferringStore("ws_a");
  const other = { actor: { workspaceId: "ws_b" }, defer: store.defer };
  const started = [];
  const pass = (name) => () => {
    started.push(name);
    return Promise.resolve(name);
  };
  const passes = holdSearchPasses(store);
  other.holdSearchPass = store.holdSearchPass; // as `openContext` copies it
  deferSearchPass(store, pass("a1"));
  deferSearchPass(store, pass("a2"));
  deferSearchPass(other, pass("b1"));
  assert.deepEqual(started, [], "nothing starts while the hold lasts");
  assert.equal(deferred.length, 0);
  assert.equal(passes.release(), 2);
  assert.deepEqual(started, ["a1", "b1"], "each workspace's first pass, and no second one");
  assert.equal(deferred.length, 2, "both still behind the response");
  assert.equal(store.holdSearchPass, undefined, "the hold is gone");
  // A context opened during the hold still holds its function: past the release it no longer waits.
  deferSearchPass(other, pass("b2"));
  assert.deepEqual(started, ["a1", "b1", "b2"]);
});

test("no hold on a host that cannot defer, and an outer hold is left to its owner", () => {
  const bare = { actor: { workspaceId: "ws" } };
  assert.equal(holdSearchPasses(bare).release(), 0);
  assert.equal(bare.holdSearchPass, undefined, "a pass there runs inline, never held");
  const { store } = deferringStore("ws");
  const outer = holdSearchPasses(store);
  const inner = holdSearchPasses(store);
  deferSearchPass(store, () => Promise.resolve());
  assert.equal(inner.release(), 0, "the inner hold releases nothing");
  assert.equal(typeof store.holdSearchPass, "function", "and leaves the outer one in place");
  assert.equal(outer.release(), 1);
});

test("the notes found only by meaning are read at once, in order", async () => {
  const VECTOR = Array.from({ length: MEANING_DIMENSIONS }, () => 0.25);
  const matches = ["m0.md", "m1.md", "m2.md"].map((path, i) => ({ id: `id-${i}`, score: 0.9 - i / 100, metadata: { path, chunk: 0, tier: "team" } }));
  const fetchImpl = async () => {
    const text = JSON.stringify({ success: true, result: { matches } });
    return { status: 200, headers: { get: () => String(text.length) }, text: async () => text };
  };
  let open = 0;
  let most = 0;
  const store = {
    actor: { workspaceId: "ws1" },
    async get(path) {
      open += 1;
      most = Math.max(most, open);
      await new Promise((resolve) => setTimeout(resolve, 5));
      open -= 1;
      return { text: async () => `# ${path}\n\nbody of ${path}\n` };
    },
  };
  attachMeaningIndex(store, { indexName: "context-meaning-ws1", accountId: "fake-account", apiToken: "fake-token", state: "ready" }, null);
  const found = await withMeaning(
    store,
    { hits: [{ key: "w.md", title: "W", snippets: [] }], matchCount: 1 },
    await meaningMatches(store, { query: "q", scope: "private", isVisible: () => true, fetchImpl, embed: async (texts) => texts.map(() => VECTOR) }),
  );
  assert.equal(most, 3, "all three reads were out at once");
  assert.deepEqual(found.hits.map((hit) => hit.key), ["w.md", "m0.md", "m1.md", "m2.md"]);
});

const S3_ENDPOINT = "https://s3.example-held-passes.test";
const TOKEN = `cat_held_owner_${"0".repeat(25)}`;

test("a Tex turn's searches start no index pass until the model has answered", async () => {
  const previousFetch = globalThis.fetch;
  const s3 = createS3Backend(S3_ENDPOINT);
  const restoreS3 = s3.install();
  const controlPlane = createControlPlaneStub();
  const restoreControlPlane = controlPlane.install();
  // One timeline: each model round, and each object an index pass writes.
  const timeline = [];
  const script = [
    { tool: { name: "search", args: { query: "pricing" } } },
    { tool: { name: "search", args: { query: "venue" } } },
    { text: "Five dollars." },
  ];
  // The person's own bucket answers only once the other workspace has been
  // asked, or after a wait: searched one after the other, the wait is spent.
  let seen = false;
  let otherAsked;
  const otherSeen = new Promise((resolve) => (otherAsked = () => resolve((seen = true))));
  let waited = false;
  const below = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith(`${S3_ENDPOINT}/tenant-other`)) otherAsked();
    if (url.startsWith(`${S3_ENDPOINT}/tenant-held/`) && url.includes("1-projects")) {
      await Promise.race([otherSeen, new Promise((resolve) => setTimeout(() => resolve((waited ||= !seen)), 300))]);
    }
    if (url.startsWith(AI_GATEWAY_ORIGIN)) {
      timeline.push("model");
      const next = script.shift();
      const content = next.tool ? [{ type: "tool_use", id: `toolu_${script.length}`, name: next.tool.name, input: next.tool.args }] : [{ type: "text", text: next.text }];
      return new Response(JSON.stringify({ content, stop_reason: next.tool ? "tool_use" : "end_turn" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const method = init?.method ?? (typeof input === "object" ? input.method : "GET");
    if (url.startsWith(S3_ENDPOINT) && method === "PUT" && url.includes("/.context/search/")) {
      timeline.push(url.includes("/tenant-other/") ? "pass-other" : "pass");
    }
    return below(input, init);
  };
  try {
    controlPlane.addWorkspace("ws_held", "held", {
      provider: "s3",
      status: "active",
      endpoint: S3_ENDPOINT,
      region: "auto",
      bucket: "tenant-held",
      accessKeyId: "AKIAEXAMPLEEXAMPLEHP",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEHP",
      forcePathStyle: true,
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    });
    controlPlane.addWorkspace("ws_other", "band", {
      provider: "s3",
      status: "active",
      endpoint: S3_ENDPOINT,
      region: "auto",
      bucket: "tenant-other",
      accessKeyId: "AKIAEXAMPLEEXAMPLEHQ",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEHQ",
      forcePathStyle: true,
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    });
    controlPlane.serveTreesFrom(null, { s3 });
    await controlPlane.addGrant({
      accessToken: TOKEN,
      workspaceId: "ws_held",
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "mcp_client_held_owner",
      userId: "user_held",
      alsoMemberOf: [{ workspaceId: "ws_other", role: "owner" }],
    });
    controlPlane.setBuiltinVerdict("ws_held", BUILTIN_ALLOWED);
    const bucket = s3.bucketFor("tenant-held");
    bucket.set("1-projects/pricing.md", { body: "# Pricing\n\nWe moved to $5.\n", etag: "h1" });
    bucket.set("1-projects/venue.md", { body: "# Venue\n\nThe Velvet Anchor.\n", etag: "h2" });
    s3.bucketFor("tenant-other").set("gigs/venue.md", { body: "# Gig\n\nThe venue is the Velvet Anchor.\n", etag: "o1" });

    const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, ...AI_GATEWAY_ENV };
    const { ctx, settle } = createWorkerCtx();
    const response = await worker.fetch(
      new Request("https://mcp.context.test/agent", {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ question: "What's our price?" }),
      }),
      env,
      ctx,
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.answer, "Five dollars.");
    assert.deepEqual(body.steps.map((step) => step.tool), ["search_notes", "search_notes"]);
    assert.equal(waited, false, "every workspace was searched at once, the person's own included");
    const lastModel = timeline.lastIndexOf("model");
    assert.equal(timeline.slice(0, lastModel).some((event) => event.startsWith("pass")), false, `no pass wrote before the last model round: ${timeline.join(",")}`);
    await settle();
    assert.ok(timeline.includes("pass") && timeline.includes("pass-other"), "...and the pass still runs in both, behind the reply");
  } finally {
    restoreControlPlane();
    restoreS3();
    globalThis.fetch = previousFetch;
  }
});
