/**
 * A golden task end to end (`tests/tasks.md`, question 1): a scripted model
 * connects ChatGPT to Context across three texts, through the production
 * gateway (`read_skill`, the address guard, the typing rule, the handoff
 * link) and the scripted sites (`bench/sites.mjs`). The run's record must then
 * pass the task's checks, and a model that skips the skill must not get past
 * the address guard.
 */

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { createWorld } from "../world.mjs";
import { parseSite, LIVE_VIEW_ORIGIN } from "../sites.mjs";
import { checkVerdicts } from "../checks.mjs";
import { parseTest } from "../load.mjs";

const AI = fileURLToPath(new URL("../ai", import.meta.url));
const SETUP =
  "---\njob: texting-assistant\nmodels:\n  main: anthropic/claude-haiku-5-5\nskills:\n  connect-chatgpt: someone wants ChatGPT to use Context\n---\n\nYou are a test assistant.\n";
const SKILL = "---\nwhy: test\n---\n\nOpen https://chatgpt.com/plugins, press Add, name it `Context`, set the MCP server URL to `https://mcp.context.lc/mcp` and Authentication to OAuth.\n";

const bench = {
  people: [{ person: "Maya", workspace: "maya", role: "owner", personal: true }],
  workspaces: { maya: { files: { "todo.md": "- nothing\n" }, heldBack: [] } },
};

async function sites() {
  const dir = join(AI, "sites");
  const out = [];
  for (const name of (await readdir(dir)).sort()) out.push(parseSite(await readFile(join(dir, name), "utf8"), name));
  return out;
}

/** A model that answers each call with the next scripted step: a tool call, or text. */
function scripted(steps) {
  let n = 0;
  return async () => {
    const step = steps.shift() ?? { text: "Done." };
    n += 1;
    const reply = step.text
      ? { content: [{ type: "text", text: step.text }], stop_reason: "end_turn" }
      : { content: [{ type: "tool_use", id: `toolu_${n}`, name: step.name, input: step.input }], stop_reason: "tool_use" };
    return new Response(JSON.stringify({ ...reply, usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

const skill = { name: "read_skill", input: { name: "connect-chatgpt" } };
const browse = (...steps) => ({ name: "browse", input: { steps } });

test("a scripted model connects ChatGPT through the gateway and the scripted sites, and the checks see it", async () => {
  const gatewayFetch = scripted([
    skill,
    browse({ do: "goto", url: "https://chatgpt.com/plugins" }, { do: "handoff" }),
    { text: "Open the link and sign in to ChatGPT, then text me." },
    // The person signed in; the skill is read again to type its address this question.
    skill,
    browse({ do: "read" }),
    browse({ do: "click", ref: 1 }),
    browse(
      { do: "type", ref: 1, text: "Context" },
      { do: "type", ref: 2, text: "https://mcp.context.lc/mcp" },
      { do: "select", ref: 3, option: "OAuth" },
      { do: "click", ref: 4 },
      { do: "click", ref: 5 },
    ),
    browse({ do: "handoff" }),
    { text: "Sign in to Context in the link, then text me." },
    browse({ do: "click", ref: 1 }),
    { text: "ChatGPT is connected to Context." },
  ]);
  const world = await createWorld(bench, "Maya", SETUP, { gatewayFetch, sites: await sites(), skills: [{ name: "connect-chatgpt", raw: SKILL }] });
  const tools = [];
  try {
    const first = await world.text("can you make sure my chatgpt is properly set up to use context");
    assert.equal(first.ok, true);
    assert.match(first.answer, /https:\/\/app\.bench\.invalid\/tex\/maya$/, "the gateway appended the person's own take-over page");
    assert.ok(!first.answer.includes(LIVE_VIEW_ORIGIN), "and never the browser's own live-view link");
    tools.push(...first.tools);
    const second = await world.text("Done, I'm signed in");
    assert.match(second.answer, /take over the browser on context\.lc/);
    tools.push(...second.tools);
    const third = await world.text("Done");
    tools.push(...third.tools);
    assert.ok(third.tools.every((call) => call.ok), JSON.stringify(third.tools));

    const events = world.browser();
    assert.ok(events.includes("set connected chatgpt"), events.join("\n"));
    const test1 = parseTest(await readFile(join(AI, "tests", "tasks.md"), "utf8")).questions.find((q) => q.n === 1);
    const verdicts = checkVerdicts(test1, { tools: tools.map((call) => call.tool), browser: events });
    assert.deepEqual(verdicts.filter((v) => !v.pass), [], "every check of task 1 passes on this record");
  } finally {
    world.close();
  }
});

test("without the skill, the browser cannot open an address the person never wrote", async () => {
  const gatewayFetch = scripted([browse({ do: "goto", url: "https://chatgpt.com/plugins" }), { text: "I couldn't." }]);
  const world = await createWorld(bench, "Maya", SETUP, { gatewayFetch, sites: await sites(), skills: [{ name: "connect-chatgpt", raw: SKILL }] });
  try {
    const turn = await world.text("can you make sure my chatgpt is properly set up to use context");
    assert.deepEqual(turn.tools.map((call) => [call.tool, call.ok]), [["browse", false]]);
    assert.deepEqual(world.browser(), []);
  } finally {
    world.close();
  }
});
