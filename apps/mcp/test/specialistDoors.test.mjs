/**
 * The specialist front doors behind the Clef router (`src/agent/doorTools.js`, `specialistRoute.js`,
 * `doorTurn.js`, `graph/nodes/router.js`, `graph/nodes/doors.js`): the router's question and reading, the doors' tool
 * sets, the guard that ends a specialist's run before a call outside its set runs, the fallback to today's front door,
 * the usage it adds, and the prompt kinds a config draws. Through `runTurn` with a scripted model, as `agentSixTools` does.
 *
 * Sabotage record (applied, run, observed failing, reverted):
 *   `outside: null` in `doorTurn.js` (no guard)        -> four guard and act cases fail.
 *   `addSpend` left out of the fallback                -> "a fallback adds the specialist's spend" fails.
 *   `narrowForDoor` keeping every tool on read         -> the narrowing and quick/read guard cases fail.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DOOR_NODES, NEED_TOOLS, ROUTE_AT, WEB_READS, doorAllows, narrowForDoor, needToolsLocal, outsideFor } from "../src/agent/doorTools.js";
import { readRoute, routeRequest } from "../src/agent/specialistRoute.js";
import { routerNode } from "../src/agent/graph/nodes/router.js";
import { doorNode, fdActNode, fdQuickNode } from "../src/agent/graph/nodes/doors.js";
import { routeBeside } from "../src/agent/graph/nodes/doorStep.js";
import { addSpend, loggedRoute, routeActs, routeIfBack, runWithDoors } from "../src/agent/doorTurn.js";
import { runTurn } from "../src/agent/turn.js";
import { sixToolsOver } from "../src/agent/sixTools.js";
import { aiGatewayConfig, resetCreditState } from "../src/agent/aiGateway.js";
import { toolDefinitions } from "../src/tools/registry.js";
import { TEX_CONFIG, texModules } from "../src/agent/texConfig.js";
import { ask, createEgressWorld, toolReplies, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";

const mcp = new Map(toolDefinitions().map((tool) => [tool.name, tool]));
const held = (...names) => names.map((name) => mcp.get(name) ?? { name, description: `${name} words.`, inputSchema: { type: "object", properties: { text: { type: "string" } } } });
const ENV = {
  AI_GATEWAY_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  AI_GATEWAY_ID: "context-gw",
  AI_GATEWAY_TOKEN: `gw-token-${"a".repeat(20)}`,
};
const HAIKU = "anthropic/claude-haiku-5-5";
const reply = (blocks, stop = "end_turn") => ({ id: "m", type: "message", role: "assistant", content: blocks, stop_reason: stop, usage: { input_tokens: 1, output_tokens: 1 } });
const use = (id, name, input) => ({ type: "tool_use", id, name, input });
const text = (words) => reply([{ type: "text", text: words }]);

/** A scripted model: each request takes the next reply, and every request body is kept. */
function scripted(replies) {
  const queue = [...replies];
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify(queue.shift()), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { bodies, fetchImpl };
}

/** The turn's runTurn options, as the Front door builds them, over a scripted model and a recording dispatcher. */
function turnArgs(fetchImpl, tools, dispatched = []) {
  const callTool = async (name) => {
    dispatched.push(name);
    return { content: [{ type: "text", text: "done" }] };
  };
  return {
    args: { question: "do it", tools, local: [], web: null, callTool, env: { ...ENV, AGENT_BUILTIN_MODEL: HAIKU }, providerOptions: { gateway: aiGatewayConfig(ENV), fetchImpl }, builtinModelOverride: HAIKU },
    callTool,
  };
}

/** A via whose door nodes are drawn (or, with `wired: false`, not: the handle answers null, as `fd.js` does). */
const via = ({ wired = true } = {}) => ({
  door: async (route) => (wired ? { door: route, kind: `door-${route}`, tools: route === "quick" ? "none" : route === "read" ? "read" : "all", when: [route] } : null),
});

test("the router's question names the trigger and the first read, and a pick outside the four is no route", () => {
  const request = routeRequest({ question: "email from bo about the lease", group: false, trigger: "checkin", shape: { ending: "one_line", endingSure: 0.9, order: 0.1, records: 0.8 } });
  assert.match(request.state, /<trigger>a check-in Tex runs on its own, its text carrying what it found<\/trigger>/);
  assert.match(request.state, /answer is in something stored: yes/);
  assert.match(request.state, /an order to do something: no/);
  assert.match(request.state, /<where>a one-to-one chat/);
  assert.deepEqual(Object.keys(request.questions), ["route"]);
  assert.deepEqual(Object.keys(request.questions.route.criteria), ["quick", "read", "act", "job"]);
  assert.match(routeRequest({ question: "hi", group: true }).state, /a group chat Tex is in/);
  assert.doesNotMatch(routeRequest({ question: "hi" }).state, /first-read/, "no read, no first-read block");

  assert.deepEqual(readRoute({ route: { choice: "read", confidence: 0.7 } }), { route: "read", sure: 0.7 });
  assert.deepEqual(readRoute({ route: { choice: "quick" } }), { route: "quick", sure: 0 }, "a missing confidence is 0");
  assert.equal(readRoute({ route: { choice: "none", confidence: 0.9 } }), null, "none is not one of the four");
  assert.equal(readRoute({ route: { choice: "a poem" } }), null);
  assert.equal(readRoute(null), null);
});

test("the router node: no model, a blank text, a timeout, a failure are all no route; a good pick is the route", async () => {
  assert.deepEqual(await routerNode({ question: "hi", group: false, trigger: "text" }, { ctx: { turn: { env: {} } } }), { route: "none" }, "no AI binding");
  const asked = [];
  const engine = async (state, questions) => (asked.push({ state, questions }), { route: { choice: "act", confidence: 0.8 } });
  assert.deepEqual(await routerNode({ question: "save it", group: false, trigger: "text" }, { engine }), { route: "act", sure: 0.8, when: ["act"] });
  assert.match(asked[0].state, /save it/);
  assert.deepEqual(await routerNode({ question: "  ", group: false, trigger: "text" }, { engine }), { route: "none" });
  assert.equal(asked.length, 1, "a blank text is never asked");
  assert.deepEqual(await routerNode({ question: "x", group: false, trigger: "text" }, { engine: async () => { throw new Error("busy"); } }), { route: "none" });
  assert.deepEqual(await routerNode({ question: "x", group: false, trigger: "text" }, { engine: async () => ({ route: { choice: "poem" } }) }), { route: "none" });
  // A model that never answers: the router's own limit (texConfig's `router` step, 3 s) gives up.
  const started = Date.now();
  assert.deepEqual(await routerNode({ question: "x", group: false, trigger: "text" }, { engine: () => new Promise(() => {}) }), { route: "none" });
  assert.ok(Date.now() - started < 10_000, "it gives up at its limit");
});

test("the doors' tool sets: quick holds nothing but reply words, read holds the read-only tools and the web reads, act holds all", () => {
  const search = mcp.get("search_notes");
  const write = mcp.get("write_note");
  assert.equal(search.annotations.readOnlyHint, true);
  assert.equal(write.annotations.readOnlyHint, false);
  assert.equal(doorAllows("quick", "search_notes", search), false);
  assert.equal(doorAllows("quick", "say_nothing"), true);
  assert.equal(doorAllows("quick", NEED_TOOLS), true);
  assert.equal(doorAllows("quick", "text_progress"), false); // no progress line before a possible hand-over
  assert.equal(doorAllows("read", "text_progress"), true);

  assert.equal(doorAllows("read", "search_notes", search), true);
  assert.equal(doorAllows("read", "write_note", write), false);
  assert.equal(doorAllows("read", "browse", {}), false, "browse is not a read");
  for (const name of ["search_web", "open_page", "read_skill", "read_learned_skill", "travel_time"]) assert.equal(doorAllows("read", name, {}), true, name);
  assert.deepEqual([...WEB_READS].sort(), ["open_page", "read_learned_skill", "read_skill", "search_web", "travel_time"]);
  assert.equal(doorAllows("read", "tapback"), true);

  assert.equal(doorAllows("act", "write_note", write), true);
  assert.equal(doorAllows("act", "browse", {}), true);
  assert.ok(ROUTE_AT > 0.5 && ROUTE_AT < 1);
});

test("narrowForDoor: quick keeps reply words and need_more_tools; read keeps read-only tools; act keeps the turn's own lists", () => {
  const tools = held("search_notes", "write_note", "orient");
  const local = [{ tool: { name: "tapback", description: "t", input_schema: {} }, call: async () => null }, { tool: { name: "ask_advisor", description: "a", input_schema: {} }, call: async () => null }];
  const web = { tools: [{ name: "open_page", description: "o", inputSchema: {} }, { name: "browse", description: "b", inputSchema: {} }], call: async () => null };

  const quick = narrowForDoor("quick", { tools, local, web });
  assert.deepEqual(quick.tools, []);
  assert.deepEqual(quick.web.tools, []);
  assert.deepEqual(quick.local.map((entry) => entry.tool.name), ["tapback", NEED_TOOLS]);
  assert.ok(quick.allowed.has("say_nothing") && quick.allowed.has(NEED_TOOLS) && !quick.allowed.has("search_notes"));

  const read = narrowForDoor("read", { tools, local, web });
  assert.deepEqual(read.tools.map((tool) => tool.name), ["search_notes", "orient"]);
  assert.deepEqual(read.web.tools.map((tool) => tool.name), ["open_page"]);
  assert.deepEqual(read.local.map((entry) => entry.tool.name), ["tapback", NEED_TOOLS]);
  assert.ok(!read.allowed.has("write_note") && !read.allowed.has("browse") && read.allowed.has("open_page"));

  const act = narrowForDoor("act", { tools, local, web });
  assert.equal(act.tools, tools, "the act door is the turn's own list");
  assert.equal(act.local, local);
  assert.equal(act.web, web);
  assert.ok(act.allowed.has("write_note") && act.allowed.has("browse") && act.allowed.has("ask_advisor"));
  assert.ok(!act.local.some((entry) => entry.tool.name === NEED_TOOLS), "act has no need_more_tools");
  assert.equal(needToolsLocal.tool.name, NEED_TOOLS);
});

test("outsideFor names the call that leaves a door, judged as the tool the six run it as", () => {
  const six = sixToolsOver(held("search_notes", "read_note", "write_note", "browse"), null);
  const read = narrowForDoor("read", { tools: held("search_notes", "read_note"), local: [], web: null });
  const outside = outsideFor("read", six, read.allowed);
  assert.equal(outside("search", { query: "tulips" }), null);
  assert.equal(outside("write", { action: "save", path: "a.md", content: "x" }), "write_note is outside the read door's tools");
  assert.equal(outside("manage", { action: "archive", args: {} }), null, "a refused action is answered in band, not a reason to leave");
  assert.equal(outside("write_note", { path: "a.md" }), "write_note is outside the read door's tools");
  assert.equal(outside(NEED_TOOLS, {}), "asked for more tools");
  assert.equal(outsideFor("act", six, new Set())("write_note", {}), null, "the act door never leaves");
  const quick = outsideFor("quick", six, narrowForDoor("quick", { tools: [], local: [], web: null }).allowed);
  assert.equal(quick("write", { action: "save", path: "a.md", content: "x" }), "write_note is outside the quick door's tools");
});

test("a quick door's answer with no call is the turn's answer, through the quick door, with no fallback", async () => {
  resetCreditState();
  const { bodies, fetchImpl } = scripted([text("Yes, 8 to 2.")]);
  const { args } = turnArgs(fetchImpl, held("search_notes", "write_note"));
  const seen = [];
  const turn = await runWithDoors({ runTurn: (options) => (seen.push(options), runTurn(options)), args, eligible: true, route: { route: "quick", sure: 0.9, ms: 4 }, waitedMs: 2, via: via() });
  assert.equal(turn.answer, "Yes, 8 to 2.");
  assert.deepEqual(turn.route, { pick: "quick", sure: 0.9, door: "quick", fellBack: null, routerMs: 4, waitedMs: 2 });
  assert.equal(seen.length, 1, "one run: the quick door's");
  assert.deepEqual((bodies[0].tools ?? []).map((tool) => tool.name), [], "it was offered no tools");
});

test("guard, quick: a write it asks for ends the specialist before it runs, and the front door runs the turn from scratch", async () => {
  resetCreditState();
  const { bodies, fetchImpl } = scripted([
    reply([use("a", "write_note", { path: "a.md", content: "x" })], "tool_use"), // the quick door asks for a write
    reply([use("b", "write_note", { path: "a.md", content: "x" })], "tool_use"), // the front door makes it
    text("Saved."),
  ]);
  const dispatched = [];
  const { args } = turnArgs(fetchImpl, held("orient", "search_notes", "write_note"), dispatched);
  const turn = await runWithDoors({ runTurn, args, eligible: true, route: { route: "quick", sure: 0.9, ms: 5 }, waitedMs: 1, via: via() });
  assert.deepEqual(dispatched, ["write_note"], "the write ran once, in the front door");
  assert.equal(bodies.length, 3, "the quick door's one request, then the front door's two");
  assert.deepEqual((bodies[0].tools ?? []).map((tool) => tool.name), [], "the quick door was offered no write");
  assert.ok(bodies[1].tools.some((tool) => tool.name === "write"), "the front door holds the write action");
  assert.equal(turn.answer, "Saved.");
  assert.equal(turn.outside, undefined, "the turn that answered is the front door's");
  assert.deepEqual(turn.route, { pick: "quick", sure: 0.9, door: "fd", fellBack: "write_note is outside the quick door's tools", routerMs: 5, waitedMs: 1 });
});

test("guard, read: a write six action that resolves to a write tool falls back before anything runs", async () => {
  resetCreditState();
  const { fetchImpl } = scripted([
    reply([use("a", "search", { query: "tulips" })], "tool_use"), // a read is fine
    reply([use("b", "write", { action: "save", path: "a.md", content: "x" })], "tool_use"), // a write is not
    reply([use("c", "write", { action: "save", path: "a.md", content: "x" })], "tool_use"), // the front door's
    text("Saved."),
  ]);
  const dispatched = [];
  const { args } = turnArgs(fetchImpl, held("orient", "search_notes", "read_note", "write_note"), dispatched);
  const turn = await runWithDoors({ runTurn, args, eligible: true, route: { route: "read", sure: 0.8, ms: 3 }, via: via() });
  assert.deepEqual(dispatched, ["search_notes", "write_note"], "the read ran in the read door; the write only in the front door");
  assert.equal(turn.route.door, "fd");
  assert.equal(turn.route.fellBack, "write_note is outside the read door's tools");
  assert.equal(turn.answer, "Saved.");
});

test("guard, read: need_more_tools hands the turn to the front door", async () => {
  resetCreditState();
  const { fetchImpl } = scripted([reply([use("a", NEED_TOOLS, {})], "tool_use"), text("Here it is.")]);
  const dispatched = [];
  const { args } = turnArgs(fetchImpl, held("search_notes", "write_note"), dispatched);
  const turn = await runWithDoors({ runTurn, args, eligible: true, route: { route: "read", sure: 0.8, ms: 3 }, via: via() });
  assert.deepEqual(dispatched, [], "nothing ran");
  assert.equal(turn.route.fellBack, "asked for more tools");
  assert.equal(turn.route.door, "fd");
  assert.equal(turn.answer, "Here it is.");
});

test("act: the front door's own chain, the same callTool, no check and no fallback; a held call stays held", async () => {
  resetCreditState();
  const { fetchImpl } = scripted([reply([use("a", "write_note", { path: "a.md", content: "x" })], "tool_use"), text("Drafted; I'll send it when you say.")]);
  const callTool = async () => ({ content: [{ type: "text", text: "Not done yet: this would change something." }], isError: true, held: true });
  const { args } = turnArgs(fetchImpl, held("orient", "write_note"));
  args.callTool = callTool;
  const seen = [];
  const turn = await runWithDoors({ runTurn: (options) => (seen.push(options), runTurn(options)), args, eligible: true, route: { route: "act", sure: 0.9, ms: 2 }, via: via() });
  assert.equal(seen.length, 1, "one run: the act door's, which is the front door's chain");
  assert.equal(seen[0].callTool, callTool, "the same dispatcher the front door holds");
  assert.equal(seen[0].outside("write_note", {}), null, "the act door never leaves");
  assert.equal(turn.route.door, "act");
  assert.equal(turn.route.fellBack, null);
  const traced = turn.timing.trace.find((entry) => entry.kind === "tool");
  assert.equal(traced.held, true, "the egress hold still holds the call for the person's yes");
  assert.equal(traced.ok, false, "and it did not run");
  assert.match(turn.answer, /I'll send it when you say/);
});

test("act: a failure of the act door is the front door's failure, not a fallback", async () => {
  resetCreditState();
  const args = turnArgs(async () => { throw new Error("gateway down"); }, held("write_note")).args;
  await assert.rejects(() => runWithDoors({ runTurn, args, eligible: true, route: { route: "act", sure: 0.9, ms: 1 }, via: via() }));
});

test("the router not sure, or a door not wired, is the front door alone, recorded as the router's pick", async () => {
  resetCreditState();
  const unsure = scripted([text("Hi.")]);
  let runs = 0;
  const count = (options) => ((runs += 1), runTurn(options));
  const unsureTurn = await runWithDoors({ runTurn: count, args: turnArgs(unsure.fetchImpl, held("search_notes")).args, eligible: true, route: { route: "quick", sure: ROUTE_AT - 0.1, ms: 9 }, via: via() });
  assert.equal(runs, 1, "no specialist ran");
  assert.deepEqual(unsureTurn.route, { pick: "quick", sure: ROUTE_AT - 0.1, door: "fd", fellBack: null, routerMs: 9, waitedMs: null });

  runs = 0;
  const unwired = scripted([text("Hi.")]);
  const unwiredTurn = await runWithDoors({ runTurn: count, args: turnArgs(unwired.fetchImpl, held("search_notes")).args, eligible: true, route: { route: "read", sure: 0.95, ms: 9 }, via: via({ wired: false }) });
  assert.equal(runs, 1, "the door is not wired: the front door answers");
  assert.equal(unwiredTurn.route.door, "fd");
  assert.equal(unwiredTurn.route.fellBack, null);

  runs = 0;
  const off = scripted([text("Hi.")]);
  const offTurn = await runWithDoors({ runTurn: count, args: turnArgs(off.fetchImpl, held("search_notes")).args, eligible: false, route: { route: "quick", sure: 0.95, ms: 9 }, via: via() });
  assert.equal(runs, 1);
  assert.equal(offTurn.route.door, "fd", "a turn that may not use a door (a resume, a job, a report) answers as before");

  runs = 0;
  const none = scripted([text("Hi.")]);
  const noneTurn = await runWithDoors({ runTurn: count, args: turnArgs(none.fetchImpl, held("search_notes")).args, eligible: true, route: null, via: via() });
  assert.equal(noneTurn.route, undefined, "no router read: nothing is recorded, so the reply is as it was");
});

test("job: a long job the router reads goes to the hand-off at once, before any round; a no-slot hand-off answers as the front door", async () => {
  resetCreditState();
  const job = scripted([text("should not run")]);
  let asked = 0;
  const args = turnArgs(job.fetchImpl, held("search_notes")).args;
  const turn = await runWithDoors({ runTurn, args, eligible: true, route: { route: "job", sure: 0.9, ms: 4 }, via: via(), handOffRoute: async () => (asked += 1, "On it: I'll text you when it's done.") });
  assert.equal(asked, 1);
  assert.equal(job.bodies.length, 0, "no model round ran");
  assert.equal(turn.answer, "On it: I'll text you when it's done.");
  assert.equal(turn.handedOff, "route");
  assert.equal(turn.route.door, "job");

  const noSlot = scripted([text("Here is the answer.")]);
  const fallback = await runWithDoors({ runTurn, args: turnArgs(noSlot.fetchImpl, held("search_notes")).args, eligible: true, route: { route: "job", sure: 0.9, ms: 4 }, via: via(), handOffRoute: async () => null });
  assert.equal(fallback.answer, "Here is the answer.");
  assert.equal(fallback.route.door, "fd");
});

test("job's own bar: a job pick at 0.2 goes to the front door at the 0.6 bar, to the hand-off at the Hand-off node's 0.1; a read pick keeps 0.6", async () => {
  resetCreditState();
  const offered = (jobAt) => {
    let asked = 0;
    return { asked: () => asked, run: () => runWithDoors({ runTurn, args: turnArgs(scripted([text("Here is the answer.")]).fetchImpl, held("search_notes")).args, eligible: true, route: { route: "job", sure: 0.2, ms: 4 }, via: via(), handOffRoute: async () => (asked += 1, "On it."), jobAt }) };
  };
  const none = offered(null);
  const noneTurn = await none.run();
  assert.equal(none.asked(), 0, "no hand-off at 0.2 under the doors' 0.6 bar");
  assert.equal(noneTurn.route.door, "fd");

  const low = offered(0.1);
  const lowTurn = await low.run();
  assert.equal(low.asked(), 1, "the Hand-off node's 0.1 bar lets the job pick through");
  assert.equal(lowTurn.route.door, "job");

  const read = await runWithDoors({ runTurn, args: turnArgs(scripted([text("Read answer.")]).fetchImpl, held("search_notes")).args, eligible: true, route: { route: "read", sure: 0.2, ms: 4 }, via: via(), handOffRoute: async () => "unused", jobAt: 0.1 });
  assert.equal(read.route.door, "fd", "the job bar is for job only: a read at 0.2 still goes to the front door");
});

test("a fallback adds the specialist's spend to the turn: its usage, and its usage by model", async () => {
  resetCreditState();
  const { fetchImpl } = scripted([
    reply([use("a", "write_note", { path: "a.md", content: "x" })], "tool_use"),
    reply([use("b", "write_note", { path: "a.md", content: "x" })], "tool_use"),
    text("Saved."),
  ]);
  const { args } = turnArgs(fetchImpl, held("write_note"));
  const turn = await runWithDoors({ runTurn, args, eligible: true, route: { route: "quick", sure: 0.9, ms: 1 }, via: via() });
  assert.equal(turn.usage.input, 3, "the quick door's one round and the front door's two");
  assert.equal(turn.usage.output, 3);
  assert.equal(turn.usageByModel[HAIKU].input, 3);

  const merged = addSpend({ usage: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0, decision: 0 }, usageByModel: { a: { input: 2, output: 2 } } }, { usage: { input: 1, output: 4, decision: 2 }, usageByModel: { a: { input: 1, output: 4 }, b: { input: 1, output: 1 } } });
  assert.deepEqual(merged.usage, { input: 3, output: 6, cacheRead: 0, cacheWrite: 0, decision: 2 });
  assert.deepEqual(merged.usageByModel, { a: { input: 3, output: 6 }, b: { input: 1, output: 1 } });
});

test("the act door's prompt is the setup's door words, or the front door's notes when the setup has none", async () => {
  resetCreditState();
  const { fetchImpl, bodies } = scripted([text("Done.")]);
  const { args } = turnArgs(fetchImpl, held("write_note"));
  args.notes = { prompt: "THE FRONT DOOR" };
  await runWithDoors({ runTurn, args, eligible: true, route: { route: "act", sure: 0.9, ms: 1 }, via: via(), doorNotes: () => ({ prompt: "THE ACT DOOR" }) });
  assert.match(JSON.stringify(bodies[0].system ?? ""), /THE ACT DOOR/);
  const plain = scripted([text("Done.")]);
  await runWithDoors({ runTurn, args: { ...turnArgs(plain.fetchImpl, held("write_note")).args, notes: { prompt: "THE FRONT DOOR" } }, eligible: true, route: { route: "act", sure: 0.9, ms: 1 }, via: via(), doorNotes: () => null });
  assert.doesNotMatch(JSON.stringify(plain.bodies[0].system ?? ""), /THE ACT DOOR/);
});

test("door nodes: each returns the door it is, and fd's wires name the nodes the doors are", async () => {
  assert.deepEqual(await fdQuickNode({ route: "quick", sure: 0.9 }), { door: "quick", kind: "door-quick", tools: "none", when: ["quick"] });
  assert.deepEqual(await fdActNode({}), { door: "act", kind: "door-act", tools: "all", when: ["act"] });
  assert.equal((await doorNode("read")({})).tools, "read");
  assert.deepEqual(DOOR_NODES, { quick: "fdQuick", read: "fdRead", act: "fdAct" });
});

test("texModules: main's config draws the three doors' prompts, each the front door's list with its door words last; a config without them draws none", () => {
  const drawn = texModules(TEX_CONFIG);
  assert.deepEqual(Object.keys(drawn), ["texts", "group", "job", "door-quick", "door-read", "door-act"]);
  for (const door of ["quick", "read", "act"]) assert.deepEqual(drawn[`door-${door}`], [...drawn.texts, `door-${door}`]);

  const bare = { ...TEX_CONFIG, nodes: TEX_CONFIG.nodes.filter((node) => !Object.values(DOOR_NODES).includes(node.id)) };
  const plain = texModules(bare);
  assert.deepEqual(Object.keys(plain), ["texts", "group", "job"]);
  assert.deepEqual(plain.texts, drawn.texts, "the front door's own lists are unchanged");

  const fd = TEX_CONFIG.nodes.find((node) => node.id === "fd");
  const own = { ...bare, nodes: [...bare.nodes, { ...fd, id: "fdRead", ctx: ["p-tools"] }] };
  assert.deepEqual(texModules(own)["door-read"], ["tools"]);
  const none = { ...bare, nodes: [...bare.nodes, { ...fd, id: "fdAct", ctx: ["p-no-such-words"] }] };
  assert.throws(() => texModules(none), /no words/);
});

test("the act door, chosen by the router, holds a handle claim for the person's yes, as the front door does (the egress hold, end to end)", async () => {
  // agentEgressTexting.test.mjs's handle claim, through the worker, with main's wires and the router switched on: the
  // router reads the text as an act, and the turn runs through fdAct. The claim is held, nothing is claimed, and the
  // route record says the act door answered with no fallback.
  const world = await createEgressWorld();
  const { model, controlPlane, env, pending, restore } = world;
  const router = TEX_CONFIG.nodes.find((node) => node.id === "router");
  // Main draws the doors and the wires (doorStep -> router, fd -> fdAct); the router's `on` is the switch.
  assert.equal(router.on, false, "main ships the router off");
  assert.ok(TEX_CONFIG.edges.some((e) => e.from === "doorStep" && e.to === "router" && e.mode === "uses"));
  assert.ok(TEX_CONFIG.edges.some((e) => e.from === "fd" && e.to === "fdAct" && e.mode === "uses"));
  const drawn = { on: router.on };
  router.on = true;
  env.AI = { run: async (_model, input) => ({ answers: input?.questions?.route ? { route: { choice: "act", confidence: 0.9 } } : {} }) };
  const claimed = (slug) => controlPlane.workspaceSetupCalls.some((entry) => entry.dryRun === false && entry.slug === slug);
  try {
    model.install([{ toolCalls: [{ name: "create_workspace", args: { slug: "woodshop", name: "woodshop" } }] }, { text: "I can set up @woodshop. Shall I?" }]);
    const asked = await ask(env, TOKEN_TEXTS, "make me a workspace called woodshop");
    assert.equal(asked.status, 200);
    assert.equal(asked.body?.route?.door, "act", JSON.stringify(asked.body?.route));
    assert.equal(asked.body?.route?.fellBack, null);
    assert.equal(asked.body?.route?.pick, "act");
    const replies = toolReplies(model.requests.at(-1));
    assert.match(replies[0] ?? "", /Held for their 👍/, "the claim waits for the person");
    assert.equal(claimed("woodshop"), false, "nothing was claimed");
    assert.equal(pending().length, 1, "the held call is waiting");
  } finally {
    router.on = drawn.on;
    restore();
  }
});

test("routeBeside: an off router starts nothing and never waits on the Shape gate; an on one is asked with the gate's read", async () => {
  const t = { chatTurn: true, job: null, report: null, routine: null, runner: null, crossChat: false, question: "is it raining", group: null };
  let asked = 0;
  const use = { router: async (input) => { asked += 1; return { route: "quick", sure: 0.9, input }; } };
  const never = new Promise(() => {});
  assert.equal(routeBeside({ ...t, shapeRead: never }, { use, on: (id) => id !== "router" }), null);
  assert.equal(asked, 0);
  assert.equal(routeBeside(t, { use: new Proxy({}, { get() { throw new Error("no wire"); } }), on: () => true }), null);
  const read = Promise.resolve({ to: "read", ending: "answer", endingSure: 0.8, order: [], records: [] });
  const got = await routeBeside({ ...t, shapeRead: read }, { use, on: () => true });
  assert.equal(asked, 1);
  assert.equal(got.route, "quick");
});

test("routeBeside caps the router's whole read: one not back in time is no route, so the front door never waits on it", async () => {
  const t = { chatTurn: true, job: null, report: null, routine: null, runner: null, crossChat: false, question: "send it", group: null };
  const use = { router: () => new Promise(() => {}) };
  const started = Date.now();
  assert.equal(await routeBeside(t, { use, on: () => true }, 30), null, "a router that never answers is no route");
  assert.ok(Date.now() - started < 1000, "and the wait is capped");
  const slowGate = { ...t, shapeRead: new Promise(() => {}) };
  assert.equal(await routeBeside(slowGate, { use: { router: async () => ({ route: "act", sure: 0.9 }) }, on: () => true }, 30), null, "a Shape gate that hangs counts against the same cap");
  const got = await routeBeside(t, { use: { router: async (input) => { assert.equal(input.recent, undefined, "no chat words in the router's input"); return { route: "act", sure: 0.9 }; } }, on: () => true }, 500);
  assert.equal(got.route, "act");
});

// Dev2, 2026-11-20: the Router on as a logged signal only. With no door and no router -> handoff wired, nothing waits on
// its read; the read is recorded on the turn after it ran, as the front door's, waited 0.
test("the router's read is waited on only while a door or router -> handoff is wired; else it is logged after the turn", async () => {
  const none = () => false;
  assert.equal(routeActs(none), false);
  assert.equal(routeActs(none, true), true);
  assert.equal(routeActs((from, to) => from === "fd" && to === "fdRead"), true);
  assert.equal(routeActs((from, to) => from === "fd" && to === "fdQuick"), true);
  assert.equal(routeActs((from, to) => from === "doorStep" && to === "router"), false);
  // Back already: its read. Still out, failed or missing: null, at once.
  const back = Promise.resolve({ route: "read", sure: 0.9, ms: 1016 });
  await back;
  assert.deepEqual(await routeIfBack(back), { route: "read", sure: 0.9, ms: 1016 });
  const started = Date.now();
  assert.equal(await routeIfBack(new Promise(() => {})), null);
  assert.ok(Date.now() - started < 50, "a read still out was waited on");
  assert.equal(await routeIfBack(Promise.reject(new Error("down"))), null);
  assert.equal(await routeIfBack(null), null);
  assert.deepEqual(loggedRoute({}, { route: "read", sure: 0.9, ms: 1016 }).route, { pick: "read", sure: 0.9, door: "fd", fellBack: null, routerMs: 1016, waitedMs: 0, logOnly: true });
  assert.equal(loggedRoute({}, null).route, undefined);
  // A route a door already recorded is kept.
  assert.equal(loggedRoute({ route: { pick: "quick" } }, { route: "read" }).route.pick, "quick");
});
