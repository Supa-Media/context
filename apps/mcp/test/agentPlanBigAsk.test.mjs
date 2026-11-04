/**
 * Tex's advisor plans a big ask, and the gateway splits it into jobs
 * (`planBigAsk.js`, Dev, 2026-11-04); and one round may start several jobs
 * (`turn.js`: a start used to end the turn before the next call in its round
 * ran, so a split ask never had a second part).
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *  1. `turn.js` settling at the first start again (the return moved back into the call loop).
 *     → "two starts in one round both start, and the turn texts one line naming both" fails.
 *  2. `parsePlan` not capping parts at the free slots.
 *     → "a plan is read strictly and never has more parts than free slots" fails.
 *  3. `planFolder` letting `..` through.
 *     → "a folder that climbs out, hides or names another workspace is refused" fails.
 *  4. `planCall` starting jobs before every note is written.
 *     → "a note that can't be written starts nothing" fails.
 *  5. `planCall` skipping the overview's existence check.
 *     → "a project note already there is never written over" fails.
 *  6. `readPlanSetting` reading anything but on as on, or the setup allowing it with no advisor.
 *     → "the planner is a setup switch, on only with an advisor" fails.
 *  7. `splitFirst` starting a lone job at once (2026-11-04, splitting bench gh-149).
 *     → "with the planner on, a lone job is offered the planner once, then starts" fails.
 *  8. `splitFirst` asking a part the planner started, or a job after the planner was called.
 *     → "the planner's own parts and its one-job answer are never asked" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BUILTIN_PROVIDER } from "../src/agent/builtin.js";
import { runTurn } from "../src/agent/turn.js";
import { MAX_RUNNING_JOBS, backgroundSession, withBackground } from "../src/agent/background.js";
import { PLAN_DEFINITION, PLAN_TOOL, parsePlan, planCall, planFolder, readPlanSetting, splitFirst } from "../src/agent/planBigAsk.js";
import { parseSetup } from "../src/agent/production.js";

const MODEL = "@cf/zai-org/glm-4.7-flash";
const NOW = Date.UTC(2026, 10, 4, 14, 0, 0);
const words = (result) => result.content.map((part) => part.text).join("");

function scripted(replies) {
  const calls = [];
  return {
    calls,
    async run(model, input) {
      calls.push({ model, input });
      const next = replies.shift();
      if (!next) throw new Error("fake ai: the script ran out");
      return next;
    },
  };
}

const chat = (text, toolCalls = []) => ({
  choices: [{ message: { content: text, tool_calls: toolCalls.map(([name, args], i) => ({ id: `call_${i}`, type: "function", function: { name, arguments: JSON.stringify(args) } })) } }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});

const PLAN = {
  split: true,
  title: "Lisbon trip",
  goal: "Plan the whole Lisbon week.",
  parts: [
    { name: "flights", title: "Find flights", brief: "Flights for October 14 to 18.", done_when: "Three options in the note" },
    { name: "stay", title: "Find a flat", brief: "A flat near Alfama.", done_when: "Three flats in the note" },
    { name: "days", title: "Plan the days", brief: "A day by day plan; ask flights for the times.", done_when: "A plan per day" },
  ],
};

/** A dispatcher that records writes, answers reads of what was written, and fails what `failing` names. */
function notesDispatcher({ existing = [], failing = [] } = {}) {
  const notes = new Map(existing.map((path) => [path, "already here"]));
  const calls = [];
  const callTool = async (name, args) => {
    calls.push({ name, args });
    if (name === "read_note") return notes.has(args.path) ? { content: [{ type: "text", text: notes.get(args.path) }] } : { content: [{ type: "text", text: "not found" }], isError: true };
    if (name === "write_note") {
      if (failing.includes(args.path)) return { content: [{ type: "text", text: "refused" }], isError: true };
      notes.set(args.path, args.content);
      return { content: [{ type: "text", text: "saved" }] };
    }
    return { content: [] };
  };
  return { notes, calls, callTool };
}

const advisor = (answer) => {
  const asked = [];
  return { asked, request: async (params) => (asked.push(params), { text: typeof answer === "string" ? answer : JSON.stringify(answer), usage: { input: 1, output: 1 } }) };
};

const planner = (background, answer, extra = {}) => {
  const fake = advisor(answer);
  background.plan = planCall({ model: "anthropic/claude-opus-5-5", request: fake.request, history: [], question: "plan my lisbon week", background, ...extra });
  return fake;
};

test("two starts in one round both start, and the turn texts one line naming both", async () => {
  const ai = scripted([
    chat("", [
      ["send", { action: "background", args: { title: "Find flights", brief: "Flights.", mail: { path: "1-projects/lisbon/overview.md", name: "flights" } } }],
      ["send", { action: "background", args: { title: "Find a flat", brief: "A flat.", mail: { path: "1-projects/lisbon/overview.md", name: "stay" } } }],
    ]),
  ]);
  const background = backgroundSession({ running: [], job: null, now: NOW });
  const result = await runTurn({
    question: "plan my lisbon week",
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    tools: [...background.tools],
    callTool: withBackground(background, async () => ({ content: [] })),
    env: { AI: ai, AGENT_BUILTIN_MODEL: MODEL },
    providerOptions: { ai },
    texting: true,
    endsTurn: background.endsTurn,
  });
  assert.deepEqual(background.started.map((job) => job.title), ["Find flights", "Find a flat"]);
  assert.equal(ai.calls.length, 1, "no model round after the starts");
  assert.match(result.answer, /^On it, in 2 parts at once: Find flights; Find a flat\./);
  assert.equal(result.settled, "start_background_job");
});

test("a plan is read strictly and never has more parts than free slots", () => {
  assert.equal(parsePlan("no json here", { slots: 3 }), null);
  assert.equal(parsePlan("{not json}", { slots: 3 }), null);
  assert.deepEqual(parsePlan('{"split": false, "how": "now", "why": "one lookup"}', { slots: 3 }), { split: false, how: "now", why: "one lookup" });
  assert.equal(parsePlan('{"split": false, "how": "whatever"}', { slots: 3 }).how, "now");
  const two = parsePlan(`Here it is: ${JSON.stringify(PLAN)}`, { slots: 2 });
  assert.equal(two.parts.length, 2, "capped at the free slots");
  assert.equal(parsePlan(JSON.stringify(PLAN), { slots: 0 }), null, "no slot, no plan");
  const messy = parsePlan(
    JSON.stringify({
      split: true,
      title: "X",
      parts: [
        { name: "Flights Out", title: "A", brief: "a" },
        { name: "flights-out", title: "Dup", brief: "b" },
        { name: "everyone", title: "B", brief: "c" },
        { name: "ok", title: "", brief: "d" },
        { name: "mac", title: "Code", brief: "e", computer: "SOMEONE ELSES" },
        { name: "mine", title: "Code mine", brief: "f", computer: "studio mac" },
      ],
    }),
    { slots: 5, computers: [{ name: "Studio Mac" }] },
  );
  assert.deepEqual(messy.parts.map((part) => part.name), ["flights-out", "mac", "mine"], "bad, duplicate and reserved names dropped");
  assert.equal(messy.parts[1].computer, null, "a computer not theirs runs in the cloud");
  assert.equal(messy.parts[2].computer, "Studio Mac");
});

test("a folder that climbs out, hides or names another workspace is refused", () => {
  assert.equal(planFolder("1-projects/lisbon"), "1-projects/lisbon/");
  assert.equal(planFolder("/1-projects/lisbon/"), "1-projects/lisbon/");
  for (const bad of ["", "/", "../x/", "1-projects/../../x/", ".context/x/", "a/.hidden/", "@supa/projects/", "a//b/", "a\\b/"]) {
    assert.equal(planFolder(bad), null, bad);
  }
});

test("a big ask is planned, its notes written, and one job per part started on the overview's mail", async () => {
  const background = backgroundSession({ running: [], job: null, now: NOW });
  const fake = planner(background, PLAN);
  const { notes, callTool } = notesDispatcher();
  const call = withBackground(background, callTool);
  const result = await call(PLAN_TOOL, { ask: "plan my lisbon week, october 14 to 18", folder: "1-projects/lisbon-trip" });
  assert.equal(result.isError, undefined, words(result));
  assert.deepEqual([...notes.keys()], ["1-projects/lisbon-trip/overview.md", "1-projects/lisbon-trip/flights.md", "1-projects/lisbon-trip/stay.md", "1-projects/lisbon-trip/days.md"]);
  assert.match(notes.get("1-projects/lisbon-trip/overview.md"), /\[\[1-projects\/lisbon-trip\/flights\|Find flights\]\]/);
  assert.match(notes.get("1-projects/lisbon-trip/days.md"), /this part's name in its mail is days/);
  assert.equal(background.started.length, 3);
  for (const job of background.started) assert.equal(job.mail.path, "1-projects/lisbon-trip/overview.md");
  assert.deepEqual(background.started.map((job) => job.mail.name), ["flights", "stay", "days"]);
  assert.match(background.started[0].brief, /Your task note: 1-projects\/lisbon-trip\/flights\.md/);
  assert.match(fake.asked[0].messages[0].text, /Free job slots now: 3\./);
  assert.match(background.endsTurn(PLAN_TOOL), /^On it, in 3 parts at once: Find flights; Find a flat; Plan the days\./);
  const again = await call(PLAN_TOOL, { ask: "again", folder: "1-projects/other" });
  assert.equal(again.isError, true, "one plan a turn");
});

test("the free slots are the plan's ceiling, and none free asks nobody", async () => {
  const one = backgroundSession({ running: [{ id: "job-aaaaaaaa-1", title: "Old one", state: "running", startedAt: NOW - 1 }, { id: "job-aaaaaaaa-2", title: "Old two", state: "running", startedAt: NOW - 1 }], job: null, now: NOW });
  planner(one, PLAN);
  await withBackground(one, notesDispatcher().callTool)(PLAN_TOOL, { ask: "lisbon", folder: "1-projects/lisbon/" });
  assert.equal(one.started.length, 1, `${MAX_RUNNING_JOBS - 2} slot free`);

  const full = backgroundSession({ running: Array.from({ length: MAX_RUNNING_JOBS }, (_, i) => ({ id: `job-bbbbbbbb-${i}`, title: `Job ${i}`, state: "running", startedAt: NOW - 1 })), job: null, now: NOW });
  const fake = planner(full, PLAN);
  const result = await withBackground(full, notesDispatcher().callTool)(PLAN_TOOL, { ask: "lisbon", folder: "1-projects/lisbon/" });
  assert.equal(result.isError, true);
  assert.equal(fake.asked.length, 0, "the advisor isn't asked when nothing can start");
});

test("an ask the advisor says doesn't split writes nothing and starts nothing", async () => {
  for (const [answer, said] of [[{ split: false, how: "now", why: "it's one lookup" }, /Do it now yourself/], [{ split: false, how: "one_job", why: "steps in order" }, /Start one background job/]]) {
    const background = backgroundSession({ running: [], job: null, now: NOW });
    planner(background, answer);
    const { notes, callTool } = notesDispatcher();
    const result = await withBackground(background, callTool)(PLAN_TOOL, { ask: "what's the rate limit", folder: "1-projects/x/" });
    assert.match(words(result), said);
    assert.equal(notes.size, 0);
    assert.equal(background.started.length, 0);
    assert.equal(background.endsTurn(PLAN_TOOL), null, "the turn goes on");
  }
});

test("a note that can't be written starts nothing", async () => {
  const background = backgroundSession({ running: [], job: null, now: NOW });
  planner(background, PLAN);
  const { callTool } = notesDispatcher({ failing: ["1-projects/lisbon/days.md"] });
  const result = await withBackground(background, callTool)(PLAN_TOOL, { ask: "lisbon", folder: "1-projects/lisbon/" });
  assert.equal(result.isError, true);
  assert.equal(background.started.length, 0);
});

test("a project note already there is never written over", async () => {
  const background = backgroundSession({ running: [], job: null, now: NOW });
  const fake = planner(background, PLAN);
  const { notes, callTool } = notesDispatcher({ existing: ["1-projects/lisbon/overview.md"] });
  const result = await withBackground(background, callTool)(PLAN_TOOL, { ask: "lisbon", folder: "1-projects/lisbon/" });
  assert.equal(result.isError, true);
  assert.equal(notes.get("1-projects/lisbon/overview.md"), "already here");
  assert.equal(fake.asked.length, 0);
});

test("a plan that doesn't come through, or an advisor that fails, starts nothing", async () => {
  for (const request of [async () => ({ text: "I think you should split it into flights and a flat." }), async () => { throw new Error("down"); }]) {
    const background = backgroundSession({ running: [], job: null, now: NOW });
    background.plan = planCall({ model: "anthropic/claude-opus-5-5", request, history: [], question: "q", background });
    const { notes, callTool } = notesDispatcher();
    const result = await withBackground(background, callTool)(PLAN_TOOL, { ask: "lisbon", folder: "1-projects/lisbon/" });
    assert.equal(result.isError, true);
    assert.equal(notes.size, 0);
    assert.equal(background.started.length, 0);
  }
});

test("without a planner the tool isn't answered by the background session", async () => {
  const background = backgroundSession({ running: [], job: null, now: NOW });
  const seen = [];
  await withBackground(background, async (name) => (seen.push(name), { content: [] }))(PLAN_TOOL, {});
  assert.deepEqual(seen, [PLAN_TOOL], "passed through, where an unoffered tool is refused");
  assert.equal(PLAN_DEFINITION.name, PLAN_TOOL);
});

test("the planner is a setup switch, on only with an advisor", async () => {
  assert.equal(readPlanSetting(undefined), false);
  assert.equal(readPlanSetting("off"), false);
  assert.equal(readPlanSetting("on"), true);
  assert.equal(readPlanSetting("yes"), null);
  const setup = (extra) => `---\njob: texting-assistant\nmodels:\n  main: anthropic/claude-haiku-5-5\n${extra}---\n\nYou are Tex.\n`;
  assert.equal((await parseSetup(setup("  advisor: anthropic/claude-opus-5-5\nplan_big_asks: on\n"))).planBigAsks, true);
  assert.equal((await parseSetup(setup("  advisor: anthropic/claude-opus-5-5\n"))).planBigAsks, false);
  assert.equal(await parseSetup(setup("plan_big_asks: on\n")), null, "no advisor to plan");
  assert.equal(await parseSetup(setup("  advisor: anthropic/claude-opus-5-5\nplan_big_asks: maybe\n")), null);
});

test("code goes to a computer: a one-job answer names theirs, and the planner is told each computer's tools and slots", async () => {
  const computers = [{ name: "Studio Mac", online: true, tools: ["claude", "codex"], slots: 3 }];
  assert.deepEqual(parsePlan('{"split": false, "how": "one_job", "why": "a small change", "computer": "studio mac"}', { slots: 3, computers }), { split: false, how: "one_job", why: "a small change", computer: "Studio Mac" });
  assert.equal(parsePlan('{"split": false, "how": "one_job", "computer": "Someone Else"}', { slots: 3, computers }).computer, undefined, "not theirs");
  assert.equal(parsePlan('{"split": false, "how": "now", "computer": "Studio Mac"}', { slots: 3, computers }).computer, undefined, "now runs no job");
  const background = backgroundSession({ running: [], job: null, now: NOW, machines: async () => computers });
  const fake = planner(background, { split: false, how: "one_job", why: "a small change", computer: "Studio Mac" });
  const result = await withBackground(background, notesDispatcher().callTool)(PLAN_TOOL, { ask: "change the on it text in the context repo", folder: "1-projects/on-it/" });
  assert.match(words(result), /on_computer \{ name: "Studio Mac" \}/);
  assert.match(fake.asked[0].messages[0].text, /Studio Mac \(claude, codex, 3 slots\)/);
  assert.match(fake.asked[0].system, /good at always runs on one/);
  assert.match(fake.asked[0].system, /heavy computing/);
});

test("with the planner on, a lone job is offered the planner once, then starts", async () => {
  const background = splitFirst(backgroundSession({ running: [], job: null, now: NOW }));
  const call = withBackground(background, async () => ({ content: [] }));
  const lisbon = { title: "Lisbon week", brief: "Dinners, a day trip and packing." };
  const first = await call("start_background_job", lisbon);
  assert.equal(first.isError, true);
  assert.match(words(first), /call plan_big_ask once/);
  assert.equal(background.started.length, 0, "nothing started yet");
  assert.equal(background.endsTurn("start_background_job"), null, "the turn goes on");
  const again = await call("start_background_job", lisbon);
  assert.equal(again.isError, undefined, words(again));
  assert.deepEqual(background.started.map((job) => job.title), ["Lisbon week"]);

  // One slot free: nothing to split into, so it starts at once.
  const one = splitFirst(backgroundSession({ running: [{ id: "job-cccccccc-1", title: "A", state: "running", startedAt: NOW }, { id: "job-cccccccc-2", title: "B", state: "running", startedAt: NOW }], job: null, now: NOW }));
  assert.equal((await withBackground(one, async () => ({ content: [] }))("start_background_job", lisbon)).isError, undefined);
  assert.equal(one.started.length, 1);
});

test("the planner's own parts and its one-job answer are never asked", async () => {
  const background = backgroundSession({ running: [], job: null, now: NOW });
  planner(background, PLAN);
  splitFirst(background);
  const { callTool } = notesDispatcher();
  const call = withBackground(background, callTool);
  await call(PLAN_TOOL, { ask: "plan my lisbon week", folder: "1-projects/lisbon/" });
  assert.equal(background.started.length, 3, "every part started");

  const single = backgroundSession({ running: [], job: null, now: NOW });
  planner(single, { split: false, how: "one_job", why: "steps in order" });
  splitFirst(single);
  const callSingle = withBackground(single, notesDispatcher().callTool);
  await callSingle(PLAN_TOOL, { ask: "insurance", folder: "1-projects/insurance/" });
  const started = await callSingle("start_background_job", { title: "Travel insurance", brief: "Pick one." });
  assert.equal(started.isError, undefined, words(started));
  assert.equal(single.started.length, 1);
});
