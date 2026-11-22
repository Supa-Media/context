/**
 * The standing bench objects (`packages/lab/gateway/bench/`): a world set up and loaded through `POST /tex-lab/bench`,
 * a second copy cloned from the first on its own alarm, and searches asked of both copies at once, through the
 * gateway's MCP endpoint in the bench environment. And the doors: who may call, and that a call reaches only its own
 * world's bench objects, never a real workspace object.
 *
 * Sabotage record (temporary local edits, reverted; each fails the named test):
 *   `ownId` returns true for any id                            -> "a call names only its own world's objects" fails
 *   `benchEnvOf` keeps the deployment's WORKSPACE_STORE         -> "a world is loaded, cloned ..." fails (the trap throws)
 *   `cachedAi` asks the model on a cache hit                    -> "... embeds each text once" fails
 *   `admitted` lets any bearer token through                    -> "only the eval workflow or a Tex developer" fails
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { handleBench } from "../../../packages/lab/gateway/bench/route.js";
import { benchWorkspaceId } from "../../../packages/lab/gateway/bench/world.js";
import { noteIdOf } from "../../../packages/lab/gateway/bench/world.js";
import { MEANING_MODEL } from "../src/search/meaning/embed.js";
import { namespace, planOf } from "../bench/evals/objectWorld.mjs";
import { fakeAi } from "../bench/models.mjs";
import { hitsOf } from "../bench/search.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";

const WORLD = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";
const GOOD = "eyJhbGciOiJSUzI1NiJ9.eyJ3b3JrZmxvdyI6Im1haW4ifQ.c2ln";

const bench = {
  people: [{ person: "Sam", workspace: "sam", personal: true, role: "owner" }],
  workspaces: {
    sam: {
      files: {
        "trips/kayak-trip.md": "# Kayak trip\n\nPaddles, dry bags and the tide table for the kayak trip.\n",
        "home/boiler.md": "# Boiler\n\nThe boiler service is due in March; the engineer's number is on the fridge.\n",
        "work/quarterly-plan.md": "# Quarterly plan\n\nShip the search bench, then the reranker study.\n",
      },
      heldBack: [],
      generated: [],
    },
  },
};

function harness() {
  const embeds = [];
  const fake = fakeAi();
  const ai = {
    async run(model, input, ...rest) {
      if (model === MEANING_MODEL) embeds.push(...input.text);
      return await fake.run(model, input, ...rest);
    },
  };
  const trap = { idFromName() { throw new Error("a bench call reached a real workspace object"); }, get() { throw new Error("a bench call reached a real workspace object"); } };
  const env = { GATEWAY_SECRET: "real-gateway-secret-0123456789abcdef", CONTROL_PLANE_URL: "https://control.test.invalid", AI: ai, WORKSPACE_STORE: trap };
  env.BENCH_STORE = namespace(env);
  const { ctx, settle } = createWorkerCtx();
  const gateway = async (request, benchEnv) => {
    const response = await worker.fetch(request, benchEnv, ctx);
    await settle();
    return response;
  };
  const verify = async (token) => (token === GOOD ? { claims: {} } : { refused: "not GitHub's" });
  const call = async (body, token = GOOD) => {
    const response = await handleBench(new Request("https://mcp.test/tex-lab/bench", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }), env, ctx, { gateway, verify });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  /** Every object's alarm run until none is armed, as the runtime would. */
  let running = Promise.resolve();
  // One alarm at a time, as the runtime runs an object's alarm: callers queue behind the one running.
  const alarms = () => (running = running.then(runAlarms));
  const runAlarms = async () => {
    for (let pass = 0; pass < 200 && env.BENCH_STORE.alarms.size > 0; pass += 1) {
      for (const name of [...env.BENCH_STORE.alarms.keys()]) {
        env.BENCH_STORE.alarms.delete(name);
        await env.BENCH_STORE.get({ name }).object.alarm();
      }
    }
  };
  return { env, call, alarms, embeds };
}

const quiet = async (fn) => {
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.error = error;
  }
};

async function load(h, copy) {
  const plan = planOf(bench, (name) => benchWorkspaceId(WORLD, copy, name));
  assert.equal((await h.call({ op: "setup", world: WORLD, copy, plan })).status, 200);
  const workspaceId = plan.workspaces[0].workspaceId;
  if (copy === 0) {
    const notes = await Promise.all(Object.entries(bench.workspaces.sam.files).map(async ([path, text]) => ({ key: `notes/${await noteIdOf("sam", path)}.md`, text })));
    assert.equal((await h.call({ op: "notes", world: WORLD, copy, workspaceId, notes })).status, 200);
  } else {
    // A page of one note, so the clone takes several pages.
    assert.equal((await h.call({ op: "clone", world: WORLD, copy, workspaceId, from: benchWorkspaceId(WORLD, 0, "sam"), page: 1 })).status, 200);
  }
  await h.alarms();
  const status = await h.call({ op: "status", world: WORLD, copy, workspaceIds: [workspaceId] });
  return { workspaceId, status: status.body.workspaces[workspaceId] };
}

test("a world is loaded, cloned into a second copy on its alarm, and both copies answer alike; the model embeds each text once", async () => {
  await quiet(async () => {
    const h = harness();
    const first = await load(h, 0);
    assert.equal(first.status.ready, true, JSON.stringify(first.status));
    assert.equal(first.status.notes, 3);
    const embedded = h.embeds.length;
    assert.ok(embedded > 0);
    const second = await load(h, 1);
    assert.equal(second.status.ready, true, JSON.stringify(second.status));
    assert.equal(second.status.notes, 3);
    assert.equal(h.embeds.length, embedded, "the second copy's passages come from the vector cache");

    const ask = async (copy) => (await h.call({ op: "search", world: WORLD, copy, cases: [{ id: "q1", query: "kayak tide table", personal: benchWorkspaceId(WORLD, copy, "sam") }, { id: "q2", query: "boiler engineer", personal: benchWorkspaceId(WORLD, copy, "sam") }] })).body.answers;
    const [a, b] = await Promise.all([ask(0), ask(1)]);
    assert.deepEqual(a.map((x) => x.ok), [true, true], JSON.stringify(a));
    assert.equal(hitsOf(a[0].text, "@sam")[0], "@sam/trips/kayak-trip.md");
    assert.equal(hitsOf(a[1].text, "@sam")[0], "@sam/home/boiler.md");
    assert.deepEqual(b.map((x) => hitsOf(x.text, "@sam")), a.map((x) => hitsOf(x.text, "@sam")));

    // A benchmark's question is asked whole: EnterpriseRAG Notes has questions of 457 characters.
    const long = `When is the kayak trip, and what does the tide table say about ${"the launch window and the weather ".repeat(12)}`;
    assert.ok(long.length > 450);
    const [whole] = (await h.call({ op: "search", world: WORLD, copy: 0, cases: [{ id: "q3", query: long, personal: benchWorkspaceId(WORLD, 0, "sam") }] })).body.answers;
    assert.equal(whole.ok, true, JSON.stringify(whole));
  });
});

test("a call names only its own world's objects", async () => {
  await quiet(async () => {
    const h = harness();
    await load(h, 0);
    // Another world's person, a person of another copy, and cloning from another world are all refused.
    const other = await h.call({ op: "search", world: OTHER, copy: 0, cases: [{ id: "q", query: "kayak", personal: benchWorkspaceId(WORLD, 0, "sam") }] });
    assert.equal(other.status, 400);
    const otherCopy = await h.call({ op: "search", world: WORLD, copy: 1, cases: [{ id: "q", query: "kayak", personal: benchWorkspaceId(WORLD, 0, "sam") }] });
    assert.equal(otherCopy.status, 400);
    const clone = await h.call({ op: "clone", world: WORLD, copy: 1, workspaceId: benchWorkspaceId(WORLD, 1, "sam"), from: benchWorkspaceId(OTHER, 0, "sam") });
    assert.equal(clone.status, 400);
    const real = await h.call({ op: "status", world: WORLD, copy: 0, workspaceIds: ["ws_real_workspace"] });
    assert.equal(real.status, 400);
    const setup = await h.call({ op: "setup", world: WORLD, copy: 0, plan: { workspaces: [{ workspaceId: "ws_real", name: "x", files: [], rules: {}, members: [] }], people: [] } });
    assert.equal(setup.status, 400);
  });
});

test("only the eval workflow or a Tex developer may call", async () => {
  await quiet(async () => {
    const h = harness();
    const none = await handleBench(new Request("https://mcp.test/tex-lab/bench", { method: "POST", body: "{}" }), h.env, {}, { gateway: () => null, verify: async () => ({ refused: "no" }) });
    assert.equal(none.status, 401);
    // A token GitHub did not sign for the bench, and a grant the control plane does not call a Tex developer's.
    assert.equal((await h.call({ op: "status", world: WORLD, copy: 0, workspaceIds: [benchWorkspaceId(WORLD, 0, "sam")] }, "eyJhbGciOiJSUzI1NiJ9.eyJmb3JrIjp0cnVlfQ.c2ln")).status, 403);
    assert.equal((await h.call({ op: "status", world: WORLD, copy: 0, workspaceIds: [benchWorkspaceId(WORLD, 0, "sam")] }, "ctx_at.some.grant")).status, 403);
  });
});

test("a deployment without bench objects answers 501", async () => {
  const response = await handleBench(new Request("https://mcp.test/tex-lab/bench", { method: "POST", body: "{}" }), {}, {}, { gateway: () => null });
  assert.equal(response.status, 501);
});

test("the CLI's remote run loads a world once, deals the cases across its copies and scores the object path", async () => {
  await quiet(async () => {
    const h = harness();
    const { runRemoteSearchCases } = await import("../bench/evals/remoteBench.mjs");
    const ops = [];
    // The objects' alarms run whenever the client looks at a copy's status, as time passing would run them.
    const call = async (body) => {
      ops.push(body.op);
      if (body.op === "status") await h.alarms();
      const { status, body: answer } = await h.call(body);
      if (status !== 200) throw new Error(`${body.op}: ${status} ${JSON.stringify(answer)}`);
      return answer;
    };
    const cases = [
      { id: "q1", query: "kayak tide table", as: "Sam", expect: ["@sam/trips/kayak-trip.md"] },
      { id: "q2", query: "boiler engineer", as: "Sam", expect: ["@sam/home/boiler.md"] },
      { id: "q3", query: "reranker study plan", as: "Sam", expect: ["@sam/work/quarterly-plan.md"] },
    ];
    const records = await runRemoteSearchCases(call, { bench, cases, copies: 3, perCall: 1, log: () => {}, poll: 0 });
    assert.deepEqual(records.map((r) => r.rank), [1, 1, 1], JSON.stringify(records.map((r) => [r.id, r.hits, r.error])));
    assert.deepEqual(records.map((r) => r.object.rank), [1, 1, 1]);
    assert.equal(ops.filter((op) => op === "notes").length, 1, "the notes are sent once, to the first copy");
    assert.equal(ops.filter((op) => op === "clone").length, 2, "the other two copies clone it");
    // A second run of the same world only searches.
    ops.length = 0;
    await runRemoteSearchCases(call, { bench, cases, copies: 3, perCall: 1, log: () => {} });
    assert.deepEqual([...new Set(ops)].sort(), ["search", "status"]);
  });
});

test("a world idle for a week is forgotten and named for dropping; a used one is kept", async () => {
  const { serveWorlds, WORLD_IDLE_MS } = await import("../../../packages/lab/gateway/bench/env.js");
  const sql = namespace({ BENCH_WORLD: true }).get({ name: "registry" }).object.state.storage.sql;
  const ask = async (body, now) => (await (await serveWorlds(sql, new Request("https://bench.internal/", { method: "POST", body: JSON.stringify(body) }), now)).json()).idle;
  assert.deepEqual(await ask({ touch: { world: WORLD, ids: ["a"] } }, 1_000), []);
  assert.deepEqual(await ask({ touch: { world: WORLD, ids: ["b"] } }, 2_000), []);
  assert.deepEqual(await ask({ touch: { world: OTHER, ids: ["c"] } }, 2_000 + WORLD_IDLE_MS), []);
  assert.deepEqual(await ask({ touch: { world: OTHER } }, 3_000 + WORLD_IDLE_MS), [{ world: WORLD, ids: ["a", "b"] }]);
  assert.deepEqual(await ask({}, 3_000 + WORLD_IDLE_MS), [], "forgotten once named");
});
