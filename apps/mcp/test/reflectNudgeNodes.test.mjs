/**
 * The reflect and memory nudge steps after a texted turn are config nodes (Dev2, 2026-11-14: "no shadow code"): the
 * `send -> reflect` and `send -> nudge` wires of `texConfig.json` ran them behind the reply, and nothing waits for them.
 * Since the simpler graph (Dev2, 2026-11-16) both run inside Learn, over the one `send -> learn` background wire; the
 * two nodes are kept turned off until the cleanup after Promote, and their code still runs as Learn's halves. Their gate (texted, could write, personal workspace) is the one check that ends a non-texted turn before any work.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import graphLib from "../../../packages/tex/src/texGraph.cjs";
import { TEX_CONFIG } from "../../../packages/tex/gateway/agent/texConfig.js";
import { nudgeAfterTurn, reflectAfterTurn } from "../../../packages/tex/gateway/agent/reflect.js";
import reflectNode from "../../../packages/tex/gateway/agent/graph/nodes/reflect.js";
import nudgeNode from "../../../packages/tex/gateway/agent/graph/nodes/nudge.js";

const { createGraph } = graphLib;

const wired = (from, to) => TEX_CONFIG.edges.some((edge) => edge.from === from && edge.to === to);
const webSession = { actorClientId: "web_app", workspaceId: "ws_test", grantId: "grant_test" };
const personalStore = { contexts: [{ current: true, kind: "personal" }] };

test("send's background wires run Learn, After the reply, Chat day summaries and Connect, behind the reply, and nothing wires reflect or the nudge", () => {
  const send = TEX_CONFIG.edges.filter((edge) => edge.from === "send");
  // Still answers them? (Dev2, 2026-11-23, the no-shadow steps) is a uses wire: the Worker asks it before a held group reply goes.
  // Connect (Dev2, 2026-11-20: "score, then finder + connect step"): links the notes a turn wrote, after the reply.
  assert.deepEqual(send.map((edge) => [edge.to, edge.mode]).sort(), [["afterReply", "background"], ["chatDays", "background"], ["connect", "background"], ["learn", "background"], ["recheck", "uses"]]);
  assert.ok(!wired("send", "reflect") && !wired("send", "nudge"), "the halves run inside Learn, never as steps of their own");
  for (const half of ["reflect", "nudge"]) assert.ok(!TEX_CONFIG.nodes.some((node) => node.id === half), `${half} is retired off the config`);
  assert.ok(!wired("tools", "learn") && !wired("tools", "reflect"), "tools has no wire to Learn, so a fire from it is refused");
});

test("send's Learn, reflect and the nudge in it, runs through the runner and is logged by it", async () => {
  const logged = [];
  const impls = {
    learn: async (input, io) => ({ reflect: { outcome: `stub-reflect ${input.question} ${io.ctx.tag}` }, nudge: { outcome: `stub-nudge ${input.answer}` } }),
  };
  const graph = createGraph(TEX_CONFIG, impls, { log: (entry) => logged.push(entry) });
  const ctx = { tag: "ctx-tag" };
  const learned = await graph.runNode("learn", { question: "q1", answer: "a1", tainted: false, ownText: true, canWrite: true }, ctx, "send:fire");
  assert.deepEqual(learned.output, { reflect: { outcome: "stub-reflect q1 ctx-tag" }, nudge: { outcome: "stub-nudge a1" } });
  assert.deepEqual(logged.map((entry) => [entry.node, entry.ok, entry.via]), [["learn", true, "send:fire"]]);
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

test("a turn's run never fires Learn, reflect or the nudge with Text them's output: Learn's wire fires only when send's code fires it", async () => {
  const ran = [];
  const stub = (id, output = {}) => async () => (ran.push(id), output);
  const nodes = { send: stub("send", { when: ["sent", "threads"], texts: 3 }), afterReply: stub("afterReply", { filed: 1 }), classifier: stub("classifier", { filed: 1 }), selfreview: stub("selfreview", { filed: true }), learn: stub("learn", { nudge: {}, reflect: {} }), reflect: stub("reflect", { outcome: "done" }), nudge: stub("nudge", { outcome: "done" }) };
  const config = { ...TEX_CONFIG, nodes: TEX_CONFIG.nodes.map((node) => ({ ...node, inSchema: undefined, outSchema: undefined })) };
  const pending = [];
  await createGraph(config, nodes, { background: (run) => pending.push(run) }).run("send", {}, {});
  await Promise.all(pending);
  assert.deepEqual(ran.sort(), ["afterReply", "send"], "the Classifier and Self-review are off; After the reply runs in their place");
});
