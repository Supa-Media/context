/**
 * A bot sent an area's routine reads everything the run needs with the note, worked out at its own clearance (Seyi,
 * 2026-11-26, the area routines backlog): the metric's value now and its readings, the seat, sub-areas, the area
 * above, the budget and where heavy lifting goes (`src/orient/areaContext.js`, `areaMetrics.js`, `routineBrief.js`).
 * Pulse checks write an area's routines from templates (`src/tools/notes/areaPulse.js`), and one routine can run at
 * several times a day (`packages/shared/src/areaRoutines.cjs` `routineTimes`, decided by the owner, 2026-11-27).
 *
 * ## Sabotage record
 *
 * Reading a metric's sheets without `canSee` (in `areaMetrics.js` `sheetAt`) fails "a sheet this connection can't
 * read makes the value hidden". Dropping `withRoutineBrief` from `read_note` in `dispatch.js` fails "fetching a
 * routine note brings its run brief". Writing a template over a note already there fails "pulse keeps a routine
 * already there".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { callTool } from "../src/tools/dispatch.js";
import { toolOrient } from "../src/orient/tool.js";
import { toolSetArea } from "../src/tools/notes/setArea.js";
import { withPrivacyAuthority } from "../src/store/privacyAuthority.js";
import { PrivacyOverrides } from "../src/privacy/engine.js";
import { createMemoryStore } from "./gmailSync/fixtures.mjs";
import { withServedTree } from "./servedTree.mjs";
import areaRoutines from "../../../packages/shared/src/areaRoutines.cjs";
import templates from "../../../packages/shared/src/areaRoutineTemplates.cjs";

const { areaRoutineOf, areaRoutineNext, areaRoutineWhen } = areaRoutines;
const RULES = [
  { prefix: "areas", vis: "team" },
  { prefix: "data", vis: "team" },
  { prefix: "bots", vis: "team" },
  { prefix: "data/payroll", vis: "private" },
];
const FOLDERS = RULES.map(({ prefix, vis }) => ({ prefix, visibility: vis }));
const today = new Date().toISOString().slice(0, 10);

const NOTES = {
  "areas/about.md": "---\nowner: \"@seyi\"\ndelegate: Grok Bot\n---\n# Areas\n",
  "areas/finance/about.md": "---\nowner: Finance\nmodes: [Manager, Doer]\nmetrics: [Monthly cost · target under $600]\n---\n# Finance\n\nKeeps spending in check.\n",
  "areas/finance/payroll/about.md": "---\nowner: \"@seyi\"\ndelegate: Finance\nmetrics: [Payroll cost · target under $5000]\n---\n# Payroll\n",
  "areas/finance/routines/daily/check.md": "---\nat: 9am, 3pm\nmode: Manager\n---\nCheck the spend.\n",
  "areas/finance/metrics.csv": "week:date,value:number\n2026-11-16,1\n",
  "bots/finance/about.md": "---\nholder: Finance\nbot: grok\nbelongs_to: \"@seyi\"\nworks_in: [areas/finance · 20%]\n---\n",
  "areas/people/seyi.md": "---\nheavy_lifting: Claude Code\n---\n# Seyi\n",
  "data/metrics/monthly-cost.md": "---\nmetric: Monthly cost\nformula: sum(costs/charges.usd)\nevery: month\nformat: $0.00\n---\n# Monthly cost\n",
  "data/metrics/payroll-cost.md": "---\nmetric: Payroll cost\nformula: sum(payroll/runs.usd)\nevery: month\nformat: $0.00\n---\n# Payroll cost\n",
  "data/costs/charges.csv": `date:date,usd:usd\n${today},120\n${today},30.5\n`,
  "data/payroll/runs.csv": `date:date,usd:usd\n${today},4000\n`,
};

async function world(notes = NOTES) {
  const base = createMemoryStore();
  for (const [key, text] of Object.entries(notes)) await base.put(key, text);
  const store = withPrivacyAuthority(withServedTree(base), {
    rules: { etag: "rows-v1", accessVersion: 1, folders: FOLDERS, notes: [] },
    async setAccess(change) {
      return { ok: true, version: (change.expectedVersion ?? 1) + 1 };
    },
  });
  store.actor = { workspaceId: "ws-test", workspaceKind: "shared", role: "owner" };
  const served = store.treeFacts;
  store.treeFacts = async (request) =>
    request.ask === "jobs" ? { served: true, jobs: { areas: "areas", projects: "projects", data: "data" }, roots: ["areas", "projects", "data"] } : served(request);
  store.treeEntries = async () => (await base.list({})).objects;
  const text = async (key) => (await (await base.get(key))?.text()) ?? null;
  return { store, base, text };
}

const said = (result) => result.content.map((part) => part.text).join("\n");

test("orient area works the metric out now, for the area and each sub-area, with where readings are kept", async () => {
  const { store } = await world();
  const out = said(await toolOrient(store, "private", RULES, new PrivacyOverrides(), { area: "areas/finance" }));
  assert.match(out, /## The metric now\n- Metric: Monthly cost · target under \$600\n  - Now \(this month\): \$150\.50\n  - Defined in data\/metrics\/monthly-cost\.md: Sum of usd in costs\/charges, each month/);
  assert.match(out, /Recorded readings: `areas\/finance\/metrics\.csv`/);
  assert.match(out, /- areas\/finance\/payroll\/ — owner @seyi, delegate Finance · mail `areas\/finance\/payroll\/mail\/`[^\n]*\n  - Metric: Payroll cost · target under \$5000\n    - Now \(this month\): \$4,?000\.00/);
});

test("a sheet this connection can't read makes the value hidden, never a number or a reason", async () => {
  const { store } = await world();
  const out = said(await toolOrient(store, "team", RULES, new PrivacyOverrides(), { area: "areas/finance" }));
  assert.match(out, /  - Metric: Payroll cost · target under \$5000\n    - Now \(this month\): hidden\n/);
  assert.doesNotMatch(out, /4,?000|runs\.csv/);
  // The area's own metric, whose sheet is team, still reads.
  assert.match(out, /Now \(this month\): \$150\.50/);
});

test("the area above, and heavy lifting as its person said it, or the default when nobody did", async () => {
  const { store } = await world();
  const out = said(await toolOrient(store, "team", RULES, new PrivacyOverrides(), { area: "areas/finance" }));
  assert.match(out, /## Above this area\n- areas\/ — owner @seyi, delegate Grok Bot \(ask Grok Bot first\) · mail `areas\/mail\/<your name>\.md`/);
  assert.match(out, /## Heavy lifting\nCode changes, long research and big file work go through Claude Code \(said in `areas\/people\/seyi\.md`\)/);
  const { store: bare } = await world({ ...NOTES, "areas/people/seyi.md": "# Seyi\n" });
  assert.match(said(await toolOrient(bare, "team", RULES, new PrivacyOverrides(), { area: "areas/finance" })), /Nobody has said where heavy lifting goes for @seyi, so use Claude Code if the person has it, otherwise Codex\./);
});

test("fetching a routine note brings its run brief after the note; another note doesn't", async () => {
  const { store } = await world();
  const out = said(await callTool("read_note", { path: "areas/finance/routines/daily/check.md" }, store, "team"));
  assert.match(out, /Check the spend\./);
  assert.match(out, /# Run brief/);
  assert.match(out, /- Routine: `areas\/finance\/routines\/daily\/check\.md`, every day at 9 am and 3 pm\./);
  assert.match(out, /- For: the Manager mode here; Finance runs it\./);
  assert.match(out, /# Area: Finance[\s\S]*Now \(this month\): \$150\.50[\s\S]*## Budget\nFinance may spend 20% of its weekly usage here/);
  assert.ok(out.indexOf("Check the spend.") < out.indexOf("# Run brief"));
  // One text part, the note then its brief: a client that shows only the first part still shows the brief.
  const parts = (await callTool("read_note", { path: "areas/finance/routines/daily/check.md" }, store, "team", { fetchCap: true })).content;
  assert.equal(parts.length, 1);
  assert.match(parts[0].text, /Check the spend\.[\s\S]*# Run brief/);
  assert.doesNotMatch(said(await callTool("read_note", { path: "areas/finance/about.md" }, store, "team")), /# Run brief/);
});

test("a routine fetched where the tree names no Areas folder still brings its brief, from the folder it is in", async () => {
  const { store } = await world();
  const served = store.treeFacts;
  store.treeFacts = async (request) => (request.ask === "jobs" ? { served: false } : served(request));
  const out = said(await callTool("read_note", { path: "areas/finance/routines/daily/check.md" }, store, "team"));
  assert.match(out, /# Run brief/);
  assert.match(out, /The areas folder is `areas\/`; this area is `areas\/finance\/`\./);
});

test("the brief is worked out over the tree's listing, as orient is, not the store's own (which lists nothing)", async () => {
  const { store } = await world();
  delete store.treeEntries;
  const out = said(await callTool("read_note", { path: "areas/finance/routines/daily/check.md" }, store, "team", { fetchCap: true }));
  assert.match(out, /# Run brief[\s\S]*# Area: Finance/);
});

test("several times under a folder that already runs through the day says where the note goes instead", () => {
  const routine = areaRoutineOf("areas/finance/routines/every-2-hours/loop.md", "areas");
  const next = areaRoutineNext(routine, "---\nat: 9am, 1pm\n---\n", Date.now());
  assert.equal(next.at, null);
  assert.match(next.problems[0], /Move the note to routines\/daily\//);
});

test("pulse writes the area's routines from its modes, keeps a routine already there, and pauses only what it wrote", async () => {
  const { store, text } = await world({ ...NOTES, "areas/finance/routines/daily/manager-loop.md": "---\nat: 7am\n---\nMy own loop.\n" });
  const run = (args) => toolSetArea(store, "team", RULES, new PrivacyOverrides(), args);
  const on = said(await run({ area: "areas/finance", pulse: true }));
  assert.match(on, /areas\/finance\/routines\/daily\/improve-your-metric\.md: written \(improve-your-metric\)/);
  assert.match(on, /areas\/finance\/routines\/daily\/ship-the-next-item\.md: written \(doer-ship-next\)/);
  assert.match(on, /manager-loop\.md: kept/);
  assert.doesNotMatch(on, /direction-check/);
  assert.equal(await text("areas/finance/routines/daily/manager-loop.md"), "---\nat: 7am\n---\nMy own loop.\n");
  const improve = await text("areas/finance/routines/daily/improve-your-metric.md");
  assert.match(improve, /^---\nat: 9am\ntimezone: America\/New_York\ntemplate: improve-your-metric\n---\n# Improve your metric\n/);
  // Every template is a routine Context runs.
  for (const template of [templates.IMPROVE_METRIC, ...templates.MODE_TEMPLATES]) {
    const path = templates.templatePath("areas/finance", template);
    assert.equal(typeof areaRoutineNext(areaRoutineOf(path, "areas"), templates.templateText(template), Date.now()).at, "number", path);
  }
  const off = said(await run({ area: "areas/finance", pulse: false }));
  assert.match(off, /improve-your-metric\.md: paused/);
  assert.doesNotMatch(off, /manager-loop/);
  assert.match(await text("areas/finance/routines/daily/improve-your-metric.md"), /^paused: "?yes"?$/m);
  assert.match(said(await run({ area: "areas/finance", pulse: true })), /improve-your-metric\.md: resumed/);
  assert.doesNotMatch(await text("areas/finance/routines/daily/improve-your-metric.md"), /^paused:/m);
});

test("one routine runs at several times a day, in order, and says each; a time it can't read is a problem", () => {
  const routine = areaRoutineOf("areas/x/routines/daily/check.md", "areas");
  const text = "---\nat: [5pm, 9am, 1pm]\n---\nDo it.\n";
  const start = Date.parse("2026-11-27T15:00:00Z"); // 10 am in New York
  const runs = [];
  for (let at = start, i = 0; i < 4; i++) runs.push((at = areaRoutineNext(routine, text, at).at));
  assert.deepEqual(runs.map((ms) => new Date(ms).toISOString()), ["2026-11-27T18:00:00.000Z", "2026-11-27T22:00:00.000Z", "2026-11-28T14:00:00.000Z", "2026-11-28T18:00:00.000Z"]);
  assert.equal(areaRoutineWhen(routine, text), "Every day at 9 am, 1 pm and 5 pm");
  assert.match(areaRoutineNext(routine, "---\nat: 9am, teatime\n---\n", start).problems.join(" "), /"teatime" in "at: 9am, teatime" isn't a time/);
  assert.equal(areaRoutineNext(routine, "---\nat: 9am, teatime\n---\n", start).at, null);
  const hourly = areaRoutineOf("areas/x/routines/every-3-hours/check.md", "areas");
  assert.match(areaRoutineNext(hourly, text, start).problems.join(" "), /only apply to a routine that runs daily, weekly or monthly/);
  // One time is the old behaviour, unchanged.
  assert.equal(new Date(areaRoutineNext(routine, "---\nat: 9am\n---\n", start).at).toISOString(), "2026-11-28T14:00:00.000Z");
});
