/**
 * The router reads its context modules from its config `ctx`, like every other step (`src/agent/routerContext.js`,
 * `src/agent/graph/nodes/router.js`): what it is given, in the order the config names it, fitted to what Clef reads,
 * and read live within a cap that never holds the turn.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_DECISION_STATE_CHARS } from "../../../packages/tex/gateway/agent/decide.js";
import { routeRequest } from "../../../packages/tex/gateway/agent/specialistRoute.js";
import { routerContextText, routerWants } from "../../../packages/tex/gateway/agent/routerContext.js";
import { CONTEXT_MS, routerNode, routerReads } from "../../../packages/tex/gateway/agent/graph/nodes/router.js";
import { TEX_CONFIG, TRAINING, TRAINING_READERS } from "../../../packages/tex/gateway/agent/texConfig.js";

const moment = (n, route = "act") => ({ chat: `c${n}`, at: 0, kind: "one", before: ["@ann: earlier"], newest: `@ann: ask ${n}`, label: { route } });
const training = { nodes: { router: [moment(1, "act"), moment(2, "read")], fd: [moment(3)] }, chats: {} };

test("main's router reads its Training labels, the recent chat, what Tex is doing now and the date, and is on with no door wired", () => {
  // The recent chat, not the 7-day history: router-only Lab runs scored the same (57/63 in-context, 54/63 held-out)
  // at far fewer tokens.
  const router = TEX_CONFIG.nodes.find((n) => n.id === "router");
  assert.deepEqual(router.ctx, ["train:router", "recent", "groupBrief", "date"]);
  // On as a logged signal only (Dev2, 2026-11-20): no specialist door is wired, so nothing branches on its read.
  assert.equal(router.on, true, "the router runs on main");
  assert.ok(!TEX_CONFIG.edges.some((e) => e.from === "fd" && ["fdQuick", "fdRead", "fdAct"].includes(e.to)), "and no door reads it");
  assert.ok(TRAINING_READERS.includes("router"), "its code reads the Training module it names");
  assert.deepEqual(routerWants(router.ctx), { training: true, history: false, recent: true, facts: true, date: true });
});

test("routerContextText: each module the config names, in run order, in its tags; what the config doesn't name is not given", () => {
  const parts = { training, history: "@ann: draft the email\nYou: Here's the draft.", facts: ["Tex is working on a job in this chat: \"plumbers\"."], today: "Wed, Nov 18, 2026, 9:02 am (UTC)" };
  const all = routerContextText(["date", "train:router", "chat:7:130000", "groupBrief"], parts);
  const at = (tag) => all.indexOf(tag);
  // In run order, not the listed order (`texModuleChange.cjs`, Dev2 2026-11-20): Training, the brief, the chat, then the time.
  assert.ok(at("<examples>") < at("<now>") && at("<now>") < at("<chat-history>") && at("<chat-history>") < at("<today>"), "the run order");
  assert.match(all, /<newest>@ann: ask 1<\/newest>\n<route>act<\/route>/, "the router's own labels, its route as the want");
  assert.doesNotMatch(all, /ask 3/, "train:router reads the router's labels, not the front door's");
  assert.match(all, /<chat-history>\n@ann: draft the email\nYou: Here's the draft\.\n<\/chat-history>/);
  assert.equal(routerContextText([], parts), "", "no modules, nothing");
  assert.equal(routerContextText(["train:router"], { ...parts, training: null }), "", "no Training module read, no examples");
  const only = routerContextText(["chat:7:130000"], parts);
  assert.doesNotMatch(only, /<examples>|<now>|<today>/, "only what it names");
  assert.equal(routerContextText(["date", "unknown-module"], { today: "" }), "", "an empty part or an unknown module is nothing");
});

test("routeRequest fits the modules to what Clef reads: the text always, the newest of the chat kept, examples whole", () => {
  const ctx = ["train:router", "summaries:all:30000", "chat:7:130000", "groupBrief", "date"];
  const history = Array.from({ length: 4000 }, (_, i) => `@ann: line ${i}`).join("\n");
  const question = "and send it to Jo";
  const { state } = routeRequest({ question, context: { ctx, training: TRAINING, history, facts: ["a fact"], today: "today" } });
  assert.ok(state.length <= MAX_DECISION_STATE_CHARS, `within what Clef reads (${state.length})`);
  assert.ok(state.endsWith(`<text>\n${question}\n</text>`), "the text is never cut off the end");
  assert.match(state, /@ann: line 3999\n<\/chat-history>/, "the newest of the chat kept");
  assert.doesNotMatch(state, /@ann: line 0\n/, "the oldest left out for room");
  assert.match(state, /\(earlier chat left out for room\)/);
  assert.equal((state.match(/<example>/g) ?? []).length, (state.match(/<\/example>/g) ?? []).length, "no example cut in half");
  assert.match(state, /<now>\na fact\n<\/now>/);
  assert.doesNotMatch(routeRequest({ question }).state, /<examples>|<chat-history>/, "a router given no context reads the text alone");
});

test("routerReads: only the modules the config names are read, through the turn's own ledger, each within its cap", async () => {
  const calls = [];
  const ledger = { read: async (key, options) => { calls.push({ key, kinds: options?.kinds }); return { entries: [] }; } };
  const t = { session: { workspaceKind: "personal", workspaceId: "ws_test" }, store: { texLedger: () => ledger }, received: Date.UTC(2026, 10, 18, 14, 0), body: { timeZone: "UTC" } };
  const none = await routerReads(t, []);
  assert.deepEqual(calls, [], "no modules, no ledger read");
  assert.deepEqual(none, { ctx: [], training: null, history: "", facts: [], today: "" });
  const dated = await routerReads(t, ["date", "train:router"]);
  assert.match(dated.today, /Wednesday, November 18, 2026/);
  assert.equal(dated.training, TRAINING, "the process's Training module, with its hold-out");
  assert.deepEqual(calls, [], "the date and the examples read no ledger");
  await routerReads(t, ["chat:7:130000", "groupBrief"]);
  assert.ok(calls.length > 0 && calls.every((c) => c.key === "texts" || c.key === "texts.threads"), "the person's own one-to-one chat");
  const slow = { read: () => new Promise(() => {}) };
  const started = Date.now();
  const late = await routerReads({ ...t, store: { texLedger: () => slow } }, ["chat:7:130000", "groupBrief"], { waitMs: 30 });
  assert.equal(late.history, "");
  assert.deepEqual(late.facts, []);
  assert.ok(Date.now() - started < 1000, "a ledger that never answers is read as nothing, in time");
  assert.ok(CONTEXT_MS < 1_500, "the context wait is inside the turn's wait on the router (doorStep ROUTE_WAIT_MS)");
  const group = await routerReads({ ...t, session: { actorClientId: "texts-group" } }, ["chat:7:130000"]);
  assert.equal(group.history, "", "a session with no chat of its own reads no one's");
});

test("routerNode asks Clef with its context modules, never from its input; a reader that fails still routes", async () => {
  const states = [];
  const engine = async (state) => { states.push(state); return { route: { choice: "act", confidence: 0.9 } }; };
  const reads = async () => ({ ctx: ["chat:7:130000"], history: "You: Want me to send it?" });
  const out = await routerNode({ question: "yes", group: false, trigger: "text" }, { engine, reads, ctx: { turn: { env: {} } } });
  assert.deepEqual(out, { route: "act", sure: 0.9, when: ["act"] });
  assert.match(states[0], /<chat-history>\nYou: Want me to send it\?\n<\/chat-history>[\s\S]*<text>\nyes\n<\/text>$/);
  const failed = await routerNode({ question: "yes", group: false, trigger: "text" }, { engine, reads: async () => { throw new Error("ledger down"); }, ctx: { turn: { env: {} } } });
  assert.equal(failed.route, "act");
  assert.doesNotMatch(states[1], /chat-history/);
});
