/**
 * A job reports, node `jobReport` (jobs as config step 7, Dev2, 2026-11-17): a background job's report reaches its chat
 * as a new run (Dev2's generators model, 2026-11-16), read by this node once the config has it, logged like every node.
 *
 * Sabotage record (temporary local edits, reverted):
 *   the node's `report === null` refusal removed → "refuses a report it can't read" fails
 *   jobReportEvent's on-check removed (the node run while on the shelf) → "on the shelf, the code's read stands" fails
 *   jobReportEvent returning the code's report when the node refused → "the node's refusal is the run's" fails
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { jobReportNode } from "../src/agent/graph/nodes/jobReport.js";
import { GATEWAY_NODES } from "../src/agent/graph/gatewayNodes.js";
import { jobReportOf, jobReportQuestion } from "../src/agent/jobReport.js";
import { TEX_CONFIG } from "../src/agent/texConfig.js";
import { jobReportEvent } from "../src/agent/texEntryPoint/readTheText.js";

const SHELF = createRequire(import.meta.url)("../../../packages/shared/src/texNodeShelf.json");
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

test("on the shelf, the code's read stands and no node runs", async () => {
  assert.ok(SHELF.nodes.jobReport, "on the shelf until a Lab draft wires it");
  assert.equal(GATEWAY_NODES.jobReport, jobReportNode);
  const writer = ledger(), b = body(REPORT), read = code(b);
  assert.equal(await jobReportEvent(b, read, { config: TEX_CONFIG, writer }), read);
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
