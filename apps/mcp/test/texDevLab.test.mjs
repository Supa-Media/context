/**
 * `tex_dev` sim, compare, config, bench, modules and reference (`src/texDev/lab.js`; Dev2, 2026-11-15: "anything that
 * can be done inside of the lab should be able to be done inside of the MCP"): what the Tex Lab computes and shows in
 * the browser, answered by the Lab's own functions (`lab.generated.js`, the Lab's `engine/forMcp.ts` bundled by
 * `scripts/tex-dev-lab.mjs`; CI fails when it is stale). Each test holds an action's answer against the Lab's function
 * on the same input, and against something the Lab's numbers must say on their own.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted (2026-11-15).
 *
 *  1. `withLab` not putting the draft in the Lab's state (`lab.cur = cur` dropped). → "sim times the draft against
 *     main" and "config gives the Lab's changes, warnings and its config JSON" fail.
 *  2. `labSim` reading the pasted log against nothing (`read` always null). → "a pasted step log is the Lab's Use
 *     this log" fails.
 *  3. `labBench` counting every case as in the run (`isPicked` → true). → "bench shows the areas and an area's cases
 *     with the draft's picks and the shared edits" fails.
 *  4. `labModules` diffing against the draft's own words (`m0` = `v`). → "modules lists edited modules and diffs one
 *     against main" fails.
 *  5. `snapshot` dropping the traced test (`sim: null` passed). → "snapshot with a test carries each step's time and
 *     the stats chip" fails.
 *  6. `labWording` answering `{}`. → "get's vsMain names the modules' words and conversation settings" fails.
 *  7. `simulate` (engine/sim.ts) without the "next" tag. → "sim walks the door chain to the front door" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTexDev } from "../src/texDev/tool.js";
import { guideText } from "../src/texDev/guide.js";
import { TESTS_SHOWN } from "../src/texDev/lab.js";
import { TEX_CONFIG } from "../src/agent/texConfig.js";
import { config, fmtS, lab, labTests, promptText, simulate, withLab } from "../src/texDev/lab.generated.js";

const LAB_ACTIONS = ["sim", "compare", "config", "bench", "modules", "reference"];
const mainGraph = () => JSON.parse(JSON.stringify({ nodes: TEX_CONFIG.nodes, edges: TEX_CONFIG.edges }));
const textOf = (result, i = 0) => result.content.filter((c) => c.type === "text")[i]?.text ?? "";
const jsonOf = (result, i = 0) => JSON.parse(textOf(result, i));

const session = { accessToken: "tok" };
/** A control plane that answers `answers[action]` (a value or a function of args) and records each call. */
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
const draftRow = (graph, extra = {}) => ({ status: "ok", name: "Opus door", by: "@dev", rev: 3, graph: JSON.stringify(graph), picks: "{}", areas: null, results: "[]", ...extra });
const NO_CASES = { status: "ok", caseEdits: [] };
const devWith = (answers, env = {}) => createTexDev({ env, session, controlPlane: fakePlane(answers) });

/** Main with the front door on Opus: slower and dearer, and a setup field (models.main). */
function opusDoor() {
  const g = mainGraph();
  g.nodes.find((n) => n.id === "fd").model = "opus-5-5";
  return g;
}

test("the guide and the tool's schema name every Lab action", () => {
  const text = guideText();
  for (const action of LAB_ACTIONS) assert.match(text, new RegExp(`- ${action} `), action);
  assert.match(text, /call `config`, save its config JSON block unchanged as lab\.json/);
  assert.doesNotMatch(text, /not offered here/);
});

test("each call puts the Lab's state back, so one draft never leaks into the next answer", async () => {
  const before = { cur: lab.cur.id, scn: lab.scn, edits: Object.keys(lab.caseEdits).length };
  const edit = { key: "core/new-9", data: JSON.stringify({ area: "core", id: "new-9", ask: "where is my passport?", expect: "x", isNew: true }) };
  const traced = jsonOf(await devWith({ get: draftRow(opusDecide()), cases: { status: "ok", caseEdits: [edit] } })("sim", { draft: "vopus", test: "core/new-9" }));
  assert.equal(traced.test.name, "where is my passport?");
  assert.deepEqual({ cur: lab.cur.id, scn: lab.scn, edits: Object.keys(lab.caseEdits).length }, before);
  // The new case was a test only while its edit was there.
  assert.equal((await devWith({ cases: NO_CASES })("sim", { test: "core/new-9" })).isError, true);
});

test("sim with no test answers the Lab's first test and lists the tests, 20 at most", async () => {
  const answer = jsonOf(await devWith({ cases: NO_CASES })("sim", {}));
  const tests = labTests({ draft: { id: "main", name: "main" } });
  assert.equal(answer.test.key, tests[0].key);
  assert.equal(answer.testsTotal, tests.length);
  assert.ok(answer.tests.length <= TESTS_SHOWN && answer.tests.length > 0);
  assert.equal(answer.untilReply.vsBase, "same as main");
  // The Lab's own simulation of main on the same test, as its Speed and cost view draws it.
  const want = withLab({ draft: { id: "main", name: "main" } }, () => simulate(lab.cur.graph, lab.scn, null), { test: answer.test.key });
  assert.equal(answer.untilReply.value, fmtS(want.reply));
  assert.equal(answer.replySent, fmtS(want.reply));
});

/** Main with Decide on Opus instead of Clef: a step every text reaches, now slower and dearer. */
function opusDecide() {
  const g = mainGraph();
  g.nodes.find((n) => n.id === "decide").model = "opus-5-5";
  return g;
}

test("sim times the draft against main: dearer, off the critical path, step by step with what each reads", async () => {
  const dev = devWith({ get: draftRow(opusDecide()), cases: NO_CASES });
  // A group text: Triage sends it to Decide (a lone 1:1 text goes straight to the Queue, and Decide never runs).
  const key = labTests({ draft: { id: "main", name: "main" } }).find((t) => t.key === "pipeline/group-chatter-kept").key;
  const answer = jsonOf(await dev("sim", { draft: "vopus", test: key }));
  assert.equal(answer.version, "Opus door");
  assert.equal(answer.test.key, key);
  assert.equal(answer.base, "main");
  // Decide runs beside the Front door now (the Provisional run, Dev2, 2026-11-17): a slower Decide that still gives its
  // go before the Front door's draft is ready costs more but no time.
  assert.equal(answer.untilReply.vsBase, "same as main");
  assert.match(answer.cost.vsBase, /^\+\$[\d.]+ vs main$/);
  const decide = answer.whereTheTimeGoes.find((s) => s.step === "decide");
  assert.equal(decide.model, "Opus");
  assert.match(decide.reads, /^[\d.]+k tokens, \d+% cached$/);
  assert.ok(decide.outputTokens > 0);
  assert.equal(decide.parts[0].part, "Its own work");
  // Lanes in the Lab's order: before the reply, then the job, then after the reply.
  const order = { "Before the reply": 0, "Background job": 1, "After the reply": 2 };
  const lanes = answer.whereTheTimeGoes.map((s) => order[s.lane]);
  assert.deepEqual(lanes, [...lanes].sort((a, b) => a - b));
  const want = withLab({ draft: { id: "vopus", name: "Opus door", graph: opusDecide() } }, () => simulate(lab.cur.graph, lab.scn, null), { test: key });
  assert.equal(answer.untilReply.value, fmtS(want.reply));
  // Against itself, nothing differs.
  const self = jsonOf(await dev("sim", { draft: "vopus", test: key, base: "vopus" }));
  assert.equal(self.untilReply.vsBase, "same as Opus door");
});

test("sim walks the door chain to the front door and the reply, as a real turn does", async () => {
  const dev = devWith({ cases: NO_CASES });
  const key = labTests({ draft: { id: "main", name: "main" } }).find((t) => t.key.startsWith("core/")).key;
  const answer = jsonOf(await dev("sim", { draft: "main", test: key }));
  const steps = answer.whereTheTimeGoes.map((s) => s.step);
  assert.ok(steps.includes("fd"), `the front door runs: ${steps.join(", ")}`);
  assert.ok(steps.includes("send"), "and Tex texts back");
});

test("sim traces a message you type, and refuses a test there is not", async () => {
  const dev = devWith({ cases: NO_CASES });
  const typed = jsonOf(await dev("sim", { text: "should I take the job in Denver?" }));
  assert.equal(typed.test.key, "own");
  assert.equal(typed.test.name, "should I take the job in Denver?");
  assert.ok(typed.test.tags.includes("stuck"));
  const none = await dev("sim", { test: "core/not-a-test" });
  assert.equal(none.isError, true);
  assert.match(textOf(none), /There is no test "core\/not-a-test"/);
});

test("a pasted step log is the Lab's Use this log: measured steps replace guesses", async () => {
  const dev = devWith({ cases: NO_CASES });
  const log = ['{"node":"fd","model":"haiku-5-5","ms":4100,"in":21000,"out":310}', "not json", '{"node":"fd","side":"main","ms":1}'].join("\n");
  const answer = jsonOf(await dev("sim", { log }));
  assert.equal(answer.measured.steps, 1);
  assert.equal(answer.measured.skippedLines, 1);
  assert.deepEqual(answer.measured.rows.map((r) => [r.calls, r.logged, r.how]), [[1, "4.1 s", "from 310 tokens"]]);
  const nothing = jsonOf(await dev("sim", { log: '{"node":"nope"}' }));
  assert.equal(nothing.measured.note, "No lines matched this version's steps");
});

test("compare lists main and each draft with reply time, cost and each area's latest score", async () => {
  const main = JSON.stringify([{ at: 1, areas: { core: { practice: [3, 4], held: [1, 2], usd: 0 } }, raw: "" }]);
  const d = { ...draftRow(opusDoor()), id: "vopus", results: JSON.stringify([{ at: 2, areas: { core: { practice: [1, 4], held: [0, 2], usd: 0 } }, raw: "" }, { at: 3, areas: { core: { practice: [4, 4], held: [2, 2], usd: 0 } }, raw: "" }]) };
  const plane = fakePlane({ versions: { status: "ok", main: { results: main }, drafts: [d] }, cases: NO_CASES });
  const dev = createTexDev({ env: {}, session, controlPlane: plane });
  const answer = jsonOf(await dev("compare", {}));
  assert.deepEqual(answer.versions.map((v) => [v.id, v.by, v.areas.core]), [["main", "live", "3/4, held 1/2"], ["vopus", "@dev", "4/4, held 2/2"]]);
  const sim = jsonOf(await devWith({ get: draftRow(opusDoor()), cases: NO_CASES })("sim", { draft: "vopus", test: answer.test.key }));
  assert.equal(answer.versions[1].reply, sim.untilReply.value);
  assert.equal(answer.versions[1].cost, sim.cost.value);
  await dev("compare", { drafts: ["vopus", "../x"] });
  assert.deepEqual(plane.calls.filter((c) => c.action === "versions").map((c) => c.args), [{}, { drafts: ["vopus"] }]);
});

test("config gives the Lab's changes, warnings and its config JSON, and the prompt when asked", async () => {
  const dev = devWith({ get: draftRow(opusDoor()), cases: NO_CASES });
  const result = await dev("config", { draft: "vopus" });
  const summary = jsonOf(result, 0);
  const fd = summary.changes.find((c) => c.node === "fd" && c.what === "model");
  assert.deepEqual([fd.from, fd.to, fd.shipsAs], ["Haiku 5.5", "Opus 5.5", "setup: models.main"]);
  assert.ok(summary.warnings.some((w) => /A model swap only proves the wiring/.test(w)));
  assert.ok(summary.areas.find((a) => a.area === "core").run);
  assert.ok(summary.areas.find((a) => a.area === "core").byDefault);
  assert.match(summary.next, /save it, unchanged, as lab\.json/);
  // The second block is exactly the Lab's "Copy config JSON": its own config() on the same draft.
  const want = withLab({ draft: { id: "vopus", name: "Opus door", graph: opusDoor(), picks: {} } }, () => config());
  assert.equal(textOf(result, 1), JSON.stringify(want, null, 2));
  assert.equal(JSON.parse(textOf(result, 1)).setup["models.main"], "anthropic/claude-opus-5-5");
  assert.equal(result.content.length, 2);
  const withPrompt = await dev("config", { draft: "vopus", prompt: true });
  assert.equal(textOf(withPrompt, 2), withLab({ draft: { id: "vopus", name: "Opus door", graph: opusDoor(), picks: {} } }, () => promptText(config())));
  assert.match(textOf(withPrompt, 2), /^Tex lab run for version "Opus door"/);
  // Main is a baseline, with main's kept runs.
  const main = jsonOf(await devWith({ versions: { status: "ok", main: { results: "[]" }, drafts: [] }, cases: NO_CASES })("config", {}), 0);
  assert.deepEqual(main.changes, []);
  assert.equal(main.note, "Same as main. A run now is a baseline.");
});

test("bench shows the areas and an area's cases with the draft's picks and the shared edits", async () => {
  const g = mainGraph();
  const decide = g.nodes.find((n) => n.id === "decide");
  decide.ctx = decide.ctx.filter((c) => c !== "recent");
  const picks = { respond: ["g-bot-reply-under-person"] };
  const edit = { key: "respond/g-bot-reply-under-person", data: JSON.stringify({ area: "respond", id: "g-bot-reply-under-person", ask: "@omar: who has the cooler?", expect: "Stay quiet" }) };
  const fresh = { key: "respond/new-1", data: JSON.stringify({ area: "respond", id: "new-1", ask: "The text", expect: "What's right", isNew: true }) };
  const dev = devWith({ get: draftRow(g, { picks: JSON.stringify(picks) }), cases: { status: "ok", caseEdits: [edit, fresh] } });
  const all = jsonOf(await dev("bench", { draft: "vbench" }));
  const respond = all.areas.find((a) => a.area === "respond");
  assert.match(respond.inRun, /^1\/\d+$/);
  assert.ok(respond.cantTestAsWritten > 0);
  assert.ok(all.people.some((p) => p.name === "Maya"));
  assert.ok(all.workspaces.some((w) => w.ws === "maya"));
  const area = jsonOf(await dev("bench", { draft: "vbench", area: "respond", limit: 5 }));
  assert.equal(area.cases.length, 5);
  assert.ok(area.more);
  const carpool = area.cases.find((c) => c.id === "g-bot-reply-under-person");
  assert.deepEqual([carpool.inRun, carpool.edit, carpool.ask, carpool.checks], [true, "edited", "@omar: who has the cooler?", "act = quiet"]);
  assert.ok(carpool.cantTest.some((w) => /no longer reads/.test(w)));
  assert.ok(area.cases.filter((c) => c.id !== "g-bot-reply-under-person").every((c) => !c.inRun));
  assert.ok(area.panel.in.some((m) => m.is === "the step no longer reads it"));
  assert.equal(area.runsAs.workspace, "none");
  const found = jsonOf(await dev("bench", { draft: "vbench", area: "respond", query: "cooler" }));
  assert.ok(found.cases.some((c) => c.id === "g-bot-reply-under-person"));
  const core = jsonOf(await devWith({ cases: NO_CASES })("bench", { area: "core", limit: 1 }));
  assert.equal(core.runsAs.person, "Maya");
  assert.ok(core.panel.path.length > 2);
  const ws = jsonOf(await devWith({})("bench", { ws: "maya" }));
  assert.ok(ws.notes > 5 && typeof ws.text === "string");
  assert.equal((await devWith({})("bench", { ws: "nobody" })).isError, true);
  assert.equal((await devWith({ cases: NO_CASES })("bench", { area: "nowhere" })).isError, true);
});

test("modules lists edited modules and diffs one against main", async () => {
  const g = mainGraph();
  g.modules = { "p-rules": { text: "Be kind. Never send a link you have not opened." } };
  const dev = devWith({ get: draftRow(g) });
  const list = jsonOf(await dev("modules", { draft: "vmods" }));
  const rules = list.flatMap((s) => s.modules).find((m) => m.key === "p-rules");
  assert.equal(rules.pill, "edited");
  assert.ok(rules.usedBy.length > 0);
  const one = jsonOf(await dev("modules", { draft: "vmods", key: "p-rules" }));
  assert.equal(one.text, "Be kind. Never send a link you have not opened.");
  assert.notEqual(one.fingerprint, one.main);
  assert.ok(one.diff.some(([k]) => k === "+") && one.diff.some(([k]) => k === "-"));
  const main = jsonOf(await devWith({})("modules", { key: "p-rules" }));
  assert.equal(main.diff, undefined);
  assert.equal(main.words, "+0 −0");
  assert.equal((await devWith({})("modules", { key: "nope" })).isError, true);
});

test("reference answers the Lab's catalogues, and the Tools tab's count of a pasted record", async () => {
  const dev = devWith({});
  assert.deepEqual(jsonOf(await dev("reference", {})).topics, ["tools", "steps", "groups", "ledger", "areas", "models", "wires", "sources", "convo"]);
  const tools = jsonOf(await dev("reference", { topic: "tools" }));
  assert.ok(tools.tools.some((t) => t.tool === "write" && t.actions.includes("remember")));
  assert.ok(tools.calledBy.includes("fd"));
  const log = ['{"kind":"tool","name":"write","args":{"action":"save"},"ok":true,"ms":400}', '{"kind":"tool","name":"write","args":{"action":"save"},"ok":false,"ms":90,"reason":"conflict"}'].join("\n");
  const counted = jsonOf(await dev("reference", { topic: "tools", log }));
  const write = counted.tools.find((t) => t.tool === "write");
  assert.deepEqual([write.stats.calls, write.stats.errors, write.byAction.save.calls], [2, 1, 2]);
  const steps = jsonOf(await dev("reference", { topic: "steps" }));
  assert.ok(steps.find((s) => s.step === "fd").logs.got);
  const ledger = jsonOf(await dev("reference", { topic: "ledger" }));
  assert.equal(ledger.find((k) => k.entry === "tool").inThePrompt, "names only");
  assert.ok(jsonOf(await dev("reference", { topic: "areas" })).some((a) => a.area === "core" && a.as === "Maya"));
  // Groups: what opening one on the canvas draws, its steps and the wires out as the canvas's pills.
  const intake = jsonOf(await dev("reference", { topic: "groups", group: "intake" }));
  assert.equal(intake.length, 1);
  assert.ok(intake[0].steps.includes("decide"));
  assert.ok(intake[0].to.some((p) => p.outside === "fd" && p.is === "step"));
  assert.ok(jsonOf(await dev("reference", { topic: "groups" })).some((x) => x.group === "tools-subagents"));
  assert.match(textOf(await dev("reference", { topic: "groups", group: "nope" })), /no group called "nope"/);
});

test("get's vsMain names the modules' words and conversation settings the draft changes", async () => {
  const g = mainGraph();
  g.modules = { "p-rules": { text: "Shorter rules." } };
  g.convo = { word: 12 };
  const answer = jsonOf(await devWith({ get: draftRow(g) })("get", { draft: "vwords" }));
  assert.deepEqual(answer.vsMain.modules.map((m) => [m.module, m.what]), [["p-rules", "wording"]]);
  assert.deepEqual(answer.vsMain.convo.map((c) => [c.what, c.from, c.to]), [["word for word, hours", 24, 12]]);
});

test("snapshot with a test carries each step's time and the stats chip; without one, nothing is timed", async () => {
  const pages = [];
  const env = { SITE_SHOTS: { fetch: async (_u, init) => (pages.push(JSON.parse(init.body).html), new Response(JSON.stringify({ png: "iVBORw0KGgo=", width: 800, height: 600 }))) } };
  const dev = devWith({ cases: NO_CASES }, env);
  await dev("snapshot", {});
  assert.doesNotMatch(pages[0], /id="stats"/);
  assert.doesNotMatch(pages[0], /class="tm"/);
  const key = labTests({ draft: { id: "main", name: "main" } }).find((t) => t.key.startsWith("core/")).key;
  const shot = await dev("snapshot", { test: key });
  assert.equal(shot.content[0].type, "image");
  assert.match(pages[1], /<div class="float stats" id="stats"[^>]*><span title="How long they waited for the reply"><b>[\d.]+ s<\/b>/);
  assert.match(pages[1], /class="tm"[^>]*>[\d.]+ s</);
  const typed = await dev("snapshot", { text: "what's on my calendar this week?" });
  assert.equal(typed.content[0].type, "image");
  assert.match(pages[2], /what&#39;s on my calendar this week\?|what's on my calendar this week\?/);
  const bad = await dev("snapshot", { test: "core/nope" });
  assert.equal(bad.isError, true);
});
