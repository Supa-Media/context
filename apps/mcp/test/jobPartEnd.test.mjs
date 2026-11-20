/**
 * Part end (Dev2, 2026-11-17, jobs as config, step 5): what follows each part of a background job, as one pure rule
 * (`packages/shared/src/jobPartEnd.cjs`) behind the shelf node `partEnd`, with its limits as the node's config.
 * Until a Lab draft wires it, `runJob` (`packages/tex/worker/jobRun.ts`) decides the same things in code; these cases are
 * that code's behaviour, so wiring the node changes nothing a person sees.
 *
 * Sabotage record (2026-11-17, applied, run, failing, reverted):
 *   (i)   `DETERMINISTIC` emptied: "a check limit with a draft saved delivers it" fails (it carried on instead).
 *   (ii)  the time limit dropped from `roomLeft`: "a job past its time ..." fails (it carried on).
 *   (iii) `spinning` ignored: "two idle parts in a row end stuck" fails.
 *   (iv)  config limits ignored in `limitsOf`: "the node's config sets the limits" fails.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import partEndLib from "../../../packages/shared/src/jobPartEnd.cjs";
import SHELF from "../../../packages/tex/src/texNodeShelf.json" with { type: "json" };
import { partEndNode } from "../../../packages/tex/gateway/agent/graph/nodes/partEnd.js";
import { GATEWAY_NODES } from "../../../packages/tex/gateway/agent/graph/gatewayNodes.js";

const { decidePartEnd, DEFAULT_LIMITS, limitsOf } = partEndLib;
const MIN = 60_000;
const at = (extra) => ({ part: 1, startedAt: 0, now: 5 * MIN, ...extra });

test("a check limit with a draft saved delivers it, done, on the first part (the timecards job)", () => {
  assert.deepEqual(decidePartEnd(at({ cause: "check_limit", hasDraft: true })), { to: "deliver", ended: "done", cause: "check_limit", room: true });
});

test("a crash or timeout carries on while there is room, and delivers its draft, stuck, when there is none", () => {
  for (const cause of ["crash", "timeout"]) {
    assert.equal(decidePartEnd(at({ cause, hasDraft: true })).to, "carry", `${cause} with room carries on`);
    assert.deepEqual(decidePartEnd(at({ cause, hasDraft: true, part: 10 })), { to: "deliver", ended: "stuck", cause, room: false });
    assert.deepEqual(decidePartEnd(at({ cause, part: 10 })), { to: "end", ended: "failed", cause, room: false }, "with nothing saved it fails");
  }
});

test("work left (steps out, unfinished, changed) carries on, and ends as it stands when the parts run out", () => {
  assert.equal(decidePartEnd(at({ cause: "steps_out" })).to, "carry");
  assert.equal(decidePartEnd(at({ cause: "unfinished" })).to, "carry");
  assert.equal(decidePartEnd(at({ cause: "changed" })).to, "carry");
  assert.deepEqual(decidePartEnd(at({ cause: "unfinished", part: 10 })), { to: "end", ended: "stuck", cause: "unfinished", room: false });
  assert.deepEqual(decidePartEnd(at({ cause: "changed", part: 10 })), { to: "end", ended: "done", cause: "changed", room: false });
});

test("a job past its time, or past its parts, starts no more", () => {
  assert.equal(decidePartEnd(at({ cause: "steps_out", now: 31 * MIN })).room, false);
  assert.equal(decidePartEnd(at({ cause: "steps_out", now: 31 * MIN })).to, "end");
  assert.equal(decidePartEnd(at({ cause: "steps_out", part: 9 })).to, "carry", "part 9 of 10 still has one after it");
});

test("out of steps with no room left, a job ends as the part's own check read its answer", () => {
  const last = (checked) => decidePartEnd(at({ cause: "steps_out", part: 10, ...(checked ? { checked } : {}) })).ended;
  assert.equal(last("done"), "done", "checked done: its answer is the result, not a stuck job");
  assert.equal(last("waiting"), "waiting");
  assert.equal(last("stuck"), "stuck");
  assert.equal(last(undefined), "stuck", "no check: short until shown otherwise");
  assert.equal(decidePartEnd(at({ cause: "steps_out", checked: "done" })).to, "carry", "with room left it still carries on");
});

test("a job still looking that found nothing new in staleParts parts in a row ends, its answer sent", () => {
  const limits = { staleParts: 2 };
  assert.equal(decidePartEnd(at({ cause: "unfinished", fresh: 0, staleBefore: 0 }), limits).to, "carry", "one part with nothing new may be bad luck");
  assert.deepEqual(decidePartEnd(at({ cause: "unfinished", fresh: 0, staleBefore: 1 }), limits), { to: "end", ended: "stuck", cause: "unfinished", room: true, stale: true });
  assert.equal(decidePartEnd(at({ cause: "steps_out", fresh: 0, staleBefore: 1, checked: "done" }), limits).ended, "done", "ends as its check read it");
  assert.equal(decidePartEnd(at({ cause: "unfinished", fresh: 3, staleBefore: 1 }), limits).to, "carry", "a part that found something carries on");
  assert.equal(decidePartEnd(at({ cause: "unfinished", staleBefore: 5 }), limits).to, "carry", "no count given: never stale");
  assert.equal(decidePartEnd(at({ cause: "crash", fresh: 0, staleBefore: 4 }), limits).to, "carry", "a part that broke is not a part that looked");
  assert.equal(decidePartEnd(at({ cause: "unfinished", fresh: 0, staleBefore: 9 })).to, "carry", "off unless the node's config sets it");
});

test("two idle parts in a row end stuck instead of spending more", () => {
  assert.equal(decidePartEnd(at({ cause: "unfinished", idle: true })).to, "carry", "one idle part is allowed");
  assert.deepEqual(decidePartEnd(at({ cause: "unfinished", idle: true, wasIdle: true })), { to: "end", ended: "stuck", cause: "unfinished", room: true, spinning: true });
});

test("the rest end at once: done, waiting, stuck, stopped, refused for now, turned down, model down", () => {
  const ended = (input) => decidePartEnd(at(input)).ended;
  assert.equal(ended({ cause: "done" }), "done");
  assert.equal(ended({ cause: "waiting" }), "waiting");
  assert.equal(ended({ cause: "stuck" }), "stuck");
  assert.equal(ended({ cause: "stopped" }), "failed");
  assert.equal(ended({ cause: "refused" }), "waiting");
  assert.equal(ended({ cause: "refused", rejected: true }), "failed");
  assert.equal(ended({ cause: "model_down" }), "failed");
  assert.equal(decidePartEnd(at({ cause: "no such cause" })).cause, "crash", "an unknown cause is read as a crash");
});

test("a job on their own computer runs under its own limits", () => {
  assert.equal(decidePartEnd(at({ cause: "steps_out", machine: true, part: 50, now: 3 * 60 * MIN })).to, "carry");
  assert.equal(decidePartEnd(at({ cause: "steps_out", machine: true, part: 96 })).to, "end");
});

test("the node's config sets the limits, and a missing or bad one keeps today's number", () => {
  assert.deepEqual(limitsOf(null), DEFAULT_LIMITS);
  assert.deepEqual(limitsOf({ parts: 3, minutes: -1 }), { ...DEFAULT_LIMITS, parts: 3 });
  assert.equal(decidePartEnd(at({ cause: "steps_out", part: 3 }), { parts: 3 }).to, "end");
});

test("the node answers its choice as a when tag, under the limits on its own config", async () => {
  const out = await partEndNode(at({ cause: "steps_out", part: 2 }), { node: { id: "partEnd", limits: { parts: 2 } } });
  assert.deepEqual(out.when, ["end"]);
  assert.equal(out.ended, "stuck");
});

test("the texting Worker's limits are the node's config, not numbers of its own", () => {
  const jobs = readFileSync(new URL("../../../packages/tex/worker/jobs.ts", import.meta.url), "utf8");
  assert.match(jobs, /const LIMITS = partEndLib\.configLimits\(TEX_CONFIG\);/);
  const value = (name) => jobs.match(new RegExp(`export const ${name} = ([^;]+);`))[1];
  assert.equal(value("MAX_JOB_ATTEMPTS"), "LIMITS.parts");
  assert.equal(value("JOB_LIMIT_MS"), "LIMITS.minutes * 60 * 1000");
  assert.equal(value("MAX_MACHINE_JOB_ATTEMPTS"), "LIMITS.machineParts");
  assert.equal(value("MACHINE_JOB_LIMIT_MS"), "LIMITS.machineMinutes * 60 * 1000");
});

test("Part end is wired in the config (off the shelf), with its limits, and its code is in the gateway's table", async () => {
  const { TEX_CONFIG } = await import("../../../packages/tex/gateway/agent/texConfig.js");
  assert.ok(!SHELF.nodes.partEnd, "off the shelf once promoted");
  assert.ok(TEX_CONFIG.edges.some((e) => e.from === "job" && e.to === "partEnd" && e.mode === "uses"), "the job -> partEnd wire");
  assert.deepEqual(partEndLib.configLimits(TEX_CONFIG), { ...DEFAULT_LIMITS, staleParts: 2 }, "today's limits from the node's config; the stale rule on at 2 (2026-11-18)");
  assert.equal(GATEWAY_NODES.partEnd, partEndNode);
});

// Step 6: the texting Worker asks the gateway (`/agent/job/part-end`, `agent/jobPartEndRoute.js`) after each part.
import { handleJobPartEnd, partEndFor } from "../../../packages/tex/gateway/agent/jobPartEndRoute.js";
import { lendJob, returnJob } from "../../../packages/tex/gateway/agent/graph/jobHandles.js";

const texting = (fields = {}) => ({ actorClientId: "context_texts", scopes: ["context:read", "context:write"], ...fields });
const askRoute = (body, session, method = "POST") =>
  handleJobPartEnd(new Request("https://gw.example/agent/job/part-end", { method, body: method === "POST" ? JSON.stringify(body) : undefined }), null, null, session);

test("the route answers the node's choice to the texting Worker, and nobody else", async () => {
  const input = at({ cause: "check_limit", hasDraft: true });
  const answered = await askRoute({ jobId: "job-1", input }, texting());
  assert.equal(answered.status, 200);
  // The config's job -> partEnd wire runs the node on the runner: the rule's choice, with its `when`.
  const choice = decidePartEnd(input, null);
  assert.deepEqual(await answered.json(), { when: [choice.to], ...choice });
  assert.equal((await askRoute({ jobId: "job-1", input }, texting({ actorClientId: "context_texts_group" }))).status, 200);
  assert.equal((await askRoute({ jobId: "job-1", input }, texting({ actorClientId: "some_ai_client" }))).status, 403);
  assert.equal((await askRoute({ jobId: "job-1", input }, texting({ scopes: ["context:read"] }))).status, 403);
  assert.equal((await askRoute({ jobId: "job-1" }, texting())).status, 400);
  assert.equal((await askRoute(null, texting(), "GET")).status, 405);
});

test("while the job's pass runs, its own wire answers; else the config's wire; else the rule on default limits", async () => {
  const input = at({ cause: "unfinished" });
  const io = { use: { partEnd: async () => ({ to: "end", ended: "stuck", cause: "unfinished", room: true, via: "lent" }) } };
  lendJob("job-lent", io);
  try {
    assert.equal((await partEndFor("job-lent", input)).via, "lent");
  } finally {
    returnJob("job-lent", io);
  }
  const fired = [];
  const graph = { fire: async (from, to, given) => (fired.push([from, to]), { ...decidePartEnd(given, { parts: 1 }), via: "wire" }) };
  const wired = { edges: [{ from: "job", to: "partEnd", mode: "uses", when: ["job"] }] };
  assert.equal((await partEndFor("job-other", input, { config: wired, graph })).via, "wire");
  assert.deepEqual(fired, [["job", "partEnd"]]);
  assert.deepEqual(await partEndFor("job-other", input, { config: { edges: [] } }), decidePartEnd(input, null));
});

test("a job's limits everywhere are its Part end node's config, today's numbers while it names none", async () => {
  const { configLimits } = partEndLib;
  assert.deepEqual(configLimits({ nodes: [] }), DEFAULT_LIMITS);
  assert.deepEqual(configLimits({ nodes: [{ id: "partEnd", limits: { parts: 4, minutes: 12 } }] }), { ...DEFAULT_LIMITS, parts: 4, minutes: 12 });
  const { MAX_JOB_ATTEMPTS } = await import("../../../packages/tex/gateway/agent/background.js");
  const { TEX_CONFIG } = await import("../../../packages/tex/gateway/agent/texConfig.js");
  assert.equal(MAX_JOB_ATTEMPTS, configLimits(TEX_CONFIG).parts);
});

// Step 7c: a part refused at today's limit pauses the job in the Part end node, until just after the limit resets.
test("a part refused at today's limit pauses the job until just after midnight UTC; no model or a turned-down part does not", () => {
  const now = Date.UTC(2026, 10, 17, 22, 30);
  const refused = decidePartEnd(at({ cause: "refused", refusal: "daily_limit", now }));
  assert.equal(refused.to, "end");
  assert.equal(refused.ended, "waiting");
  assert.equal(refused.resumeAt, Date.UTC(2026, 10, 18, 0, 2));
  assert.equal(decidePartEnd(at({ cause: "refused", refusal: "daily_limit", now }), { resumeAfterMinutes: 10 }).resumeAt, Date.UTC(2026, 10, 18, 0, 10), "the node's config sets how long after");
  assert.equal(decidePartEnd(at({ cause: "refused", refusal: "no_model", now })).resumeAt, undefined);
  const rejected = decidePartEnd(at({ cause: "refused", rejected: true, refusal: "daily_limit", now }));
  assert.equal(rejected.ended, "failed");
  assert.equal(rejected.resumeAt, undefined);
});
