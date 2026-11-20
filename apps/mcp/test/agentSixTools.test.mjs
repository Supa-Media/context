/**
 * The texting assistant shown the six tools (`src/agent/sixTools.js`): each
 * lists only what the turn was granted, a call to one becomes its granted
 * carrying tool, and nothing ungranted is reachable through the six.
 *
 * Sabotage record:
 *   `resolve` skipping the grants check → "an action the surface did not
 *     allow is refused before it is dispatched" fails
 *   `grantedActions` ignoring which tools are held → "the six list only what
 *     the turn holds" fails
 *   `resolve` not looking in the other families (2026-10-20) → "an action
 *     called on the wrong one of the six runs where it lives" fails
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { sixToolsOver } from "../../../packages/tex/gateway/agent/sixTools.js";
import { translateV2Params } from "../src/tools/v2/translate.js";
import { runTurn } from "../../../packages/tex/gateway/agent/turn.js";
import { aiGatewayConfig, resetCreditState } from "../../../packages/tex/gateway/agent/aiGateway.js";
import { toolDefinitions } from "../src/tools/registry.js";
import { shown } from "./sixToolsShown.mjs";

const mcp = new Map(toolDefinitions().map((tool) => [tool.name, tool]));
const held = (...names) =>
  names.map((name) => mcp.get(name) ?? { name, description: `${name} words.`, inputSchema: { type: "object", properties: { text: { type: "string" } } } });
const skillTool = {
  name: "read_skill",
  description: "Step-by-step instructions: connect-chatgpt (someone wants ChatGPT).",
  inputSchema: { type: "object", properties: { name: { type: "string", enum: ["connect-chatgpt"] } }, required: ["name"] },
};

test("the six list only what the turn holds", () => {
  const reads = sixToolsOver(held("orient", "search_notes", "read_note", "list_notes"));
  assert.deepEqual(reads.tools.map((tool) => tool.name), ["orient", "search", "fetch"]);

  const texting = sixToolsOver([...held("orient", "search_notes", "read_note", "write_note", "move_note", "browse", "text_progress"), skillTool]);
  assert.deepEqual(texting.tools.map((tool) => tool.name), ["orient", "search", "fetch", "write", "manage", "send"]);
  const names = shown(texting.tools);
  for (const name of ["write.save", "write.comment", "manage.move", "manage.website", "send.browse", "send.progress"]) {
    assert.ok(names.has(name), name);
  }
  for (const name of ["write.propose", "manage.archive", "send.api", "send.fill_login", "send.search_web"]) {
    assert.ok(!names.has(name), `${name} is not held`);
  }
  assert.match(texting.tools.find((tool) => tool.name === "fetch").description, /skill:<name>.*connect-chatgpt/);
});

test("a call to one of the six becomes its granted carrying tool", () => {
  const { resolve } = sixToolsOver([...held("search_notes", "read_note", "write_note", "move_note", "browse", "text_progress", "earlier_texts"), skillTool]);
  assert.deepEqual(resolve("write", { path: "a.md", content: "# A\n", expected_etag: "e1" }), {
    name: "write_note",
    args: { path: "a.md", content: "# A\n", expected_etag: "e1" },
  });
  assert.equal(resolve("search", { query: "tulips" }).name, "search_notes");
  assert.equal(resolve("fetch", { id: "1-projects/a.md" }).name, "read_note");
  assert.deepEqual(resolve("fetch", { id: "skill:connect-chatgpt" }), { name: "read_skill", args: { name: "connect-chatgpt" } });
  assert.deepEqual(resolve("fetch", { id: "texts:" }), { name: "earlier_texts", args: {} });
  assert.deepEqual(resolve("send", { action: "browse", args: { steps: [{ do: "goto", url: "https://a.example/" }] } }), {
    name: "browse",
    args: { steps: [{ do: "goto", url: "https://a.example/" }] },
  });
  assert.deepEqual(resolve("send", { action: "progress", args: { text: "On it." } }), { name: "text_progress", args: { text: "On it." } });
  assert.equal(resolve("manage", { action: "move", args: { source: "a.md", destination: "b.md" } }).name, "move_note");
  // An older name is itself; the turn's allowlist decides it.
  assert.deepEqual(resolve("write_note", { path: "a.md" }), { name: "write_note", args: { path: "a.md" } });
});

test("an assistant action's words written beside the action reach the tool", () => {
  // Nov Babies, 2026-11-12: send { action: "search_web", query } dropped the query, and Tex was told "Write a short search query."
  const { resolve } = sixToolsOver(held("search_web", "open_page", "text_progress"));
  assert.deepEqual(resolve("send", { action: "search_web", query: "Puttshack NYC" }), { name: "search_web", args: { query: "Puttshack NYC" } });
  assert.deepEqual(resolve("send", { action: "open_page", urls: ["https://a.example/"] }), { name: "open_page", args: { urls: ["https://a.example/"] } });
  // Inside args wins where both name a key; the call's own keys never become the action's.
  assert.deepEqual(resolve("send", { action: "search_web", query: "outer", args: { query: "inner" } }), { name: "search_web", args: { query: "inner" } });
  assert.deepEqual(resolve("send", { action: "search_web", query: "q", context: "@x", mailbox: "m", person_said: "p" }), { name: "search_web", args: { query: "q" } });
  // Called on the wrong family, the words still arrive.
  assert.deepEqual(resolve("write", { action: "progress", text: "On it." }), { name: "text_progress", args: { text: "On it." } });
});

test("a sign-in or card fill hears the workspace its call names", () => {
  // Crystal Care, 2026-11-12: send { action: "fill_login", args: { entry }, context: "@crystal-care" } reached the tool
  // with no context, which opened the chat's own home and said "There is no such login".
  const { resolve } = sixToolsOver(held("fill_login", "fill_card", "search_web"));
  assert.deepEqual(resolve("send", { action: "fill_login", args: { entry: "v1", password_ref: 2 }, context: "@crystal-care" }), { name: "fill_login", args: { context: "@crystal-care", entry: "v1", password_ref: 2 } });
  assert.deepEqual(resolve("send", { action: "fill_card", args: { entry: "v1", context: "@inner" }, context: "@outer" }).args.context, "@inner");
  assert.deepEqual(resolve("send", { action: "fill_login", args: { entry: "v1" }, context: "  " }), { name: "fill_login", args: { entry: "v1" } });
  // A tool that takes no workspace still never gets one.
  assert.deepEqual(resolve("send", { action: "search_web", query: "q", context: "@x" }), { name: "search_web", args: { query: "q" } });
});

test("an action the turn does not hold, or the surface did not allow, is refused before it is dispatched", () => {
  const dream = sixToolsOver(held("read_note", "list_notes", "write_note"), { write: ["save"] });
  assert.deepEqual([...shown(dream.tools)].filter((name) => name.includes(".")), ["write.save"]);
  assert.match(dream.resolve("write", { action: "comment", path: "a.md", args: {} }).error, /no action "comment" for you\. Yours: save/);
  assert.match(dream.resolve("manage", { action: "move", args: {} }).error, /Yours: none/);
  assert.match(dream.resolve("send", { action: "browse", args: {} }).error, /Yours: none/);
  assert.equal(dream.resolve("write", { path: "a.md", content: "x" }).name, "write_note");
});

test("an action called on the wrong one of the six runs where it lives, never wider", () => {
  // Tex, 2026-10-17 and 2026-10-20: write { action: "progress" } failed with "no such action" twice.
  const { resolve } = sixToolsOver(held("read_note", "write_note", "move_note", "text_progress"));
  assert.deepEqual(resolve("write", { action: "progress", args: { text: "On it." } }), { name: "text_progress", args: { text: "On it." } });
  assert.equal(resolve("send", { action: "move", args: { source: "a.md", destination: "b.md" } }).name, "move_note");
  // Not held anywhere is still refused, naming the family it was called on.
  assert.match(resolve("write", { action: "browse", args: {} }).error, /write has no action "browse" for you/);
  // A surface's grants still decide: the dream may save and nothing else.
  const dream = sixToolsOver(held("write_note", "move_note", "text_progress"), { write: ["save"] });
  assert.match(dream.resolve("write", { action: "progress", args: { text: "x" } }).error, /no action "progress"/);
  assert.match(dream.resolve("write", { action: "move", args: {} }).error, /no action "move"/);
});

test("a connected app is never granted the assistant's own actions", () => {
  for (const action of ["browse", "open_page", "search_web", "fill_login", "progress"]) {
    const { error } = translateV2Params({ name: "send", arguments: { action, args: {} } }, undefined, { app: { client: null } });
    assert.match(error ?? "", new RegExp(`send has no action "${action}"`));
  }
});

const ENV = {
  AI_GATEWAY_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  AI_GATEWAY_ID: "context-gw",
  AI_GATEWAY_TOKEN: `gw-token-${"a".repeat(20)}`,
};
const HAIKU = "anthropic/claude-haiku-5-5";
const reply = (blocks, stop = "end_turn") => ({ id: "m", type: "message", role: "assistant", content: blocks, stop_reason: stop, usage: { input_tokens: 1, output_tokens: 1 } });
const use = (id, name, input) => ({ type: "tool_use", id, name, input });

test("runTurn shows the model the six, and never dispatches what was not granted", async () => {
  resetCreditState();
  const queue = [
    reply(
      [
        use("a", "manage", { action: "archive", args: { path: "a.md" } }),
        use("b", "archive_note", { path: "a.md" }),
        use("c", "write", { path: "a.md", content: "x" }),
        use("d", "fetch", { id: "a.md" }),
      ],
      "tool_use"
    ),
    reply([{ type: "text", text: "Done." }]),
  ];
  const bodies = [];
  const fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify(queue.shift()), { status: 200, headers: { "content-type": "application/json" } });
  };
  const dispatched = [];
  const turn = await runTurn({
    question: "tidy up",
    tools: held("orient", "search_notes", "read_note"),
    callTool: async (name) => {
      dispatched.push(name);
      return { content: [{ type: "text", text: "ok" }] };
    },
    env: { ...ENV, AGENT_BUILTIN_MODEL: HAIKU },
    providerOptions: { gateway: aiGatewayConfig(ENV), fetchImpl },
    builtinModelOverride: HAIKU,
  });
  assert.equal(turn.answer, "Done.");
  assert.deepEqual(bodies[0].tools.map((tool) => tool.name), ["orient", "search", "fetch"]);
  assert.deepEqual(dispatched, ["read_note"]);
  assert.deepEqual(turn.steps, [{ tool: "read_note", ok: true }]);
  const results = bodies[1].messages.flatMap((message) => (Array.isArray(message.content) ? message.content : [])).filter((block) => block.type === "tool_result");
  assert.equal(results.filter((block) => block.is_error === true).length, 3, "the three ungranted calls are refused in band");
});

test("the vault link's action tells the model to look a login's site up, not guess it", () => {
  // 2026-11-04: the `site` argument's own description never reaches the model
  // (an action line shows argument names and types only), and Tex sent theCut's
  // and the bench's SnipCut link for a guessed .com without searching.
  const texting = sixToolsOver(held("orient", "vault_add_link", "search_web"));
  const line = texting.tools.map((tool) => tool.description).join("\n").split("\n").find((text) => text.startsWith("- vault_add:"));
  assert.ok(line, "vault_add is listed");
  assert.match(line, /never guess the site from the name/);
  assert.match(line, /search_web the company/);
  // golden task 3: asked to save a login, Tex asked "Gmail or another email?" instead of sending the link.
  assert.match(line, /never ask first which email/);
});

test("the turn's trace names the six a call was made as and its action, for the Lab's Tools page (2026-11-13)", async () => {
  resetCreditState();
  const queue = [reply([use("a", "write", { action: "save", path: "a.md", content: "x" })], "tool_use"), reply([{ type: "text", text: "Saved." }])];
  const fetchImpl = async () => new Response(JSON.stringify(queue.shift()), { status: 200, headers: { "content-type": "application/json" } });
  const turn = await runTurn({
    question: "save it",
    tools: held("orient", "write_note"),
    callTool: async () => ({ content: [{ type: "text", text: "saved" }] }),
    env: { ...ENV, AGENT_BUILTIN_MODEL: HAIKU },
    providerOptions: { gateway: aiGatewayConfig(ENV), fetchImpl },
    builtinModelOverride: HAIKU,
  });
  const tool = turn.timing.trace.find((entry) => entry.kind === "tool");
  assert.equal(tool.tool, "write_note");
  assert.equal(tool.six, "write");
  assert.equal(tool.action, "save");
});

test("an older tool name called with an argument its schema does not take is refused, naming the ones it does (2026-11-14)", () => {
  const { resolve } = sixToolsOver(held("search_notes", "search_email", "read_email"));
  const wrong = resolve("search_email", { query: "AMC ticket", address: "me@example.com" });
  assert.equal(wrong.cause, "unknown_argument");
  assert.match(wrong.error, /^search_email: unknown argument address; permitted here: query, account, limit, context, mailbox, person_said$/);
  assert.deepEqual(resolve("search_email", { query: "AMC ticket", account: "me@example.com" }), {
    name: "search_email",
    args: { query: "AMC ticket", account: "me@example.com" },
  });
  // A schema that takes any argument is left as it was, and so is a tool this turn was not given.
  assert.deepEqual(resolve("open_note", { anything: 1 }), { name: "open_note", args: { anything: 1 } });
});

test("a context the model nested inside a search's args is moved out of it, then boosted, not fenced (2026-11-19)", () => {
  // Guild reading list, 2026-11-19: a fallback model wrote search { query, args: { context: "@guild" } }; the gateway refused
  // it ("context goes beside args"), so three searches never ran. The MCP tool still refuses; only Tex's resolver moves it,
  // and a workspace it moves is a boost (see the next test), so the search still covers every workspace.
  const { resolve } = sixToolsOver(held("search_notes", "read_note"));
  assert.deepEqual(resolve("search", { query: "reading list", args: { context: "@guild" } }), {
    name: "search_notes",
    args: { query: "reading list", boost: "@guild" },
  });
  // Both present: nothing is changed, so the gateway's refusal still stands.
  assert.match(resolve("search", { query: "reading list", context: "@guild", args: { context: "@other" } }).error, /goes beside args/);
});

/*
  Tex's search never fences a person's workspaces (2026-11-19: "the <org> reading list" read as a workspace, every search
  pinned to it, and the person's own workspace, where the note was, never searched; the owner's decision: search every
  workspace they reach, a named one only boosts, and `only: true` alone keeps it a filter). Only Tex's resolver does this;
  an MCP client's `context` still filters.
  Sabotage (2026-11-19): remove the rewrite in `sixSearchCall` and `resolve`'s older-name branch (make `searchWorkspace`
  return `{ context }` always) → the boost and only tests below fail; the older-name test fails too.
*/
test("a workspace a search names boosts it: every workspace is still searched (2026-11-19)", () => {
  const { resolve } = sixToolsOver(held("search_notes", "read_note"));
  assert.deepEqual(resolve("search", { query: "reading list", context: "@guild" }), {
    name: "search_notes",
    args: { query: "reading list", boost: "@guild" },
  });
  assert.deepEqual(resolve("search", { query: "reading list", args: { context: "@guild" } }), {
    name: "search_notes",
    args: { query: "reading list", boost: "@guild" },
  });
  // The older name, with the same words: it is widened the same way once its schema takes the call.
  assert.deepEqual(resolve("search_notes", { query: "reading list", context: "@guild" }), {
    name: "search_notes",
    args: { query: "reading list", boost: "@guild" },
  });
  // A blank workspace names none, so nothing is boosted and nothing is kept.
  assert.deepEqual(resolve("search", { query: "reading list", context: "  " }), { name: "search_notes", args: { query: "reading list" } });
});

test("`only: true` keeps a workspace as a filter, and it is never sent to the gateway", () => {
  // "only in @guild" is the person's own word for a fence: context stays, and the `only` flag, which translateSearch
  // refuses, is dropped.
  const { resolve } = sixToolsOver(held("search_notes", "read_note"));
  assert.deepEqual(resolve("search", { query: "reading list", context: "@guild", args: { only: true } }), {
    name: "search_notes",
    args: { query: "reading list", context: "@guild" },
  });
  assert.deepEqual(resolve("search", { query: "reading list", args: { context: "@guild", only: true } }), {
    name: "search_notes",
    args: { query: "reading list", context: "@guild" },
  });
});

test("a folder or a date range the call asked for keeps its workspace as a filter", () => {
  const { resolve } = sixToolsOver(held("search_notes", "read_note"));
  assert.deepEqual(resolve("search", { query: "reading list", context: "@guild", args: { prefix: "x" } }), {
    name: "search_notes",
    args: { query: "reading list", prefix: "x", context: "@guild" },
  });
  assert.deepEqual(resolve("search", { query: "reading list", context: "@guild", args: { from: "2026-11-01", to: "2026-11-07" } }), {
    name: "search_notes",
    args: { query: "reading list", from: "2026-11-01", to: "2026-11-07", context: "@guild" },
  });
});

test("the search's description says every workspace is covered, a named one only ranks, and what the Searched line is for", () => {
  const search = sixToolsOver(held("search_notes", "read_note")).tools.find((tool) => tool.name === "search");
  assert.match(search.description, /Every search covers every workspace they reach, ranked together/);
  assert.match(search.description, /only ranks its notes first; it never narrows the search/);
  assert.match(search.description, /args \{ only: true \}/);
  assert.match(search.description, /"Searched: …", names the workspaces it covered/);
  // Without search_notes the six have no search to describe.
  assert.equal(sixToolsOver(held("read_note")).tools.find((tool) => tool.name === "search"), undefined);
});

// Training 2026-11-19 (trial-hire): `manage { action: "visibility", path }` was refused for `path` beside the action, and
// the model retried. Words beside a manage action that its carrying tool takes now reach that tool's args.
test("a manage call's words written beside the action reach its carrying tool's args (2026-11-19)", () => {
  const { resolve } = sixToolsOver(held("set_visibility", "move_note", "read_note"));
  const people = [{ who: "bram@example.com", role: "view" }];
  assert.deepEqual(resolve("manage", { action: "visibility", path: "x.md", args: { people } }), {
    name: "set_visibility",
    args: { path: "x.md", people },
  });
  assert.deepEqual(resolve("manage", { action: "visibility", path: "x.md", visibility: "team", expected_etag: "e1" }), {
    name: "set_visibility",
    args: { path: "x.md", visibility: "team", expected_etag: "e1" },
  });
  // Inside args wins where both name a key.
  assert.deepEqual(resolve("manage", { action: "visibility", path: "outer.md", args: { path: "inner.md" } }), {
    name: "set_visibility",
    args: { path: "inner.md" },
  });
  // The call's own addressing (context) is not an action's argument: it is carried to the top of the translated call.
  assert.deepEqual(resolve("manage", { action: "visibility", path: "x.md", context: "@x", args: {} }), {
    name: "set_visibility",
    args: { path: "x.md", context: "@x" },
  });
});

test("a manage word the carrying tool does not take is still refused, as before (2026-11-19)", () => {
  const { resolve } = sixToolsOver(held("set_visibility", "move_note"));
  // move_note takes no people: beside a move, they are refused, and not dropped or sent on.
  const refused = resolve("manage", { action: "move", source: "a.md", destination: "b.md", people: [{ who: "bram@example.com" }] });
  assert.match(refused.error, /unknown argument "people"/);
  assert.equal(refused.name, undefined);
});

test("a refused manage visibility call says nothing changed, last; other manage refusals do not (2026-11-19)", () => {
  const NOTHING = "Refused: no access was given beyond what this says, so don't tell anyone they can open it.";
  const { resolve } = sixToolsOver(held("set_visibility", "move_note"));
  // An argument no tool takes is refused by the gateway's own translation, and the sentence follows it.
  const visibility = resolve("manage", { action: "visibility", path: "x.md", colour: "red" });
  assert.match(visibility.error, /unknown argument "colour"/);
  assert.ok(visibility.error.endsWith(NOTHING), visibility.error);
  const folder = resolve("manage", { action: "visibility", colour: "red", args: { path: "x.md" } });
  assert.ok(folder.error.endsWith(NOTHING), folder.error);
  // Any other manage action keeps the tool's own refusal.
  const moved = resolve("manage", { action: "move", source: "a.md", colour: "red" });
  assert.doesNotMatch(moved.error, /Nothing changed/);
  // A granted call still resolves without the sentence.
  assert.equal(resolve("manage", { action: "visibility", path: "x.md" }).error, undefined);
});
