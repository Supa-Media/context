/**
 * A job reports, node `jobReport` (jobs as config step 7, Dev2, 2026-11-17): a background job's report reaches its chat
 * as a new run (Dev2's generators model, 2026-11-16), read by this node once the config has it, logged like every node.
 *
 * Sabotage record (temporary local edits, reverted):
 *   gatewayGraph not watching the request's Lab gate → "a node run outside the turn's graph shows on the run card" fails
 *   the node's `report === null` refusal removed → "refuses a report it can't read" fails
 *   jobReportEvent's on-check removed (the node run with none in the config) → "a config without it keeps the code's read" fails
 *   jobReportEvent returning the code's report when the node refused → "the node's refusal is the run's" fails
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { jobReportNode } from "../../../packages/tex/gateway/agent/graph/nodes/jobReport.js";
import { GATEWAY_NODES } from "../../../packages/tex/gateway/agent/graph/gatewayNodes.js";
import { jobReportOf, jobReportQuestion } from "../../../packages/tex/gateway/agent/jobReport.js";
import { TEX_CONFIG } from "../../../packages/tex/gateway/agent/texConfig.js";
import { jobReportEvent } from "../../../packages/tex/gateway/agent/texEntryPoint/readTheText.js";

const SHELF = createRequire(import.meta.url)("../../../packages/tex/src/texNodeShelf.json");
const REPORT = { id: "j25dcf950", title: "Book the coworking day", state: "done", texts: ["Booked for Friday."] };
const body = (jobReport) => ({ event: "job_report", jobReport, turn: "t-1" });
const code = (b) => jobReportOf(b, { chatTurn: true, job: null });
const NODE = {
  id: "jobReport", label: "A job reports", goal: "x", model: "code", kind: "input", group: "jobs", on: true,
  inSchema: [{ name: "jobReport", type: "object" }],
  outSchema: [{ name: "to", type: "choice", options: "report, refuse" }, { name: "report", type: "object", optional: true }, { name: "question", type: "text", optional: true }, { name: "why", type: "text", optional: true }],
};
const wired = { ...TEX_CONFIG, nodes: [...TEX_CONFIG.nodes.filter((n) => n.id !== "jobReport"), NODE] };
const ledger = () => { const entries = []; return { entries, write: (e) => entries.push(e) }; };

test("the node reads a report strictly and asks the gateway's own line", async () => {
  const out = await jobReportNode({ jobReport: REPORT });
  assert.equal(out.to, "report");
  assert.deepEqual(out.report, code(body(REPORT)));
  assert.equal(out.question, jobReportQuestion(out.report));
});

test("refuses a report it can't read", async () => {
  assert.equal((await jobReportNode({ jobReport: { title: "", state: "done" } })).to, "refuse");
  assert.equal((await jobReportNode({ jobReport: { title: "x", state: "exploded" } })).to, "refuse");
  assert.equal((await jobReportNode({})).to, "refuse");
});

test("wired in the config (off the shelf); a config without it keeps the code's read and runs no node", async () => {
  assert.ok(!SHELF.nodes.jobReport, "off the shelf once promoted");
  assert.equal(GATEWAY_NODES.jobReport, jobReportNode);
  assert.ok(TEX_CONFIG.nodes.some((n) => n.id === "jobReport" && n.kind === "input" && n.on !== false), "an input node in the config");
  assert.ok(TEX_CONFIG.edges.some((e) => e.from === "job" && e.to === "jobReport" && e.mode === "generator"), "the job -> jobReport generator wire");
  assert.ok(TEX_CONFIG.edges.some((e) => e.from === "jobReport" && e.to === "lanes" && e.mode === "wait" && e.when.includes("report")), "jobReport -> lanes");
  const unwired = { ...TEX_CONFIG, nodes: TEX_CONFIG.nodes.filter((n) => n.id !== "jobReport"), edges: TEX_CONFIG.edges.filter((e) => e.from !== "jobReport" && e.to !== "jobReport") };
  const writer = ledger(), b = body(REPORT), read = code(b);
  assert.equal(await jobReportEvent(b, read, { config: unwired, writer }), read);
  assert.equal(writer.entries.length, 0);
});

test("once the config has it, the run reads the report through the node, logged", async () => {
  const writer = ledger(), b = body(REPORT);
  assert.deepEqual(await jobReportEvent(b, code(b), { config: wired, writer }), code(b));
  assert.equal(writer.entries.length, 1);
  assert.match(JSON.stringify(writer.entries[0]), /jobReport/);
});

test("the node's refusal is the run's", async () => {
  // The Worker's report the node can't read gives no report, whatever the code's read held.
  const stale = code(body(REPORT));
  assert.equal(await jobReportEvent(body({ title: "", state: "done" }), stale, { config: wired, writer: null }), null);
});

// A Lab test chat's card shows every node a request runs, not only the turn graph's (2026-11-17: the draft's jobReport
// ran in a test chat's report run and its card never showed it, as its graph was made without the request's env).
import { readFileSync, readdirSync } from "node:fs";
import { LAB_SANDBOX_KEY } from "../src/labSandbox/policy.js";

test("in a Lab test chat, a node run outside the turn's graph shows on the run card, started and ended", async () => {
  const started = [], ended = [];
  const env = { [LAB_SANDBOX_KEY]: { record() {}, onStart: (run) => started.push(run.node), onNode: (run) => ended.push(run.node) } };
  const writer = ledger(), b = body(REPORT);
  await jobReportEvent(b, code(b), { env, config: wired, writer });
  assert.deepEqual(started, ["jobReport"]);
  assert.deepEqual(ended, ["jobReport"]);
  assert.equal(writer.entries.length, 1, "still kept in the chat's ledger");
});

test("every graph a turn's steps make passes the request's env, so a Lab card misses none of its nodes", () => {
  const dir = new URL("../../../packages/tex/gateway/agent/texEntryPoint/", import.meta.url);
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".js"))) {
    for (const call of readFileSync(new URL(file, dir), "utf8").match(/gatewayGraph\(\{[^}]*\}/g) ?? []) assert.match(call, /\benv\b/, `${file}: ${call}`);
  }
});
