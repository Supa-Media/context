// A whole Training or Dev set scored in the Lab sandbox (packages/lab/gateway/labSandbox/benchJob.js, benchTurn.js,
// benchRoute.js; plan products/tex/research/sandbox-bench-scoring-2026-11-19.md).
//
// What these prove: a run's job is one object that keeps progress per unit and resumes (a dead step's unit is claimed
// again, a second turn or row for a unit is ignored, the same start twice changes nothing); every bench text draws from
// the sandbox bench's own budget and never from the person's 200 test texts a day, whose cap and counter are
// unchanged; a unit that is not texted words is a row that could not run, never a guess; a turn's fallback steps come
// back for the driver to count with the GitHub run's own code; and a bench leaves no test chat behind. Fake ids only.
//
// Sabotage (temporary local edits, reverted, 2026-11-24):
//   benchRoute.js `takeBenchText` counting `sends:<day>` on the person's index   "bench texts draw from ..." fails
//   benchJob.js `bench.turn` taking a turn in any state                          "a unit's first turn wins ..." fails
//   benchTurn.js `runBenchUnit` without its `finally` reset                      "the route walks a set ..." fails

import { test } from "node:test";
import assert from "node:assert/strict";

import { LabSandboxObject } from "../../../packages/lab/gateway/labSandbox/object.js";
import { BENCH_DAILY_TEXTS, benchDailyTexts, benchJobName, benchTables } from "../../../packages/lab/gateway/labSandbox/benchJob.js";
import { notWords, turnOf } from "../../../packages/lab/gateway/labSandbox/benchTurn.js";
import { DAILY_SENDS, handleLabSandbox } from "../../../packages/lab/gateway/labSandbox/route.js";
import { benchUnits, runConversations } from "../../../packages/lab/src/labRunSets.mjs";
import { stepEntry } from "../../../packages/tex/gateway/agent/ledger.js";
import REPO from "../../../packages/lab/src/texSetsRepo.generated.json" with { type: "json" };
import { durableSql } from "./texStoreFixture.mjs";

const RUN = "k".repeat(24);
const TOKEN = "tok_ana_example_0000000000000";
const DAY = new Date().toISOString().slice(0, 10);
// A Training 1:1 with three Front door tests, one of which is not texted words (a trigger, a tapback or pictures).
const CONV = "harbour-bounce";

test("the person's test texts a day are still 200, and the bench's budget is its own setting", () => {
  assert.equal(DAILY_SENDS, 200, "the person cap is unchanged");
  assert.equal(benchDailyTexts({}), BENCH_DAILY_TEXTS);
  assert.equal(benchDailyTexts({ LAB_BENCH_DAILY_TEXTS: "40" }), 40);
  assert.equal(benchDailyTexts({ LAB_BENCH_DAILY_TEXTS: "lots" }), BENCH_DAILY_TEXTS);
  assert.equal(benchJobName("u_ana", RUN), `labsandbox:u_ana:bench-${RUN}`, "a job is the person's own object");
});

test("a bench job keeps progress per unit: start once, claim in order, a dead step's unit claimed again, first turn and row win", () => {
  let clock = 1_000_000;
  const job = benchTables(durableSql(), { now: () => clock });
  const units = [{ chat: "c", msg: "m1", at: 0, node: "fd", rep: 0 }, { chat: "c", msg: "m1", at: 0, node: "fd", rep: 1 }];
  assert.equal(job.serve("bench.init", { job: { runId: RUN }, convs: [{ id: "c", msgs: [] }], units }).existing, false);
  assert.equal(job.serve("bench.init", { job: { runId: RUN }, convs: [], units: [] }).existing, true, "the same run again changes nothing");
  assert.throws(() => job.serve("bench.init", { job: { runId: "z".repeat(24) }, convs: [], units }), /another bench run/);

  const first = job.serve("bench.claim", { staleMs: 60_000 }).claimed;
  assert.equal(first.i, 0);
  assert.equal(job.serve("bench.claim", { staleMs: 60_000 }).claimed.i, 1);
  assert.equal(job.serve("bench.claim", { staleMs: 60_000 }).claimed, null, "nothing pending, nothing stale");
  clock += 61_000;
  assert.equal(job.serve("bench.claim", { staleMs: 60_000 }).claimed.i, 0, "a unit whose step died is claimed again");

  assert.throws(() => job.serve("bench.row", { i: 0, row: { right: true } }), /has not turned/);
  assert.equal(job.serve("bench.turn", { i: 0, turn: { ran: true, said: ["one"] } }).ok, true);
  assert.equal(job.serve("bench.turn", { i: 0, turn: { ran: true, said: ["two"] } }).ok, false, "a unit's first turn wins");
  assert.deepEqual(job.serve("bench.get", { i: 0 }).turn.said, ["one"]);
  assert.equal(job.serve("bench.row", { i: 0, row: { right: true } }).ok, true);
  assert.equal(job.serve("bench.row", { i: 0, row: { right: false } }).ok, false, "a unit's first row wins");
  assert.deepEqual(job.serve("bench.rows", {}).rows, [{ right: true }]);

  job.serve("bench.release", { i: 1 });
  assert.equal(job.serve("bench.status", {}).counts.pending, 1, "a released claim waits again");
  assert.equal(job.serve("bench.finish", { stage: "done" }).stage, "done");
  assert.equal(job.serve("bench.finish", { stage: "failed" }).unchanged, true, "a finished job stays finished");
});

test("the bench budget counts its own texts a day and stops at its max", () => {
  const budget = benchTables(durableSql());
  assert.equal(budget.serve("bench.budget", { day: DAY, max: 2 }).ok, true);
  assert.equal(budget.serve("bench.budget", { day: DAY, max: 2 }).ok, true);
  assert.equal(budget.serve("bench.budget", { day: DAY, max: 2 }).ok, false);
  assert.equal(budget.serve("bench.budget", { day: "2099-01-01", max: 2 }).ok, true, "a new day is a new count");
});

test("only texted words run in the sandbox bench; a turn reads back Tex's texts, tools, usage and fallback steps", () => {
  assert.equal(notWords({ text: "hi" }), null);
  assert.match(notWords({ text: "", via: "routine" }), /routine trigger/);
  assert.match(notWords({ text: "👍", kind: "react" }), /a react/);
  assert.match(notWords({ text: "look", pics: [{ url: "x" }] }), /pictures/);
  assert.equal(notWords({ text: "and october?", kind: "reply", to: "m9" }), null, "a quoted reply is texted words");
  const row = { id: "t1", at: 5 };
  const state = {
    rows: [{ id: "p1", who: "You", text: "before", prod: true }, { id: "t1", who: "You", text: "hi" }, { id: "t1r", reply: "t1", who: "Tex", text: "a\n\nb", parts: ["a", "b"], steps: [{ model: "claude-sonnet-5-5", tokIn: 100, tokOut: 20, calls: [{ tool: "search", d: "q" }, { tool: "read", d: "x (failed)" }] }] }],
    writes: [{ by: "t1", kind: "note", title: "notes/a.md" }, { by: "t0", kind: "note", title: "older" }],
  };
  const entries = [stepEntry({ step: "fallback", model: "glm", input: { from: "claude-sonnet-5-5", status: 529 } }), stepEntry({ step: "router", input: {} })];
  const turn = turnOf(state, row, entries, 12);
  assert.deepEqual(turn.said, ["a", "b"]);
  assert.deepEqual(turn.tools, [{ tool: "search", ok: true }, { tool: "read", ok: false }]);
  assert.deepEqual(turn.usage, [{ model: "claude-sonnet-5-5", input: 100, output: 20 }]);
  assert.deepEqual(turn.changes, [{ kind: "note", title: "notes/a.md" }]);
  assert.deepEqual(turn.fallbacks, [{ kind: "step", step: "fallback", model: "glm", input: { status: 529 } }]);
  const failed = turnOf({ rows: [...state.rows.slice(0, 2), { id: "t1r", reply: "t1", who: "Tex", text: "", quiet: true, error: "boom" }] }, row, [], 3);
  assert.equal(failed.ran, false);
  assert.match(failed.error, /boom/);
});

/** The route over in-memory objects, a control plane that knows one Tex developer, and a fake turn. */
function benchWorld({ env: extra = {}, runTurn } = {}) {
  const objects = new Map();
  const object = (name) => {
    if (!objects.has(name)) objects.set(name, new LabSandboxObject({ storage: { sql: durableSql(), setAlarm: async () => {}, deleteAlarm: async () => {}, deleteAll: async () => {} } }, env));
    return objects.get(name);
  };
  const env = { LAB_SANDBOX: { idFromName: (name) => ({ name }), get: (id) => ({ fetch: (request) => object(id.name).fetch(request) }) }, CONTROL_PLANE_URL: "https://control.example.invalid", GATEWAY_SECRET: "gw-secret-example-not-real-000000", ...extra };
  const dev = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const answer = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    if (body.accessToken !== TOKEN) return answer({ status: "refused" });
    if (String(url).endsWith("/gateway/tex/dev")) {
      dev.push({ action: body.action, args: body.args });
      if (body.action === "sandbox_run") return answer({ status: "ok", id: RUN });
      if (body.action === "sandbox_report") return answer({ status: "ok" });
      return answer({ status: "bad_request" });
    }
    if (!String(url).endsWith("/gateway/tex/lab-sandbox")) return answer({ status: "refused" });
    if (body.action === "who") return answer({ status: "ok", userId: "u_ana", chats: [] });
    if (body.action === "sets") return answer({ status: "ok", drafts: [] });
    if (body.action === "set") return answer({ status: "not_found" });
    if (body.action === "session") {
      const session = { grantId: "g1", clientId: "context_texts", actorUserId: "u_ana", scopes: ["context:read"], defaultWorkspaceId: "ws_ana", workspaces: [{ workspaceId: "ws_ana", role: "owner", kind: "personal", slug: "ana" }] };
      return answer({ status: "ok", session, people: [{ handle: "ana", name: "You" }] });
    }
    return answer({ status: "not_found" });
  };
  const call = async (body) => {
    const response = await handleLabSandbox(new Request("https://gateway.example.invalid/tex-lab/sandbox", { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) }), env, null, { runTurn });
    return { status: response.status, body: await response.json() };
  };
  const index = async () => (await object("labsandbox:u_ana:index0000000000").fetch(new Request("https://lab-sandbox.internal/state", { method: "POST", body: "{}" }))).json();
  return { call, dev, objects, object, index, restore: () => (globalThis.fetch = original) };
}

/** A turn as the Lab's runs one ends: Tex's reply row, a fallback step in the text's ledger, the chat released. */
async function fakeTurn({ stub, row }) {
  const post = (op, body) => stub.fetch(new Request(`https://lab-sandbox.internal/${op}`, { method: "POST", body: JSON.stringify(body) }));
  await post("ledger.append", { entries: [stepEntry({ step: "fallback", model: "glm-example", input: { from: "claude-sonnet-5-5", status: 529 } })], by: row.id });
  await post("row.add", { row: { id: `${row.id}r`, reply: row.id, who: "Tex", text: `heard: ${row.text.slice(0, 20)}`, at: Date.now(), prod: false, steps: [{ model: "claude-sonnet-5-5", tokIn: 1000, tokOut: 50, calls: [{ tool: "search", d: "q" }] }] } });
  await post("release", { msgId: row.id });
  return { cross: [] };
}

test("the route walks a set in its own job: units as the GitHub run picks them, a turn a step, no test chat left, the person's count untouched", async () => {
  const w = benchWorld({ runTurn: fakeTurn });
  try {
    const recorded = await w.call({ op: "bench_record", set: "training", convId: CONV, repeats: 2 });
    assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
    assert.equal(recorded.body.runId, RUN);
    assert.deepEqual(w.dev[0], { action: "sandbox_run", args: { draft: "main", kind: "chat", conv: CONV, set: "training", repeats: 2 } });

    const want = benchUnits(runConversations("training", REPO.sets, [], CONV), 2);
    const started = await w.call({ op: "bench_start", runId: RUN, set: "training", convId: CONV, repeats: 2 });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.units, want.length);
    assert.equal((await w.call({ op: "bench_start", runId: RUN, set: "training", convId: CONV, repeats: 2 })).body.existing, true, "a second start changes nothing");

    const turns = [];
    for (let k = 0; k < want.length + 1; k++) {
      const step = await w.call({ op: "bench_step", runId: RUN });
      assert.equal(step.status, 200, JSON.stringify(step.body));
      if (step.body.done !== undefined) {
        assert.equal(step.body.done, true);
        break;
      }
      turns.push(step.body);
    }
    assert.equal(turns.length, want.length, "one turn a unit");
    const ran = turns.filter((t) => t.turn.ran);
    const out = turns.filter((t) => !t.turn.ran);
    assert.ok(ran.length > 0 && out.length > 0, "this conversation has texted words and a unit that is not");
    for (const t of out) assert.match(t.turn.error, /texted words only/);
    for (const t of ran) {
      assert.equal(t.turn.said.length, 1);
      assert.deepEqual(t.turn.fallbacks.map((f) => f.input.status), [529], "the turn's fallback step comes back for the driver to count");
      assert.deepEqual(t.turn.usage, [{ model: "claude-sonnet-5-5", input: 1000, output: 50 }]);
    }
    assert.deepEqual(turns.map((t) => t.i), want.map((u) => u.i), "in the GitHub run's unit order");

    // Each bench text took the bench's budget, and none the person's: their `sends:<day>` count was never raised.
    const budget = await w.object("labsandbox:bench:budget").fetch(new Request("https://lab-sandbox.internal/bench.budget", { method: "POST", body: JSON.stringify({ day: DAY, max: 0 }) })).then((r) => r.json());
    assert.equal(budget.n, ran.length, "every texted unit took one bench text, and a unit that is not words none");
    const index = await w.index();
    assert.equal(index.meta?.[`sends:${DAY}`], undefined, "the person's test texts a day are untouched");
    assert.deepEqual(Object.keys(index.meta ?? {}).filter((k) => k.startsWith("sb:")), [], "no bench test chat left on the person's list");

    const row = await w.call({ op: "bench_row", runId: RUN, i: ran[0].i, row: { chat: CONV, right: true } });
    assert.equal(row.body.ok, true);
    const reported = await w.call({ op: "bench_report", runId: RUN, stage: "done", results: { pass: 1, total: 1 } });
    assert.equal(reported.status, 200);
    assert.equal(w.dev.at(-1).action, "sandbox_report");
    assert.equal(w.dev.at(-1).args.id, RUN);
  } finally {
    w.restore();
  }
});

test("bench texts draw from the bench budget, not the person cap: a spent budget stops the bench, a spent person cap does not", async () => {
  const w = benchWorld({ env: { LAB_BENCH_DAILY_TEXTS: "1" }, runTurn: fakeTurn });
  try {
    // The person has used all 200 of today's test texts; the bench still runs.
    const indexObject = w.object("labsandbox:u_ana:index0000000000");
    for (let k = 0; k < DAILY_SENDS; k++) await indexObject.fetch(new Request("https://lab-sandbox.internal/count", { method: "POST", body: JSON.stringify({ key: `sends:${DAY}`, max: DAILY_SENDS }) }));
    const full = await indexObject.fetch(new Request("https://lab-sandbox.internal/count", { method: "POST", body: JSON.stringify({ key: `sends:${DAY}`, max: DAILY_SENDS }) })).then((r) => r.json());
    assert.equal(full.ok, false, "the person cap is spent");

    await w.call({ op: "bench_start", runId: RUN, set: "training", convId: CONV, repeats: 1 });
    const skipped = await w.call({ op: "bench_step", runId: RUN });
    assert.equal(skipped.body.turn.ran, false, "this conversation's first Front door test is not texted words, and takes no budget");
    const first = await w.call({ op: "bench_step", runId: RUN });
    assert.equal(first.status, 200, "the bench is not stopped by the person's cap");
    assert.equal(first.body.turn.ran, true);
    const second = await w.call({ op: "bench_step", runId: RUN });
    assert.equal(second.status, 429, "the bench's own budget of 1 is spent");
    assert.equal(second.body.budget, true);
    const status = await w.call({ op: "bench_status", runId: RUN });
    assert.equal(status.body.counts.running, 0, "the refused unit was given back");
    assert.equal(status.body.counts.turned, 2);
    assert.equal((await w.index()).meta[`sends:${DAY}`], DAILY_SENDS, "the person's count is where they left it");
  } finally {
    w.restore();
  }
});

test("bench ops are a Tex developer's own: another caller's run id reaches only their own object, and a bad id is refused", async () => {
  const w = benchWorld({ runTurn: fakeTurn });
  try {
    assert.equal((await w.call({ op: "bench_status", runId: "../other" })).status, 400);
    const status = await w.call({ op: "bench_step", runId: "q".repeat(24) });
    assert.equal(status.status, 404, "a run nobody started here has no job");
    assert.ok([...w.objects.keys()].every((name) => !name.includes("bench-") || name.startsWith("labsandbox:u_ana:bench-")), "jobs are named by the caller's own id");
  } finally {
    w.restore();
  }
});
