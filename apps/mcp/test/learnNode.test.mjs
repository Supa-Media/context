/**
 * Learn (Dev2, 2026-11-16: Reflect and the Memory nudge, merged): one background step behind Text them writes what a
 * texted turn taught, the nudge first and then reflect, each one's outcome its own field, and one that fails never
 * stops the other. Its gate (texted, could write, personal workspace) ends a non-texted turn before any work.
 *
 * Sabotage record (temporary local edits, reverted):
 *   learn() lets a throwing half throw              "a half that fails is kept as failed, and the other still runs" fails
 *   the send -> learn wire made "wait"              "Text them's background wire runs Learn" fails
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import graphLib from "../../../packages/tex/src/texGraph.cjs";
// The simpler graph, drawn in the Lab and promoted to live Tex's config (Dev2, 2026-11-16).
import { TEX_CONFIG } from "../src/agent/texConfig.js";
import { nudgeAfterTurn, reflectAfterTurn } from "../src/agent/reflect.js";
import learn from "../src/agent/graph/nodes/learn.js";

const { createGraph } = graphLib;

const webSession = { actorClientId: "web_app", workspaceId: "ws_test", grantId: "grant_test" };
const personalStore = { contexts: [{ current: true, kind: "personal" }] };

test("Text them's background wire runs Learn behind the reply, and nothing else reaches it", () => {
  const into = TEX_CONFIG.edges.filter((e) => e.to === "learn");
  assert.deepEqual(into.map((e) => [e.from, e.mode, e.when.join()]), [["send", "background", "fired"]]);
  assert.ok(!TEX_CONFIG.edges.some((e) => ["reflect", "nudge"].includes(e.to)), "the two halves run as no steps of their own");
  for (const half of ["reflect", "nudge"]) assert.ok(!TEX_CONFIG.nodes.some((n) => n.id === half), `${half} is no step of its own: retired to the shelf, 2026-11-20`);
  const step = TEX_CONFIG.nodes.find((n) => n.id === "learn");
  assert.equal(step.effort, "low", "Learn thinks (Dev2, 2026-11-16)");
});

test("the gate skips a non-texted session for both halves, before any work", async () => {
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
});

test("Learn hands its input and the ctx to both halves and reports each one's outcome", async () => {
  const io = { ctx: { env: {}, controlPlane: null, store: personalStore, session: webSession, offered: [], turn: { answer: "a", steps: [] }, learned: null, timeZone: "UTC" } };
  assert.deepEqual(await learn({ question: "q", answer: "a", tainted: false, ownText: false, canWrite: true }, io), { nudge: { outcome: "skipped" }, reflect: { outcome: "skipped" } });
});

test("a half that fails is kept as failed, and the other still runs", async () => {
  // A store whose contexts throw makes both gates throw; Learn keeps each as its own failed outcome.
  const store = { get contexts() { throw new Error("store down"); } };
  const io = { ctx: { env: {}, controlPlane: null, store, session: { ...webSession, actorClientId: "context_texts" }, offered: [], turn: { answer: "a", steps: [] }, learned: null, timeZone: "UTC" } };
  const out = await learn({ question: "q", answer: "a", tainted: false, ownText: false, canWrite: true }, io);
  for (const half of ["nudge", "reflect"]) assert.ok(["failed", "skipped"].includes(out[half].outcome), JSON.stringify(out));
});

test("a turn's run never fires Learn with Text them's output: its wire fires only when send's code fires it", async () => {
  const ran = [];
  const stub = (id, output = {}) => async () => (ran.push(id), output);
  const nodes = { send: stub("send", { when: ["sent", "threads"], texts: 3 }), afterReply: stub("afterReply", { filed: 1 }), learn: stub("learn", { nudge: {}, reflect: {} }) };
  const config = { ...TEX_CONFIG, nodes: TEX_CONFIG.nodes.map((node) => ({ ...node, inSchema: undefined, outSchema: undefined })) };
  const pending = [];
  await createGraph(config, nodes, { background: (run) => pending.push(run) }).run("send", {}, {});
  await Promise.all(pending);
  assert.deepEqual(ran.sort(), ["afterReply", "send"]);
});
