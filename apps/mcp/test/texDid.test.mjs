// What code did for a chat goes to Tex as data, and Tex writes the text (Dev2, 2026-11-25: "Tex's code never writes
// what Tex says"; docs/decisions/texting-assistant/no-scripted-wording.md). The Worker queues one turn of the chat's
// own with `event: "did"` and the facts (`packages/tex/worker/didFacts.ts`); node `did` hands them over as JSON.
//
// Sabotage record (2026-11-25), each fails a test here:
//  - `didFactsOf` letting a nested object through: "facts are short names and short values, or nothing";
//  - `didQuestion` adding a sentence: "the Front door is handed the facts and no words";
//  - `did` dropped from `GATEWAY_NODES`: "the node has code and is wired to the Front door, when tell".
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { didNode } from "../../../packages/tex/gateway/agent/graph/nodes/did.js";
import { DID_EVENT, didFactsOf, didQuestion } from "../../../packages/tex/gateway/agent/did.js";
import { GATEWAY_NODES } from "../../../packages/tex/gateway/agent/graph/gatewayNodes.js";
import { taggedLine } from "../../../packages/tex/gateway/agent/groupTurnCause.js";
import { TEX_CONFIG } from "../../../packages/tex/src/texConfig.cjs";

const shelf = JSON.parse(readFileSync(new URL("../../../packages/tex/src/texNodeShelf.json", import.meta.url), "utf8"));
const invited = { action: "invite", status: "invited", workspace: "@studio", people: 1, role: "member" };

test("the Front door is handed the facts and no words", async () => {
  const out = await didNode({ event: DID_EVENT, did: invited });
  assert.equal(out.to, "tell");
  assert.deepEqual(JSON.parse(out.question), { from: "context", did: invited });
  assert.equal(out.question, didQuestion(invited));
});

test("facts are short names and short values, or nothing", () => {
  assert.deepEqual(didFactsOf(invited), invited);
  for (const bad of [null, "invite", [], {}, { action: "invite" }, { action: "Invite!", status: "ok" }, { ...invited, nested: { a: 1 } }, { ...invited, note: "x".repeat(201) }, { ...invited, count: Infinity }, { ...invited, "Bad Key": 1 }]) {
    assert.equal(didFactsOf(bad), null, JSON.stringify(bad));
  }
});

test("a run that isn't a did event, or carries facts it can't read, is refused", async () => {
  assert.equal((await didNode({ event: "joined", did: invited })).to, "refuse");
  assert.equal((await didNode({ event: DID_EVENT, did: { action: "invite" } })).to, "refuse");
  assert.equal((await didNode(undefined)).to, "refuse");
});

test("its cause adds no line: the facts are the turn's whole question", () => {
  assert.equal(taggedLine({ cause: "did" }), "");
});

test("the node has code and is wired to the Front door, when tell (Lab draft vmwwsr5uflmq6)", () => {
  assert.equal(typeof GATEWAY_NODES.did, "function");
  const node = TEX_CONFIG.nodes.find((n) => n.id === "did");
  assert.equal(node?.on, true);
  assert.equal(node.outSchema.find((f) => f.name === "to")?.options, "tell, refuse");
  assert.deepEqual(TEX_CONFIG.edges.filter((e) => e.from === "did"), [{ from: "did", to: "fd", mode: "wait", when: ["tell"] }]);
  assert.equal(shelf.nodes.did, undefined, "off the shelf once wired");
});

test("a job that ended hands the chat's turn how it ended as facts, never a line code wrote (no-scripted-wording.md)", async () => {
  const { jobReportOf, jobReportPrompt } = await import("../../../packages/tex/gateway/agent/jobReport.js");
  const end = { action: "job", status: "paused", why: "daily_limit", resumes_by_itself: true };
  const report = jobReportOf({ event: "job_report", jobReport: { id: "job-abcdefgh", title: "Trip plan", state: "waiting", texts: [], end } }, { chatTurn: true, job: null });
  assert.deepEqual(report.end, end);
  assert.match(jobReportPrompt(report), /\{"end":\{"action":"job","status":"paused","why":"daily_limit","resumes_by_itself":true\}\}/);
  for (const bad of [{ action: "invite", status: "invited" }, { action: "job", status: "Paused!" }, { action: "job", status: "failed", why: { nested: true } }, "paused"]) {
    const read = jobReportOf({ event: "job_report", jobReport: { title: "Trip plan", state: "failed", texts: [], end: bad } }, { chatTurn: true, job: null });
    assert.equal(read.end, undefined, `${JSON.stringify(bad)} is not a job's end`);
  }
});
