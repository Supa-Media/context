/**
 * The background job's node (`graph/nodes/job.js`) on the gateway's runner, its lend handles (`graph/jobHandles.js`),
 * the borrowing bridges (`graph/bridges.js` `jobCheckFor`, over the Job advisor's `check` role, and `handbackFor`), and the job object that runs a pass through
 * the node (`src/texJob.js`, `src/texJobLog.js`).
 *
 * Sabotage record (run 2026-11-14, each break reverted before the next):
 *   1. `returnJob` removed from the node's finally (the lend is never given back): "the lend is cleared after a throw"
 *      and "the lend is cleared after a pass" fail.
 *   2. `withLend` in texGraph.cjs ignoring the lend: texGraph.test.mjs "a lend given to uses or job reaches ..." and
 *      "handbackFor judges over the job node's handback wire" fail (the handback judge's ctx is the lend).
 *   3. The job node's non-ok check removed: "an answer that is not ok fails the node" fails.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { gatewayGraph } from "../src/agent/graph/gatewayGraph.js";
import { job } from "../src/agent/graph/nodes/job.js";
import { borrowJob, lendJob, returnJob } from "../src/agent/graph/jobHandles.js";
import { jobCheckFor, handbackFor } from "../src/agent/graph/bridges.js";
import { TEX_CONFIG } from "../src/agent/texConfig.js";
import { texJobClass, BORN_KEY, JOB_NAME_KEY } from "../src/texJob.js";
import { JOB_NODES_KEY, JOB_NODES_KEPT } from "../src/texJobLog.js";

const JOB = "a1b2c3d4-e5f6";
const NAME = `job:${JOB}`;

/** A Durable Object's storage, in memory. */
class DoStorage {
  data = new Map();
  async get(key) {
    return structuredClone(this.data.get(key));
  }
  async put(key, value) {
    if (typeof key === "object") for (const [k, v] of Object.entries(key)) this.data.set(k, structuredClone(v));
    else this.data.set(key, structuredClone(value));
  }
  async delete(key) {
    return this.data.delete(key);
  }
}

/** A `job` node run through the gateway's graph with the given `call` and `read`, the way `TexJob` runs it. */
const runPass = (step, { call, read = async () => ({ attempt: 2, sent: 1, running: true }) }) =>
  gatewayGraph({ nodes: { job }, config: TEX_CONFIG }).runNode("job", { step, jobId: JOB }, { job: { call, read } }, "test");

const answer = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("the job node's output", () => {
  it("is done, now or after the pass's next, with the run's attempt, sent and running", async () => {
    const done = await runPass("pass", { call: async () => answer({ next: { kind: "done" } }), read: async () => ({ attempt: 3, sent: 2, running: false }) });
    assert.deepEqual(done.output, { next: "done", ms: 0, attempt: 3, sent: 2, running: false });

    const now = await runPass("pass", { call: async () => answer({ next: { kind: "now" } }) });
    assert.deepEqual(now.output, { next: "now", ms: 0, attempt: 2, sent: 1, running: true });

    const after = await runPass("pass", { call: async () => answer({ next: { kind: "after", ms: 4000 } }), read: async () => ({ running: true }) });
    assert.deepEqual(after.output, { next: "after", ms: 4000, attempt: 0, sent: 0, running: true });
  });

  it("calls /job-failed for a failed step, and /job-pass for a pass", async () => {
    const paths = [];
    const call = async (path) => (paths.push(path), answer({ next: { kind: "done" } }));
    await runPass("failed", { call });
    await runPass("pass", { call });
    assert.deepEqual(paths, ["/job-failed", "/job-pass"]);
  });

  it("an answer that is not ok fails the node, naming the path and the status; the workflow then retries", async () => {
    await assert.rejects(runPass("pass", { call: async () => new Response("no", { status: 500 }) }), /\/job-pass answered 500/);
  });
});

describe("the lend while a pass runs", () => {
  it("is the job node's io during the call, and is given back after a pass", async () => {
    let during = null;
    const { output } = await runPass("pass", {
      call: async () => {
        during = borrowJob(JOB);
        return answer({ next: { kind: "done" } });
      },
    });
    assert.equal(output.next, "done");
    assert.ok(during !== null && typeof during.use === "object" && during.ctx.job !== undefined, "the lent io is the job node's own");
    assert.equal(borrowJob(JOB), null, "cleared after the pass");
  });

  it("is given back when the pass throws, too", async () => {
    await assert.rejects(runPass("pass", { call: async () => (assert.notEqual(borrowJob(JOB), null), new Response("x", { status: 503 })) }));
    assert.equal(borrowJob(JOB), null, "cleared after a throw");
  });

  it("a non-string id lends nothing and borrows nothing; returnJob removes only its own io", () => {
    assert.equal(borrowJob(undefined), null);
    assert.equal(borrowJob(7), null);
    lendJob(JOB, { mine: 1 });
    returnJob(JOB, { mine: 2 });
    assert.deepEqual(borrowJob(JOB), { mine: 1 }, "a later lend of another io is not removed");
    returnJob(JOB, borrowJob(JOB));
    assert.equal(borrowJob(JOB), null);
  });
});

describe("the borrowing bridges", () => {
  // The check reaches the job node's own `jobadv` wire as the Job advisor's `check` role (the job node's io is the lent
  // one), not the bridge's (Dev2, 2026-11-16: Job check and the Advisor on job mail are one Job advisor).
  it("jobCheckFor reaches the Job advisor's check over the job node's own wire while a pass runs, and over the config's wire when none does", async () => {
    const seen = [];
    const graph = gatewayGraph({
      nodes: {
        job,
        jobadv: async (input, io) => (seen.push(`${input.role}:${io.ctx.job !== undefined ? "from-the-job-node" : "from-the-bridge"}`), { verdict: "done", advice: "", thinking: "" }),
      },
      config: TEX_CONFIG,
    });
    const args = { job: { title: "Sort" }, live: { messages: [] }, answer: "done", model: "m", request: async () => null };
    let checked = null;
    await graph.runNode("job", { step: "pass", jobId: JOB }, {
      job: {
        call: async () => {
          checked = await jobCheckFor(JOB, graph)(args);
          return answer({ next: { kind: "done" } });
        },
        read: async () => ({ running: false }),
      },
    });
    assert.deepEqual(checked, { verdict: "done" });
    assert.deepEqual(seen, ["check:from-the-job-node"]);

    const bridged = await jobCheckFor("no-pass-here-id", graph)(args);
    assert.deepEqual(bridged, { verdict: "done" });
    assert.deepEqual(seen, ["check:from-the-job-node", "check:from-the-bridge"]);
  });

  it("handbackFor judges over the job node's handback wire while a pass runs, and is null with no model road", async () => {
    const judged = [];
    const graph = gatewayGraph({
      nodes: {
        job,
        handback: async (input, io) => (judged.push(io.ctx.handback.config), { judged: true, codes: [], sentBack: "", notice: "Check the link first." }),
      },
      config: TEX_CONFIG,
    });
    const opts = { question: "q", config: { model: "m" }, metadata: { feature: "t" } };
    let notice = null;
    await graph.runNode("job", { step: "pass", jobId: JOB }, {
      job: {
        call: async () => {
          notice = await handbackFor(JOB, graph, opts)("an answer", []);
          return answer({ next: { kind: "done" } });
        },
        read: async () => ({ running: false }),
      },
    });
    assert.equal(notice, "Check the link first.");
    assert.deepEqual(judged, [{ model: "m" }]);
    assert.equal(handbackFor(JOB, graph, { ...opts, config: null }), null, "no model road, no judge");
  });
});

// The job's object: born by its storage (the start is `texJob.test.mjs`'s), its pass run through the node.
describe("a job's object runs its pass through the node", () => {
  const TexJobObject = texJobClass({ gateway: () => ({ fetch: async () => Response.json({}, { status: 404 }) }), texts: () => ({ fetch: async () => Response.json({}, { status: 404 }) }) });
  const bornObject = () => {
    const storage = new DoStorage();
    const state = { storage, id: { toString: () => NAME }, blockConcurrencyWhile: (run) => run(), waitUntil: () => {} };
    const rpc = { chatMove: async () => ({ status: 404, body: null }), inboxFetch: async () => Response.json({}), inboxId: async () => "", lineCall: async () => ({ ok: true, value: null }), groupLineCall: async () => ({ ok: true, value: null }), groupTurn: async () => null };
    const env = { TEX_JOBS: "gateway", TEX_JOB_RUN: { create: async (o) => ({ id: o.id }), get: async (id) => ({ id }) }, TEXTING: rpc, rpc };
    const object = new TexJobObject(state, env);
    return { storage, object, pass: (path) => object.fetch(new Request(`https://job${path}`, { method: "POST" })), nodes: () => object.fetch(new Request("https://job/job-nodes")) };
  };

  it("answers a pass with the JSON its inner object answers, and keeps one node entry readable at GET /job-nodes", async () => {
    const { storage, object, pass, nodes } = bornObject();
    await storage.put({ [BORN_KEY]: 1, [JOB_NAME_KEY]: NAME });
    const through = await pass("/job-pass");
    assert.equal(through.status, 200);
    const direct = await (await object.job()).fetch(new Request("https://inbox/job-pass", { method: "POST" }));
    const body = await through.json();
    assert.deepEqual(body, await direct.json());
    assert.deepEqual(body, { next: { kind: "done" } });

    const { nodes: kept } = await (await nodes()).json();
    assert.equal(kept.length, 1);
    assert.deepEqual([kept[0].step, kept[0].name, kept[0].ok, kept[0].output.next], ["node", "job", true, "done"]);
  });

  it("answers 500 when the node fails (the workflow retries), records the failed node, and gives the lend back", async () => {
    const { storage, object, pass, nodes } = bornObject();
    await storage.put({ [BORN_KEY]: 1, [JOB_NAME_KEY]: NAME });
    object.inner = { fetch: async () => new Response("no", { status: 500 }) };
    const failed = await pass("/job-failed");
    assert.equal(failed.status, 500);
    const { nodes: kept } = await (await nodes()).json();
    assert.deepEqual(kept.map((e) => [e.name, e.ok]), [["job", false]]);
    assert.equal(borrowJob(JOB), null);
  });

  it("keeps the last 50 node entries, trimmed on each flush", async () => {
    const { storage, pass } = bornObject();
    await storage.put({ [BORN_KEY]: 1, [JOB_NAME_KEY]: NAME, [JOB_NODES_KEY]: Array.from({ length: JOB_NODES_KEPT }, (_, i) => ({ name: `old${i}`, ok: true })) });
    await pass("/job-pass");
    const kept = await storage.get(JOB_NODES_KEY);
    assert.equal(kept.length, JOB_NODES_KEPT);
    assert.equal(kept.at(-1).name, "job");
    assert.equal(kept[0].name, "old1");
  });

  it("an unborn object's node log answers 404 like every path it does not own", async () => {
    const { pass, nodes } = bornObject();
    assert.equal((await nodes()).status, 404);
    assert.equal((await pass("/job-pass")).status, 404);
  });
});

