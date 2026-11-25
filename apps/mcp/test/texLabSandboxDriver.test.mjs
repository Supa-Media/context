// The Lab sandbox bench's driver (scripts/tex-lab-sandbox-bench.mjs): which gateway a run goes to, how it pumps a job
// and resumes one that stopped, and how it ends a run with the GitHub run's own rules (`tex-lab-run.mjs` `unrun`,
// `brokenRun`, `resultsOf`). The job is the gateway's own job code (`benchJob.js`) over an in-memory SQLite; no model
// and no network is called. Fake ids only.
//
// Sabotage (temporary local edits, reverted, 2026-11-24):
//   pump without its first pass over units that turned but were never judged   "a driver that died ..." fails

import { test } from "node:test";
import assert from "node:assert/strict";

import { benchTables } from "../../../packages/lab/gateway/labSandbox/benchJob.js";
import { finishOf, gatewaysOf, pump } from "../../../scripts/tex-lab-sandbox-bench.mjs";
import { durableSql } from "./texStoreFixture.mjs";

const RUN = "r".repeat(20);
const ENV = { LAB_GATEWAY_URL: "https://gateway.example.invalid/", LAB_TOKEN: "tok-main-example", LAB_PREVIEW_WORKERS_DEV: "example.workers.dev", LAB_PREVIEW_TOKEN: "tok-preview-example" };

test("a run is recorded on main's gateway; its turns go to main or to the pull request's preview", () => {
  const main = gatewaysOf("main", ENV);
  assert.equal(main.job.origin, "https://gateway.example.invalid");
  assert.equal(main.record, main.job);
  const pr = gatewaysOf("pr3747", ENV);
  assert.equal(pr.record.origin, "https://gateway.example.invalid", "recorded on main");
  assert.equal(pr.job.origin, "https://context-mcp-pr3747.example.workers.dev", "turns on the preview (deploy-preview.yml's name)");
  assert.equal(pr.job.token, "tok-preview-example");
  assert.throws(() => gatewaysOf("staging", ENV), /main or pr<N>/);
  assert.throws(() => gatewaysOf("pr1", { ...ENV, LAB_PREVIEW_TOKEN: "" }), /LAB_PREVIEW_TOKEN/);
  assert.throws(() => gatewaysOf("main", { LAB_GATEWAY_URL: "http://x" }), /LAB_GATEWAY_URL/);
});

/** The gateway's bench ops over the real job tables: a turn a step, `budget` texts before a 429. */
function fakeGateway({ units, budget = Infinity }) {
  const job = benchTables(durableSql());
  job.serve("bench.init", { job: { runId: RUN }, convs: [{ id: "c", kind: "one", msgs: [] }], units });
  let steps = 0;
  const ok = (body) => ({ status: 200, body });
  const call = async (input) => {
    switch (input.op) {
      case "bench_status":
        return ok(job.serve("bench.status", {}));
      case "bench_conv":
        return ok(job.serve("bench.conv", { id: input.convId }));
      case "bench_turn":
        return ok(job.serve("bench.get", { i: input.i }));
      case "bench_row":
        return ok(job.serve("bench.row", { i: input.i, row: input.row }));
      case "bench_step": {
        const claimed = job.serve("bench.claim", { staleMs: 60_000 });
        if (claimed.claimed === null) return ok({ done: claimed.counts.pending === 0 && claimed.counts.running === 0, counts: claimed.counts });
        if (steps >= budget) {
          job.serve("bench.release", { i: claimed.claimed.i });
          return { status: 429, body: { budget: true } };
        }
        steps += 1;
        const turn = { ran: true, said: [`answer ${claimed.claimed.i}`] };
        job.serve("bench.turn", { i: claimed.claimed.i, turn });
        return ok({ i: claimed.claimed.i, unit: claimed.claimed.unit, turn });
      }
      default:
        return { status: 400, body: {} };
    }
  };
  return { call, job, steps: () => steps };
}

const UNITS = [0, 1, 2].map((rep) => ({ chat: "c", msg: "m1", at: 0, node: "fd", rep }));
const judged = ({ unit, turn }) => ({ chat: unit.chat, msg: unit.msg, at: unit.at, node: "fd", rep: unit.rep, right: true, ran: true, usd: 0, said: turn.said });

test("a driver that died between a turn and its row resumes: the kept turn is judged, never run again", async () => {
  const gw = fakeGateway({ units: UNITS });
  let calls = 0;
  const dies = async (args) => {
    calls += 1;
    if (calls === 2) throw new Error("the driver's machine went away");
    return judged(args);
  };
  await assert.rejects(pump({ job: gw.call, runId: RUN, judge: dies }), /went away/);
  assert.equal(gw.steps(), 2, "two turns ran, the second was never judged");
  const again = await pump({ job: gw.call, runId: RUN, judge: async (args) => judged(args) });
  assert.equal(again.done, true);
  assert.equal(gw.steps(), 3, "the kept turn was judged from the job; only the unit never run took a turn");
  assert.deepEqual(gw.job.serve("bench.rows", {}).rows.map((r) => r.rep), [0, 1, 2]);
});

test("a spent sandbox bench budget stops the driver with the run resumable, not failed", async () => {
  const gw = fakeGateway({ units: UNITS, budget: 1 });
  const first = await pump({ job: gw.call, runId: RUN, judge: async (args) => judged(args), parallel: 2 });
  assert.equal(first.budget, true);
  assert.equal(first.done, false);
  assert.equal(first.counts.judged, 1);
  assert.equal(first.counts.pending, 2, "the refused units wait for tomorrow");
});

test("a sandbox run ends by the GitHub run's own rules: a step that ran nothing or Claude out of credit fails it", () => {
  const row = (fields) => ({ chat: "c", msg: "m1", at: 0, node: "fd", rep: 0, ...fields });
  const none = finishOf([row({ ran: false, right: false, why: "could not run: the sandbox bench runs texted words only: pictures" })], 10, []);
  assert.equal(none.stage, "failed");
  assert.match(none.error, /none of fd's 1 tests could run/);
  const credit = finishOf([row({ ran: true, right: true }), row({ rep: 1, ran: false, right: false, why: "could not run: credit balance is too low" })], 10, []);
  assert.equal(credit.stage, "failed");
  assert.match(credit.error, /credit/);
  const done = finishOf([row({ ran: true, right: true, fallbacks: 1 })], 10, []);
  assert.equal(done.stage, "done");
  assert.equal(done.results.valid, false, "a fallback marks the run invalid, as on GitHub");
  assert.equal(done.results.fallbacks, 1);
});
