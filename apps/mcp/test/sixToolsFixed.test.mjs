/**
 * THE FIXED TOOL LIST (Dev2, 2026-11-20; `src/agent/sixToolsFixed.js`, `toolCatalogue.js`): with `toolList: "fixed"` on
 * the front door and job steps, every turn of a kind of chat is shown the same six, byte for byte, each under the tool
 * rules' 4,000 characters (`packages/shared/src/toolRules.cjs`), with each action's guide read on demand by
 * `fetch manual:<action>`; what a turn may really call is still its own, and the rest is refused saying what to do.
 *
 * ## Sabotage record
 *
 * Applied, run, named test seen failing, reverted:
 *  1. `sixToolsOver` building the shown list from `held` again (`shownSix(held, grants, ...)`) → "every turn of a 1:1
 *     and of a group is shown the same tools" fails (the check-in's list differs).
 *  2. `familyTool` with manuals pasting the carrier's words again → "each of the six is under 4,000 characters" fails.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { TEX_CONFIG, texToolList, withDraft } from "../src/agent/texConfig.js";
import { sixToolsOver } from "../src/agent/sixTools.js";
import { fixedCarriers } from "../src/agent/sixToolsFixed.js";
import { surfaces } from "./toolRules/report.mjs";
import rules from "../../../packages/shared/src/toolRules.cjs";

const { TOOL_CHAR_LIMIT, toolChars, rateError } = rules;
const strip = (value) => JSON.stringify(value, (key, inner) => (key === "cache_control" ? undefined : inner));

/** Runs `run` with the front door and job steps set to the fixed list, as a Lab draft would set them. */
async function withFixed(run) {
  const steps = TEX_CONFIG.nodes.filter((node) => node.id === "fd" || node.id === "job");
  const before = steps.map((node) => node.toolList);
  for (const node of steps) node.toolList = "fixed";
  try {
    return await run();
  } finally {
    steps.forEach((node, at) => (before[at] === undefined ? delete node.toolList : (node.toolList = before[at])));
  }
}

test("every turn of a 1:1 and of a group is shown the same tools, byte for byte", async () => {
  const shown = await withFixed(() => surfaces());
  const lists = Object.entries(shown).map(([name, { chat, tools }]) => ({ name, chat, tools }));
  for (const { name, tools } of lists) assert.ok(Array.isArray(tools) && tools.length > 0, `${name} was shown tools`);
  for (const chat of ["1:1", "group"]) {
    const ofChat = lists.filter((entry) => entry.chat === chat);
    const first = strip(ofChat[0].tools);
    for (const entry of ofChat) assert.equal(strip(entry.tools), first, `${entry.name} is shown what ${ofChat[0].name} is`);
  }
  const names = lists.find((entry) => entry.name === "check-in").tools.map((tool) => tool.name);
  assert.deepEqual(names, ["orient", "search", "fetch", "write", "manage", "send"], "a check-in is shown all six, not just say_nothing");
});

test("each of the six is under 4,000 characters, in a 1:1 and in a group", () => {
  for (const kind of ["one", "group"]) {
    const shown = fixedCarriers(kind);
    const { tools } = sixToolsOver([...shown.values()], null, { shown });
    for (const tool of tools) assert.ok(toolChars(tool) <= TOOL_CHAR_LIMIT, `${kind} ${tool.name} is ${toolChars(tool)} characters`);
    const send = tools.find((tool) => tool.name === "send");
    assert.match(send.description, /fetch manual:<action>/, "the list says where each action's guide is");
  }
});

test("the shown list is the same whatever the turn holds; what it holds decides what runs", () => {
  const shown = fixedCarriers("one");
  const all = [...shown.values()];
  const full = sixToolsOver(all, null, { shown });
  const checkIn = sixToolsOver(all, { send: ["say_nothing"] }, { shown });
  assert.equal(strip(checkIn.tools), strip(full.tools));
  const refused = checkIn.resolve("send", { action: "search_web", args: { query: "dentist" } });
  assert.equal(refused.cause, "not_this_turn");
  assert.match(refused.error, /isn't available on this turn/);
  assert.match(refused.error, /Available now: say_nothing/);
  assert.equal(rateError(refused.error), "actionable", "the refusal says what to do next");
  assert.equal(checkIn.resolve("send", { action: "say_nothing", args: {} }).name, "say_nothing");
});

test("fetch manual:<action> gives the action's args and its full guide; an unknown one names the real ones", () => {
  const shown = fixedCarriers("one");
  const six = sixToolsOver([...shown.values()], { send: ["say_nothing"] }, { shown });
  const manual = six.resolve("fetch", { id: "manual:search_web" });
  assert.equal(typeof manual.text, "string");
  assert.match(manual.text, /^send action search_web: /);
  assert.match(manual.text, /Call: send \{ action: "search_web", args: /);
  assert.ok(manual.text.includes(shown.get("search_web").description.trim()), "the carrier's own words");
  assert.match(six.resolve("fetch", { id: "manual:save" }).text, /^write action save: /);
  const unknown = six.resolve("fetch", { id: "manual:teleport" });
  assert.match(unknown.error, /no action "teleport"/);
  assert.match(unknown.error, /manual:search_web/);
  assert.equal(rateError(unknown.error), "actionable");
});

test("without the fixed list nothing changes: a turn is shown what it holds, with each action's words inline", () => {
  const shown = fixedCarriers("one");
  const held = [...shown.values()].filter((tool) => ["read_note", "search_notes", "say_nothing"].includes(tool.name));
  const { tools } = sixToolsOver(held, null);
  const send = tools.find((tool) => tool.name === "send");
  assert.doesNotMatch(send.description, /manual:/);
  assert.ok(send.description.includes(shown.get("say_nothing").description.split("\n")[0]));
});

test("a Lab draft switches a step to the fixed list, and nothing else does", () => {
  assert.equal(texToolList("fd"), "turn", "main runs what each turn holds until a draft is promoted");
  const draft = withDraft(TEX_CONFIG, { nodes: [{ id: "fd", toolList: "fixed" }, { id: "job", toolList: "sideways" }] });
  assert.equal(texToolList("fd", draft), "fixed");
  assert.equal(texToolList("job", draft), "turn", "a value that isn't one of the two is ignored");
});
