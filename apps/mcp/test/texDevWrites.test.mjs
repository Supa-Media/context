/**
 * `tex_dev`'s actions for the rest of what the Lab writes to a draft (`packages/lab/gateway/texDev/writes.js`; Dev2, 2026-11-15:
 * "anything that can be done inside of the lab should be able to be done inside of the MCP"): rename, delete,
 * run_setup, keep_results (and `get` of main), revert. The control plane does the writes; these pin what each call
 * sends it and what the answer says, against a fake control plane.
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-15):
 *   delete without the confirm: true check        "delete asks twice, as the Lab does" fails
 *   get of main answering every result's raw text  "get of main answers main's kept results, briefly" fails
 *   tool.js without the writes(action) call        every action test here fails ("has no action")
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTexDev } from "../../../packages/lab/gateway/texDev/tool.js";
import { guideText } from "../../../packages/lab/gateway/texDev/guide.js";
import { texDevToolDefinitions } from "../src/tools/schemas/texDev.js";
import { TEX_CONFIG } from "../../../packages/tex/gateway/agent/texConfig.js";
import { draftProblems } from "../../../packages/lab/gateway/texDev/check.js";

const session = { accessToken: "tok" };
const textOf = (result) => result.content.find((c) => c.type === "text")?.text ?? "";
const jsonOf = (result) => JSON.parse(textOf(result));
const mainGraph = () => JSON.parse(JSON.stringify({ nodes: TEX_CONFIG.nodes, edges: TEX_CONFIG.edges }));

function fakePlane(answers) {
  const calls = [];
  return {
    calls,
    async texDev(token, action, args) {
      calls.push({ token, action, args });
      const a = answers[action];
      return typeof a === "function" ? a(args) : (a ?? null);
    },
  };
}
const tool = (answers) => {
  const plane = fakePlane(answers);
  return { plane, call: createTexDev({ env: { APP_ORIGIN: "https://context.example" }, session, controlPlane: plane }) };
};

test("the guide and the tool's description name every new action and edit", () => {
  const text = guideText();
  for (const action of ["rename", "delete", "run_setup", "keep_results", "revert"]) {
    assert.match(text, new RegExp(`- ${action} `));
    assert.match(texDevToolDefinitions()[0].description, new RegExp(`\\b${action}\\b`));
  }
  assert.match(text, /op: "convo_tool"/);
  assert.match(text, /op: "model"/);
});

test("rename sends the name and answers the line it kept", async () => {
  const { plane, call } = tool({ rename: { status: "ok", rev: 4, name: "Lighter", said: ["renamed Mine → Lighter"] } });
  const answer = jsonOf(await call("rename", { draft: "vabc", name: "Lighter" }));
  assert.deepEqual(plane.calls[0], { token: "tok", action: "rename", args: { draft: "vabc", name: "Lighter" } });
  assert.deepEqual([answer.rev, answer.kept, answer.link], [4, ["renamed Mine → Lighter"], "https://context.example/lab?v=vabc"]);
  const main = await call("rename", { draft: "main", name: "x" });
  assert.equal(main.isError, true, "main is never renamed");
});

test("delete asks twice, as the Lab does, and then deletes", async () => {
  const { plane, call } = tool({ delete: { status: "ok", deleted: "vabc", name: "Mine" } });
  const first = await call("delete", { draft: "vabc" });
  assert.equal(first.isError, true);
  assert.match(textOf(first), /permanent.*confirm: true/s);
  assert.equal(plane.calls.length, 0, "nothing is deleted without confirm");
  const done = jsonOf(await call("delete", { draft: "vabc", confirm: true }));
  assert.equal(done.deleted, "vabc");
  assert.equal(plane.calls[0].action, "delete");
});

test("run_setup sends the picks and areas as given and says what they mean", async () => {
  const { plane, call } = tool({ run_setup: (args) => ({ status: "ok", rev: 3, picks: args.picks, areas: args.areas, said: ["set the run's core cases to q1"] }) });
  const answer = jsonOf(await call("run_setup", { draft: "vabc", picks: { core: ["q1"] }, areas: ["core"] }));
  assert.deepEqual(plane.calls[0].args, { draft: "vabc", picks: { core: ["q1"] }, areas: ["core"] });
  assert.deepEqual([answer.rev, answer.picks, answer.areas], [3, { core: ["q1"] }, ["core"]]);
  assert.match(answer.means, /runs every case/);
  const refused = await tool({ run_setup: { status: "bad_request", error: "picks is { <area>: [case ids] | null }" } }).call("run_setup", { draft: "vabc", picks: 3 });
  assert.match(textOf(refused), /picks is/);
});

test("keep_results keeps on a draft or on main, and says a replay was left out", async () => {
  const { plane, call } = tool({ keep_results: (args) => ({ status: "ok", ...(args.draft === "main" ? {} : { rev: 5 }), kept: { pass: true, headline: "all held", regressed: 0, areas: {} }, results: 2, noted: null }) });
  const onDraft = jsonOf(await call("keep_results", { draft: "vabc", report: "Tex replay: ✅ all held\n## Lab replay\nmine", link: "https://example.invalid/r" }));
  assert.deepEqual([onDraft.rev, onDraft.results, onDraft.kept.headline], [5, 2, "all held"]);
  assert.match(onDraft.replay, /not kept/);
  assert.deepEqual(plane.calls[0].args, { draft: "vabc", report: "Tex replay: ✅ all held\n## Lab replay\nmine", link: "https://example.invalid/r" });
  const onMain = jsonOf(await call("keep_results", { draft: "main", report: "Tex replay: ✅ all held" }));
  assert.equal(onMain.rev, undefined);
  assert.equal((await call("keep_results", { draft: "vabc" })).isError, true, "a report is needed");
});

test("get of main answers main's kept results, briefly, newest last", async () => {
  const results = Array.from({ length: 25 }, (_, i) => ({ at: i, raw: "x".repeat(3000), headline: `run ${i}`, areas: {} }));
  const { plane, call } = tool({ get: { status: "ok", id: "main", name: "main", results: JSON.stringify(results) } });
  const answer = jsonOf(await call("get", { draft: "main" }));
  assert.deepEqual(plane.calls[0].args, { draft: "main" });
  assert.equal(answer.results.length, 20);
  assert.equal(answer.results.at(-1).headline, "run 24");
  assert.equal(answer.results[0].raw, undefined, "the pasted text only with full");
  assert.equal(answer.resultsKept, 25);
  assert.match(answer.older, /5 older/);
  const full = jsonOf(await call("get", { draft: "main", limit: 2, full: true }));
  assert.equal(full.results.length, 2);
  assert.equal(full.results[0].raw.length, 3000);
});

test("check knows a draft's own models, as the Lab does, and says what Promote needs for one", () => {
  const g = mainGraph();
  const id = g.nodes.find((n) => n.model !== "code").id;
  g.models = { "x-mine": { name: "Mine", full: "Mine", id: "vendor/mine", runs: "api", custom: true }, "x-haiku": { name: "My Haiku", full: "My Haiku", id: TEX_CONFIG.models["haiku-5-5"], runs: "claude", custom: true } };
  g.nodes.find((n) => n.id === id).model = "x-mine";
  assert.ok(draftProblems(g).some((p) => p.includes(`this draft's own model "x-mine" (vendor/mine)`)));
  g.nodes.find((n) => n.id === id).model = "x-haiku";
  assert.ok(draftProblems(g).some((p) => p.includes(`set the step's model to "haiku-5-5"`)));
  g.nodes.find((n) => n.id === id).model = "nowhere";
  assert.ok(draftProblems(g).some((p) => p.includes("neither one of this draft's own models")));
});

test("revert answers what it undid with the checks, or what refused it", async () => {
  const { plane, call } = tool({ revert: { status: "ok", rev: 9, said: ["undid rev 3: added step reviewer"] }, get: { status: "ok", rev: 9, graph: JSON.stringify(mainGraph()) } });
  const answer = jsonOf(await call("revert", { draft: "vabc", rev: 3 }));
  assert.deepEqual(plane.calls[0].args, { draft: "vabc", rev: 3, to: undefined });
  assert.deepEqual([answer.rev, answer.kept, answer.problems], [9, ["undid rev 3: added step reviewer"], []]);
  const lost = jsonOf(await tool({ revert: { status: "conflict", rev: 6, keys: ["n:fd:effort"], later: [{ rev: 6, via: "lab", said: ["set fd effort medium → high"] }], next: "revert those first" } }).call("revert", { draft: "vabc", rev: 2 }));
  assert.match(lost.refused, /later change/);
  assert.deepEqual(lost.pieces, ["n:fd:effort"]);
  assert.equal(lost.later[0].rev, 6);
});
