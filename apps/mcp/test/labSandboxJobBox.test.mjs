// A Lab test chat's job on a real job box (packages/lab/gateway/labSandbox/jobBox.js; 2026-11-21: the job box's memory
// fix and its own alarm could not be tried in the Lab, since a test chat's jobs ran in memory with their alarm off).
//
// What these prove: with the `LAB_JOB` binding, a job a test text starts is born in its own `TexJob` box (the gateway's
// class, given the Lab fence), held until the text's answer is in; the box's own alarm runs its passes (`jobDrive.ts`);
// its turn leaves the box and is answered on the test chat's fences; every pass is a step on the run card with the
// box's pass and tries, and the job's report arrives as a Tex row from the job; the box is deleted when the run ends;
// a box whose run is gone is answered "gone" and deletes itself; a birth without its test chat and run makes nothing;
// and a deployment without the binding keeps the jobs in memory. Fake ids, numbers and words only.
//
// Sabotage (temporary local edits, reverted, 2026-11-21):
//   1. `sandboxInboxes` ignoring `makeBox` (jobs in memory again): "is born in its own box" fails (no box made).
//   2. `labJobFence.alarm` never deleting: "deletes everything" and "a box whose run is gone" fail.
//   3. The held start sent at birth instead of in `runJobs`: "held until the answer" fails (the job's turn asked first).
//   4. `plain` keeping the box's run ids as they are: "a box's runs travel with ids of its own" fails.

import { test } from "node:test";
import assert from "node:assert/strict";

import { LabSandboxObject } from "../../../packages/lab/gateway/labSandbox/object.js";
import { runChatTurn, MemoryStorage } from "../../../packages/lab/gateway/labSandbox/chatRun.js";
import { labJobFence, plain, LAB_KEY, LAB_RUN_HEADER, LAB_SANDBOX_HEADER } from "../../../packages/lab/gateway/labSandbox/jobBox.js";
import { PHOTON_NUMBER } from "../../../packages/lab/gateway/labSandbox/line.js";
import { texJobClass, BORN_KEY } from "../../../packages/tex/gateway/texJob.js";
import { streamTurn, wantsProgress } from "../../../packages/tex/gateway/agent/progress.js";
import { eventEntry } from "../../../packages/tex/gateway/agent/ledger.js";
import { durableSql } from "./texStoreFixture.mjs";

const LINE = { name: "photon", number: PHOTON_NUMBER, inMs: 0, outMs: 0, measured: { in: 0, out: 0 } };
const ONE = { kind: "one", owner: "person:ws_a", ledgerChat: "texts", people: [{ handle: "ana", name: "You" }], line: LINE, sandboxId: "0123456789abcdef", origin: "https://gateway.example.invalid" };
const SANDBOX = `labsandbox:u_alice:${ONE.sandboxId}`;
const LabJob = texJobClass({ gateway: () => ({ fetch: async () => new Response(null, { status: 500 }) }), texts: () => ({ fetch: async () => new Response(null, { status: 500 }) }), fence: labJobFence });

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Test chats' objects over in-memory SQLite, by name, as `LAB_SANDBOX`. */
function sandboxes() {
  const made = new Map();
  const object = (name) => {
    if (!made.has(name)) made.set(name, new LabSandboxObject({ storage: { sql: durableSql(), setAlarm: async () => {}, deleteAlarm: async () => {}, deleteAll: async () => {} } }));
    return made.get(name);
  };
  return { idFromName: (name) => ({ name }), get: (id) => ({ fetch: (request) => object(id.name).fetch(request) }) };
}

/**
 * Job boxes as `LAB_JOB`: each a real `LabJob` on storage in memory whose alarm Cloudflare-style fires on its own when
 * due (one at a time, never two alarms at once), with a log of every alarm it ran.
 */
function boxes(env) {
  const made = new Map();
  const object = (name) => {
    if (made.has(name)) return made.get(name).box;
    const storage = new MemoryStorage();
    const kept = { storage, alarms: 0, running: null, timer: null };
    const fire = () => {
      kept.timer = null;
      kept.running = (async () => {
        await kept.running;
        if (storage.alarm === null || storage.alarm > Date.now()) return schedule();
        storage.alarm = null;
        kept.alarms += 1;
        await kept.box.alarm();
      })().finally(schedule);
    };
    const schedule = () => {
      if (kept.timer !== null || storage.alarm === null) return;
      kept.timer = setTimeout(fire, Math.max(0, storage.alarm - Date.now()));
    };
    const setAlarm = storage.setAlarm.bind(storage);
    storage.setAlarm = async (at) => {
      await setAlarm(at);
      if (kept.timer !== null) clearTimeout(kept.timer);
      kept.timer = null;
      schedule();
    };
    const state = { storage, id: { toString: () => `box-${made.size}` }, waitUntil: () => {}, blockConcurrencyWhile: (run) => run() };
    kept.box = new LabJob(state, env);
    made.set(name, kept);
    return kept.box;
  };
  return { made, idFromName: (name) => ({ name }), get: (id) => ({ fetch: (request) => object(id.name).fetch(request) }) };
}

async function world() {
  const env = { LAB_SANDBOX: sandboxes() };
  env.LAB_JOB = boxes(env);
  const stub = env.LAB_SANDBOX.get(env.LAB_SANDBOX.idFromName(SANDBOX));
  const call = async (op, body = {}) => (await stub.fetch(new Request(`https://lab-sandbox.internal/${op}`, { method: "POST", body: JSON.stringify(body) }))).json();
  await call("init", { about: ONE, rows: [], history: [] });
  return { env, stub, call };
}

/** `/agent` as a gateway answers it: the text's turn starts a job, whose own turn finds caterers, and its report texts. */
function jobGateway(call, rowId) {
  const asked = [];
  const agentRoute = async (request, path) => {
    const body = await request.json().catch(() => ({}));
    asked.push({ path, job: Boolean(body.job), event: body.event ?? null });
    if (path === "/agent") {
      const answer = body.job
        ? { answer: "Three caterers: Ana's Kitchen, Blue Fig, Olive.", turn: body.turn ?? "j" }
        : body.event === "job_report"
          ? { answer: "Found three caterers: Ana's Kitchen, Blue Fig and Olive.", turn: body.turn ?? "r" }
          : { answer: "On it: looking for caterers now.", turn: body.turn ?? "t", jobs: [{ id: "job0caterers1", title: "Find caterers", brief: "Three caterers near Ana.", doneWhen: "three caterers" }] };
      const reply = () => Response.json(answer);
      return wantsProgress(request) ? streamTurn(async () => reply()) : reply();
    }
    if (path === "/agent/events") {
      await call("ledger.append", { entries: (body.events ?? []).map(eventEntry), by: rowId });
      return Response.json({ written: [...new Set((body.events ?? []).map((e) => e.id))] });
    }
    return Response.json({ events: [] });
  };
  const textsRoute = async (request) => (new URL(request.url).pathname === "/texts/old-line" ? Response.json({ to: "pass" }) : Response.json({ error: "unknown_route" }, { status: 404 }));
  return { asked, agentRoute, textsRoute };
}

const sleep = async () => tick();

test("a test text's job is born in its own box, held until the answer, run by the box's alarm, and every pass is a step", async () => {
  const w = await world();
  const row = { id: "t1", who: "ana", text: "find us a caterer for Saturday", at: Date.now(), prod: false, eid: "0000000000001-000001" };
  await w.call("row.add", { row });
  const gw = jobGateway(w.call, row.id);
  await runChatTurn({ env: w.env, stub: w.stub, about: ONE, row, payload: { defaultWorkspaceId: "ws_a" }, token: "caller-token", config: null, origin: ONE.origin, agentRoute: gw.agentRoute, textsRoute: gw.textsRoute, sleep, sandbox: SANDBOX });

  // Born in its own box, under its test chat, text and job, and run by that box's own alarm.
  assert.equal(w.env.LAB_JOB.made.size, 1, "one job box was made");
  const [[name, box]] = [...w.env.LAB_JOB.made.entries()];
  assert.equal(name, `${SANDBOX}/t1/job:job0caterers1`);
  assert.ok(box.alarms >= 1, `the box's own alarm ran its passes (${box.alarms})`);
  // Held until the answer: the text's own turn was asked before the job's.
  const turns = gw.asked.filter((a) => a.path === "/agent");
  assert.equal(turns[0].job, false, "the text's turn came first");
  assert.ok(turns.some((a) => a.job), "the job's turn was asked, from its box");

  const state = await w.call("state");
  const reply = state.rows.find((r) => r.id === "t1r");
  assert.equal(reply.text, "On it: looking for caterers now.");
  const jobRows = state.rows.filter((r) => r.from === "job");
  assert.ok(jobRows.length >= 1, `the job's report arrived (${state.rows.map((r) => `${r.id}:${r.from ?? ""}:${r.text}`).join(" | ")})`);
  assert.match(jobRows[0].text, /caterers/i);
  // Every pass is a step: the job node, a background step, with the box's pass and tries, distinct from the turn's.
  const passes = reply.steps.filter((s) => s.node === "job");
  assert.ok(passes.length >= 1, "a pass is on the run card");
  assert.ok(passes.every((s) => s.bg && s.in?.box?.on === "LabJob" && Number.isInteger(s.in.box.pass)), JSON.stringify(passes.map((s) => s.in)));
  assert.ok(new Set(reply.steps.map((s) => s.id)).size === reply.steps.length, "step ids are unique");
  const chain = jobRows[0].cause.map((id) => reply.steps.find((s) => s.id === id)?.node);
  assert.ok(chain.includes("job"), `the pass is on the report's cause (${chain.join(" → ")})`);
  // Said in the test chat's changes, and the box is deleted once the run is over.
  assert.ok(state.writes.some((wr) => /own job box \(LabJob/.test(wr.summary)), "the box's run is listed");
  for (let i = 0; i < 200 && box.storage.data.size > 0; i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.equal(box.storage.data.size, 0, "the box deleted everything it kept");
  assert.equal(state.meta.running, undefined, "nothing left running");
});

test("a box whose run is gone is answered gone and deletes itself on its next alarm", async () => {
  const w = await world();
  const box = w.env.LAB_JOB.get({ name: "lost" });
  const start = new Request("https://inbox/job-start", {
    method: "POST",
    headers: { "x-inbox-name": "job:lost0001", [LAB_SANDBOX_HEADER]: SANDBOX, [LAB_RUN_HEADER]: "0".repeat(48) },
    body: JSON.stringify({ id: "lost0001", title: "Lost", brief: "nothing", inbox: "+15555550101", origin: { kind: "one" }, attempt: 1, tries: 0, startedAt: Date.now() }),
  });
  // Its inner object cannot even be set up: the run it names is not held here, so the start fails and the box is marked.
  await assert.rejects(box.fetch(start), /run is over \(410\)/);
  const kept = w.env.LAB_JOB.made.get("lost");
  for (let i = 0; i < 300 && kept.storage.data.size > 0; i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.equal(kept.storage.data.size, 0, "nothing left of the box");
});

test("a box born without its test chat and run makes nothing", async () => {
  const w = await world();
  const box = w.env.LAB_JOB.get({ name: "bare" });
  const answer = await box.fetch(new Request("https://inbox/job-start", { method: "POST", headers: { "x-inbox-name": "job:bare0001" }, body: "{}" }));
  assert.equal(answer.status, 400);
  const kept = w.env.LAB_JOB.made.get("bare");
  assert.equal(await kept.storage.get(BORN_KEY), undefined);
  assert.equal(await kept.storage.get(LAB_KEY), undefined);
});

test("without the LAB_JOB binding a test chat's jobs still run in memory", async () => {
  const w = await world();
  const row = { id: "t1", who: "ana", text: "find us a caterer for Saturday", at: Date.now(), prod: false, eid: "0000000000001-000001" };
  await w.call("row.add", { row });
  const gw = jobGateway(w.call, row.id);
  const env = { LAB_SANDBOX: w.env.LAB_SANDBOX };
  await runChatTurn({ env, stub: w.stub, about: ONE, row, payload: { defaultWorkspaceId: "ws_a" }, token: "caller-token", config: null, origin: ONE.origin, agentRoute: gw.agentRoute, textsRoute: gw.textsRoute, sleep, sandbox: SANDBOX });
  assert.equal(w.env.LAB_JOB.made.size, 0);
  const state = await w.call("state");
  assert.ok(state.rows.some((r) => r.from === "job"), "its job reported");
  const pass = state.rows.find((r) => r.id === "t1r").steps.find((s) => s.node === "job");
  assert.equal(pass.in?.box, undefined, "a pass in memory names no box");
});

test("a box's runs travel with ids of its own, since every isolate counts its runs from r1", () => {
  const box = { on: "LabJob", pass: 2, tries: 1 };
  const pass = plain({ id: "r1", node: "job", input: { step: "pass", jobId: "j1" }, via: "TexJob", error: new Error("boom") }, box, "box:j1:");
  assert.equal(pass.id, "box:j1:r1");
  assert.equal(pass.parent, undefined);
  assert.deepEqual(pass.input, { step: "pass", jobId: "j1", box });
  assert.equal(pass.error, "boom");
  const inner = plain({ id: "r2", parent: "r1", node: "jobCheck", input: { x: 1 } }, box, "box:j1:");
  assert.equal(inner.parent, "box:j1:r1");
  assert.deepEqual(inner.input, { x: 1 }, "only the job node's input names the box");
});
