/**
 * The reflect and memory nudge steps after a texted turn are config nodes (Dev2, 2026-11-14: "no shadow code"): the
 * `send -> reflect` and `send -> nudge` wires of `texConfig.json` run them behind the reply, and nothing waits for them.
 * Their gate (texted, could write, personal workspace) is the one check that ends a non-texted turn before any work.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import graphLib from "../../../packages/shared/src/texGraph.cjs";
import { TEX_CONFIG } from "../src/agent/texConfig.js";
import { nudgeAfterTurn, reflectAfterTurn } from "../src/agent/reflect.js";
import reflectNode from "../src/agent/graph/nodes/reflect.js";
import nudgeNode from "../src/agent/graph/nodes/nudge.js";

const { createGraph } = graphLib;

const wired = (from, to) => TEX_CONFIG.edges.some((edge) => edge.from === from && edge.to === to);
const webSession = { actorClientId: "web_app", workspaceId: "ws_test", grantId: "grant_test" };
const personalStore = { contexts: [{ current: true, kind: "personal" }] };

test("send's background wires run reflect and the nudge, behind the reply, and tools has no wire to reflect", () => {
  const send = TEX_CONFIG.edges.filter((edge) => edge.from === "send");
  assert.deepEqual(send.find((edge) => edge.to === "reflect")?.mode, "background");
  assert.deepEqual(send.find((edge) => edge.to === "nudge")?.mode, "background");
  assert.ok(wired("send", "reflect") && wired("send", "nudge"));
  assert.ok(!wired("tools", "reflect"), "tools has no wire to reflect, so a fire from it is refused");
});

test("send's reflect and nudge run through the runner and are logged by it", async () => {
  const logged = [];
  const impls = {
    reflect: async (input, io) => ({ outcome: `stub-reflect ${input.question} ${io.ctx.tag}` }),
    nudge: async (input) => ({ outcome: `stub-nudge ${input.answer}` }),
  };
  const graph = createGraph(TEX_CONFIG, impls, { log: (entry) => logged.push(entry) });
  const ctx = { tag: "ctx-tag" };
  const reflected = await graph.runNode("reflect", { question: "q1", tainted: false, ownText: true, canWrite: true }, ctx, "send:fire");
  const nudged = await graph.runNode("nudge", { question: "q1", answer: "a1", tainted: false, canWrite: true }, ctx, "send:fire");
  assert.deepEqual(reflected.output, { outcome: "stub-reflect q1 ctx-tag" });
  assert.deepEqual(nudged.output, { outcome: "stub-nudge a1" });
  assert.deepEqual(logged.map((entry) => [entry.node, entry.ok, entry.via]), [["reflect", true, "send:fire"], ["nudge", true, "send:fire"]]);
});

test("the gate skips a non-texted session for both steps, before any work", async () => {
  const args = { env: {}, controlPlane: null, store: personalStore, session: webSession, offered: [], question: "q", turn: { answer: "a", steps: [] }, tainted: false, canWrite: true };
  assert.deepEqual(await reflectAfterTurn(args), { outcome: "skipped" });
  assert.deepEqual(await nudgeAfterTurn(args), { outcome: "skipped" });
});

test("the gate also skips a texted session that cannot write, or a shared workspace", async () => {
  const texted = { ...webSession, actorClientId: "context_texts" };
  const args = { env: {}, controlPlane: null, store: personalStore, session: texted, offered: [], question: "q", turn: { answer: "a", steps: [] }, tainted: false };
  assert.deepEqual(await reflectAfterTurn({ ...args, canWrite: false }), { outcome: "skipped" });
  assert.deepEqual(await nudgeAfterTurn({ ...args, canWrite: false }), { outcome: "skipped" });
  const shared = { contexts: [{ current: true, kind: "shared" }] };
  assert.deepEqual(await reflectAfterTurn({ ...args, store: shared, canWrite: true }), { outcome: "skipped" });
  assert.deepEqual(await nudgeAfterTurn({ ...args, store: shared, canWrite: true }), { outcome: "skipped" });
});

test("the node files hand their input and the ctx to the gate", async () => {
  const io = { ctx: { env: {}, controlPlane: null, store: personalStore, session: webSession, offered: [], turn: { answer: "a", steps: [] }, learned: null, timeZone: "UTC" } };
  assert.deepEqual(await reflectNode({ question: "q", tainted: false, ownText: false, canWrite: true }, io), { outcome: "skipped" });
  assert.deepEqual(await nudgeNode({ question: "q", answer: "a", tainted: false, canWrite: true }, io), { outcome: "skipped" });
});
