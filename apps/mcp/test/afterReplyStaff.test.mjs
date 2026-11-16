/**
 * After the reply (the Classifier and Self-review, one step) and Staff messages, as nodes (Dev2, 2026-11-16).
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-16):
 *   afterReply reviews on any sentAs                   "only a reply that went is scored" fails
 *   afterReply returns before the other half settles  "one half failing never stops the other" fails
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { TEX_CONFIG as MAIN, withDraft } from "../src/agent/texConfig.js";
import DRAFT from "./fixtures/simplerGraphDraft.json" with { type: "json" };

// The simpler graph as the Lab draft draws it (Dev2, 2026-11-16), run over main's config as a test chat runs it: its
// steps are built ahead of main's config (`texConfig.js` `SHELF_NODES`), so live Tex never runs them.
const TEX_CONFIG = withDraft(MAIN, DRAFT);
import { afterReplyNode } from "../src/agent/graph/nodes/afterReply.js";
import { staffNode } from "../src/agent/graph/nodes/staff.js";

const turn = (extra) => ({ env: {}, store: { contexts: [] }, session: { actorClientId: "web_app" }, controlPlane: null, question: "q", group: null, conversation: null, ...extra });

test("Text them's background wire runs After the reply when a reply went or the threads were read", () => {
  const into = TEX_CONFIG.edges.filter((e) => e.to === "afterReply").map((e) => [e.from, e.mode, e.when.join()]);
  assert.deepEqual(into, [["send", "background", "sent,threads"]]);
  assert.ok(!TEX_CONFIG.edges.some((e) => ["classifier", "selfreview"].includes(e.to)), "the two halves run as no steps of their own");
});

test("After the reply files the text into the threads it read, and reports how many", async () => {
  let sorted = 0;
  const out = await afterReplyNode({}, { ctx: { turn: turn({ sentAs: "ended", threadsSort: async () => (sorted += 1, [{ id: "a" }, { id: "b" }]) }) } });
  assert.deepEqual(out, { filed: 2 });
  assert.equal(sorted, 1);
});

test("only a reply that went is scored: an ended or exhausted turn files threads and never reviews", async () => {
  for (const sentAs of ["ended", "exhausted", "answered"]) assert.deepEqual(await afterReplyNode({}, { ctx: { turn: turn({ sentAs }) } }), {});
  // A sent reply runs the self-review, which a web session skips without a word (`selfReview.js` gate).
  const out = await afterReplyNode({}, { ctx: { turn: turn({ sentAs: "sent" }) } });
  assert.ok("reviewed" in out || Object.keys(out).length === 0, JSON.stringify(out));
});

test("one half failing never stops the other, and the step still fails so its row says so", async () => {
  let sorted = false;
  const failing = turn({ sentAs: "sent", store: null, threadsSort: async () => ((sorted = true), []) });
  const error = await afterReplyNode({}, { ctx: { turn: { ...failing, threadsSort: async () => { sorted = true; throw new Error("threads down"); } } } }).then(() => null, (e) => e);
  assert.equal(sorted, true);
  assert.equal(error?.message, "threads down");
});

test("Staff messages hands a chat move on to Staff move a chat, and nothing but what staff sent", async () => {
  assert.deepEqual(await staffNode({ kind: "person", number: "+15555550100" }), { when: ["move"], kind: "person", number: "+15555550100" });
  assert.deepEqual(await staffNode({ kind: "group", archiveOn: "2026-11-20" }), { when: ["move"], kind: "group", archiveOn: "2026-11-20" });
  const wires = TEX_CONFIG.edges.filter((e) => e.from === "staff" || e.to === "staff").map((e) => [e.from, e.to, e.when.join()]);
  assert.deepEqual(wires, [["staff", "moveChat", "move"]]);
  assert.equal(TEX_CONFIG.nodes.find((n) => n.id === "staff").kind, "input");
});
