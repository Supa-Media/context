/**
 * `tex_dev` `steps`, `marks`, `put_back` and the 20-case cap on `case` (`packages/lab/gateway/texDev/lab.js`, `tool.js`; the Lab's
 * `engine/forMcpCases.ts`, bundled in `lab.generated.js`). Dev2, 2026-11-15: anything the Lab does or shows, the MCP
 * does too; #3342 added a step's own cases (at most 20 a step, a full step trades one out) and change marks with Put
 * back, and these are the same through the MCP.
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-15):
 *  1. `case` without the room check (tool.js). → "a new case into a full step is refused unless it trades one out"
 *     fails.
 *  2. `putBackOps` answering the draft's own graph unchanged (no `labPutBack`). → "put_back lands the edits that bring
 *     one step back to main" fails.
 *  3. `labMarks` comparing the draft with itself. → "marks names each changed field from → to" fails.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTexDev } from "../../../packages/lab/gateway/texDev/tool.js";
import { TEX_CONFIG } from "../src/agent/texConfig.js";
import { guideText } from "../../../packages/lab/gateway/texDev/guide.js";
import { UNIT_LIMIT } from "../bench/gateSample.mjs";

const mainGraph = () => JSON.parse(JSON.stringify({ nodes: TEX_CONFIG.nodes, edges: TEX_CONFIG.edges }));
const jsonOf = (result) => JSON.parse(result.content.find((c) => c.type === "text").text);
const session = { accessToken: "tok" };

function fakePlane(answers) {
  const calls = [];
  return {
    calls,
    async texDev(_token, action, args) {
      calls.push({ action, args });
      const a = answers[action];
      return typeof a === "function" ? a(args) : (a ?? null);
    },
  };
}
const draftRow = (graph, extra = {}) => ({ status: "ok", name: "Lighter reviewer", by: "@dev", rev: 4, graph: JSON.stringify(graph), picks: "{}", areas: null, results: "[]", ...extra });
const NO_CASES = { status: "ok", caseEdits: [] };
const devWith = (plane) => createTexDev({ env: {}, session, controlPlane: plane });

/** Main with the Answer check (the reviewer's step now) on medium effort and switched off. */
function changed() {
  const g = mainGraph();
  const r = g.nodes.find((n) => n.id === "answerCheck");
  r.effort = "medium";
  r.on = false;
  return g;
}

test("the guide names steps, marks and put_back, and case's swap_out", () => {
  const text = guideText();
  for (const a of ["steps", "marks", "put_back"]) assert.match(text, new RegExp(`- ${a} `));
  assert.match(text, /swap_out/);
});

test("steps lists every step out of UNIT_LIMIT and the ones with no cases; one step gives its case form", async () => {
  const dev = devWith(fakePlane({ cases: NO_CASES }));
  const all = jsonOf(await dev("steps", {}));
  assert.equal(all.cap, UNIT_LIMIT);
  const fd = all.steps.find((s) => s.step === "fd");
  assert.match(fd.cases, new RegExp(`^\\d+/${UNIT_LIMIT}$`));
  assert.ok(all.noCasesYet.length > 0);
  for (const id of all.noCasesYet) assert.equal(all.steps.find((s) => s.step === id).cases, `0/${UNIT_LIMIT}`);
  const one = jsonOf(await dev("steps", { step: "answerCheck" }));
  assert.equal(one.area, "node:answerCheck");
  assert.match(one.newCase.key, /^node:answerCheck\/new-\d+$/);
  const check = TEX_CONFIG.nodes.find((n) => n.id === "answerCheck");
  assert.deepEqual(one.newCase.want.map((f) => f.name), check.outSchema.map((f) => f.name));
  assert.ok(one.newCase.want.find((f) => f.type === "yesno").choices.includes("Yes"));
  assert.equal((await dev("steps", { step: "nowhere" })).isError, true);
});

test("marks names each changed field from → to, against main or the draft before its last revision", async () => {
  const g = changed();
  const plane = fakePlane({ get: draftRow(g), before: { status: "ok", rev: 4, graph: JSON.stringify(mainGraph()) } });
  const dev = devWith(plane);
  const m = jsonOf(await dev("marks", { draft: "vlight" }));
  assert.equal(m.vs, "main");
  const r = m.changed.find((c) => c.step === "answerCheck");
  assert.ok(r, JSON.stringify(m));
  assert.deepEqual(
    r.fields.map((f) => [f.field, f.to]),
    [
      ["effort", "medium"],
      ["running", "no"],
    ],
  );
  assert.equal(r.fields.find((f) => f.field === "running").from, "yes");
  const last = jsonOf(await dev("marks", { draft: "vlight", vs: "last" }));
  assert.equal(last.vs, "rev 3");
  assert.ok(plane.calls.some((c) => c.action === "before" && c.args.draft === "vlight"));
  const none = devWith(fakePlane({ get: draftRow(g), before: { status: "ok", rev: 40, graph: null } }));
  assert.match(jsonOf_err(await none("marks", { draft: "vlight", vs: "last" })), /was not kept/);
});

const jsonOf_err = (result) => result.content.find((c) => c.type === "text").text;

test("put_back lands the edits that bring one step back to main, with the draft's revision", async () => {
  const g = changed();
  const plane = fakePlane({ get: draftRow(g), edit: { status: "ok", rev: 5, said: ["set answerCheck effort medium → low"], others: [] } });
  const dev = devWith(plane);
  const answer = jsonOf(await dev("put_back", { draft: "vlight", step: "answerCheck" }));
  assert.equal(answer.rev, 5);
  const sent = plane.calls.find((c) => c.action === "edit");
  assert.equal(sent.args.rev, 4);
  const main = TEX_CONFIG.nodes.find((n) => n.id === "answerCheck");
  assert.deepEqual(
    sent.args.ops.filter((o) => o.op === "set" && o.node === "answerCheck").map((o) => [o.field, o.value]).sort(),
    [
      ["effort", main.effort],
      ["on", main.on],
    ].sort(),
  );
  const same = devWith(fakePlane({ get: draftRow(mainGraph()) }));
  assert.match(jsonOf(await same("put_back", { draft: "vlight", step: "answerCheck" })).unchanged, /already/);
  assert.equal((await same("put_back", { draft: "vlight", step: "intake" })).isError, true, "a group's box is refused");
});

test("a new case into a full step is refused unless it trades one out, as the Tests page's swap", async () => {
  // A step's own cases, all added in the Lab: UNIT_LIMIT of them fill it.
  const full = Array.from({ length: UNIT_LIMIT }, (_, i) => ({ key: `node:send/c${i}`, data: JSON.stringify({ area: "node:send", id: `c${i}`, ask: "x", expect: "y", isNew: true }) }));
  const plane = fakePlane({ cases: { status: "ok", caseEdits: full }, case: { status: "ok" } });
  const dev = devWith(plane);
  const refused = await dev("case", { key: "node:send/new-21", data: { area: "node:send", id: "new-21", ask: "a", expect: "b", isNew: true } });
  assert.equal(refused.isError, true);
  assert.match(jsonOf_err(refused), /swap_out/);
  assert.ok(!plane.calls.some((c) => c.action === "case"), "nothing is kept");
  // Editing one already there always lands.
  assert.equal((await dev("case", { key: "node:send/c3", data: { area: "node:send", id: "c3", ask: "z", expect: "y", isNew: true } })).isError, undefined);
  // Trading out a case the Lab added drops it, as keepSwap does.
  plane.calls.length = 0;
  const swapped = jsonOf(await dev("case", { key: "node:send/new-21", data: { area: "node:send", id: "new-21", ask: "a", expect: "b" }, swap_out: "c5" }));
  assert.equal(swapped.tradedOut, "node:send/c5");
  const writes = plane.calls.filter((c) => c.action === "case");
  assert.equal(writes[0].args.data, null);
  assert.equal(JSON.parse(writes[1].args.data).replaces, "c5");
  // A bench step's own case traded out is marked removed, its words kept.
  // The bench's review cases plus enough added in the Lab fill the step.
  const benchKept = jsonOf(await devWith(fakePlane({ cases: NO_CASES }))("bench", { area: "review", limit: 1 })).total;
  const added = Array.from({ length: UNIT_LIMIT - benchKept }, (_, i) => ({ key: `review/a${i}`, data: JSON.stringify({ area: "review", id: `a${i}`, ask: "x", expect: "y", isNew: true }) }));
  const bench = fakePlane({ cases: { status: "ok", caseEdits: added }, case: { status: "ok" } });
  const benchDev = devWith(bench);
  const room = jsonOf(await benchDev("bench", { area: "review", limit: 1 }));
  const out = room.cases[0].id;
  assert.equal((await benchDev("case", { key: "review/new-1", data: { area: "review", id: "new-1", ask: "a", expect: "b" } })).isError, true);
  await benchDev("case", { key: "review/new-1", data: { area: "review", id: "new-1", ask: "a", expect: "b" }, swap_out: out });
  const gone = JSON.parse(bench.calls.filter((c) => c.action === "case")[0].args.data);
  assert.deepEqual([gone.id, gone.removed, typeof gone.ask], [out, true, "string"]);
});
