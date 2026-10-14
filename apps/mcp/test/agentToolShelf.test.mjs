/**
 * THE TOOL SHELF: A FEW TOOLS IN HAND, THE REST BY NAME (owner, 2026-10-14).
 *
 * A setup's `core_tools` are what a turn is offered, with short descriptions,
 * beside `find_tools`; every other tool the turn holds is named in the system
 * prompt and loaded on request. The shelf narrows what the model is told,
 * never what it may reach.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   `shown()` returning every tool
 *     → "a turn with core tools offers only those, short, and find_tools" fails
 *   `find_tools` not loading what it names
 *     → "find_tools puts a shelved tool in the next round's list" fails
 *   a shelved tool called by name refused instead of loaded and run
 *     → "a shelved tool called by its name runs" fails
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BUILTIN_PROVIDER } from "../src/agent/builtin.js";
import { runTurn } from "../src/agent/turn.js";
import { parseSetup } from "../src/agent/production.js";
import { FIND_TOOLS, firstParagraph, readCoreTools, summaryOf, toolShelf } from "../src/agent/toolShelf.js";
import { earlierTextsResult, shownHistory } from "../src/agent/conversation.js";

const MODEL = "@cf/zai-org/glm-4.7-flash";

function tool(name, description) {
  return {
    name,
    description,
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    annotations: { readOnlyHint: true },
  };
}

const SEARCH = tool("search_notes", "Search the notes by words and meaning. Ranked.\n\nA long second paragraph about context arguments.");
const READ = tool("read_note", "Read one note in full.");
const BROWSE = tool("browse", "A real web browser for doing things on a site. Clicks and types.");
const ORIENT = tool("orient", "The map of every workspace you can reach, with folders.");
const ALL = [SEARCH, READ, BROWSE, ORIENT];

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

function chat(text, toolCalls = []) {
  return {
    choices: [
      {
        message: {
          content: text,
          tool_calls: toolCalls.map(([name, args], i) => ({
            id: `call_${i}`,
            type: "function",
            function: { name, arguments: JSON.stringify(args ?? {}) },
          })),
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

const namesSent = (call) => (call.input.tools ?? []).map((entry) => entry.function?.name ?? entry.name);
const systemSent = (call) => call.input.messages.find((message) => message.role === "system")?.content ?? "";
const descriptionSent = (call, name) => {
  const entry = (call.input.tools ?? []).find((t) => (t.function?.name ?? t.name) === name);
  return entry?.function?.description ?? entry?.description;
};

function turn(ai, callTool, overrides = {}) {
  return runTurn({
    question: "Book me a table on resy for Friday",
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    tools: ALL,
    callTool,
    env: { AI: ai, AGENT_BUILTIN_MODEL: MODEL },
    providerOptions: { ai },
    texting: true,
    coreTools: ["search_notes", "read_note"],
    ...overrides,
  });
}

test("a setup's core_tools is a list of tool names; absent is no shelf, anything else refuses the setup", () => {
  assert.equal(readCoreTools(undefined), undefined);
  assert.deepEqual(readCoreTools(["search_notes", "read_note", "search_notes"]), ["search_notes", "read_note"]);
  assert.equal(readCoreTools([]), null);
  assert.equal(readCoreTools("search_notes"), null);
  assert.equal(readCoreTools(["Search Notes"]), null);
});

test("the setup note carries core_tools and history", async () => {
  const setup = await parseSetup(
    "---\nmodels:\n  main: anthropic/claude-haiku-5-5\ncore_tools: [search_notes, read_note]\nhistory: 2\n---\nYou are Tex.\n",
  );
  assert.deepEqual(setup.coreTools, ["search_notes", "read_note"]);
  assert.equal(setup.history, 2);
  const plain = await parseSetup("---\nmodels:\n  main: anthropic/claude-haiku-5-5\n---\nYou are Tex.\n");
  assert.equal(plain.coreTools, null);
  assert.equal(plain.history, null);
  assert.equal(await parseSetup("---\nmodels:\n  main: anthropic/claude-haiku-5-5\nhistory: 99\n---\nTex.\n"), null);
  assert.equal(await parseSetup("---\nmodels:\n  main: anthropic/claude-haiku-5-5\ncore_tools: yes\n---\nTex.\n"), null);
});

test("a core tool's short version is its first paragraph; a shelved one's line is its first sentence", () => {
  assert.equal(firstParagraph(SEARCH.description), "Search the notes by words and meaning. Ranked.");
  assert.equal(summaryOf(SEARCH.description), "Search the notes by words and meaning.");
  assert.ok(summaryOf(`${"word ".repeat(60)}.`).length <= 110);
});

test("find_tools loads by name or by what the model needs, and says what it couldn't find", () => {
  const shelf = toolShelf(ALL, ["search_notes"]);
  assert.deepEqual(shelf.shown().map((t) => t.name), ["search_notes", FIND_TOOLS]);
  assert.match(shelf.prompt(), /- browse: A real web browser for doing things on a site\./);
  assert.match(shelf.prompt(), /- orient: /);
  assert.doesNotMatch(shelf.prompt(), /- search_notes:/);

  const byName = shelf.call({ names: ["browse", "fly_to_mars"] });
  assert.match(byName.content[0].text, /Loaded: browse/);
  assert.match(byName.content[0].text, /Not tools you have: fly_to_mars/);
  assert.ok(shelf.shown().some((t) => t.name === "browse"));
  assert.doesNotMatch(shelf.prompt(), /- browse:/);

  const byQuery = shelf.call({ query: "a map of my workspaces" });
  assert.match(byQuery.content[0].text, /Loaded: orient/);

  const nothing = shelf.call({ query: "zzzz" });
  assert.equal(nothing.isError, true);
});

test("a turn with core tools offers only those, short, and find_tools, and names the rest", async () => {
  const ai = scripted([chat("Hi.")]);
  await turn(ai, async () => ({ content: [] }));
  assert.deepEqual(namesSent(ai.calls[0]), ["search_notes", "read_note", FIND_TOOLS]);
  assert.equal(descriptionSent(ai.calls[0], "search_notes"), "Search the notes by words and meaning. Ranked.");
  assert.match(systemSent(ai.calls[0]), /More tools you have, not loaded yet/);
  assert.match(systemSent(ai.calls[0]), /- browse: /);
});

test("find_tools puts a shelved tool in the next round's list, whole", async () => {
  const ai = scripted([chat("", [[FIND_TOOLS, { names: ["browse"] }]]), chat("", [["browse", { query: "resy" }]]), chat("Booked.")]);
  const called = [];
  const result = await turn(ai, async (name) => {
    called.push(name);
    return { content: [{ type: "text", text: "ok" }] };
  });
  assert.equal(result.answer, "Booked.");
  assert.ok(!namesSent(ai.calls[0]).includes("browse"));
  assert.ok(namesSent(ai.calls[1]).includes("browse"));
  assert.equal(descriptionSent(ai.calls[1], "browse"), BROWSE.description);
  assert.deepEqual(called, ["browse"]);
});

test("a shelved tool called by its name runs, and is offered from then on", async () => {
  const ai = scripted([chat("", [["orient", {}]]), chat("Here's the map.")]);
  const called = [];
  await turn(ai, async (name) => {
    called.push(name);
    return { content: [{ type: "text", text: "map" }] };
  });
  assert.deepEqual(called, ["orient"]);
  assert.ok(namesSent(ai.calls[1]).includes("orient"));
});

test("a name the turn doesn't hold is still no tool, shelf or not", async () => {
  const ai = scripted([chat("", [["rotate_encryption_keys", {}]]), chat("Can't.")]);
  const called = [];
  await turn(ai, async (name) => {
    called.push(name);
    return { content: [] };
  });
  assert.deepEqual(called, []);
});

test("with no core tools a turn is offered everything, as before", async () => {
  const ai = scripted([chat("Hi.")]);
  await turn(ai, async () => ({ content: [] }), { coreTools: null });
  assert.deepEqual(namesSent(ai.calls[0]), ["search_notes", "read_note", "browse", "orient"]);
  assert.doesNotMatch(systemSent(ai.calls[0]), /not loaded yet/);
});

test("a turn is shown the newest texts its setup asks for, and earlier_texts reads them all", async () => {
  const history = [];
  for (let i = 0; i < 10; i += 1) history.push({ role: "user", text: `q${i}` }, { role: "assistant", text: `a${i}` });
  assert.deepEqual(shownHistory(history, 2).map((turn) => turn.text), ["q9", "a9"]);
  assert.deepEqual(shownHistory(history, 0), []);
  assert.equal(shownHistory(history).length, 12);
  const text = earlierTextsResult(history).content[0].text;
  assert.match(text, /^They: q0\n\nYou: a0/);
  assert.match(text, /You: a9$/);
  assert.equal(earlierTextsResult([]).content[0].text, "There are no earlier texts.");
});

test("a local tool is answered by the turn, not the MCP", async () => {
  const ai = scripted([chat("", [["earlier_texts", {}]]), chat("You asked about Sam.")]);
  const mcp = [];
  await turn(ai, async (name) => {
    mcp.push(name);
    return { content: [] };
  }, {
    coreTools: ["search_notes", "earlier_texts"],
    local: [{ tool: tool("earlier_texts", "Read your earlier texts."), call: async () => ({ content: [{ type: "text", text: "They: Sam?" }] }) }],
  });
  assert.deepEqual(mcp, []);
  assert.ok(namesSent(ai.calls[0]).includes("earlier_texts"));
  const sent = ai.calls[1].input.messages.filter((m) => m.role === "tool").at(-1)?.content;
  assert.match(String(sent), /They: Sam\?/);
});
