/**
 * The move judge (`agent/graph/nodes/moveJudge.js`, wired as tools -> moveJudge) and the guard that asks it (`agent/theirNotes.js`).
 * Servant Hearted trace issue 6 (2026-11-17): a yes to Tex's own "Want me to move it?" was refused by the word list,
 * and a note that wasn't there was kept as "theirs".
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted (2026-11-17).
 *
 *  1. `judgedAsked` without the listing check → "a note that isn't there is never kept as theirs" fails.
 *  2. `withTheirNotesKept` ignoring `judge` → "their yes to Tex's offer lets the move run" fails.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { judgeMove, moveWords, MOVE_JUDGE_SYSTEM } from "../src/agent/graph/nodes/moveJudge.js";
import { saidBefore, withTheirNotesKept } from "../src/agent/theirNotes.js";
import { GATEWAY_NODES } from "../src/agent/graph/gatewayNodes.js";
import SHELF from "../../../packages/tex/src/texNodeShelf.json" with { type: "json" };
import { TEX_CONFIG } from "../src/agent/texConfig.js";

const LISTING = "inbox/agenda.md (200 bytes)";
function dispatcher() {
  const calls = [];
  const callTool = async (name, args) => {
    calls.push({ name, args });
    if (name === "list_notes") return { content: [{ type: "text", text: LISTING }] };
    return { content: [{ type: "text", text: "moved" }] };
  };
  return { calls, callTool };
}
const MOVE = { source: "inbox/agenda.md", destination: "inbox/agenda.md", destination_context: "@band" };

test("their yes to Tex's offer lets the move run, once the judge says so", async () => {
  const { calls, callTool } = dispatcher();
  const asked = [];
  const judge = async (input) => (asked.push(input), { allow: true, reason: "they agreed" });
  const said = [{ from: "tex", text: "Want me to move the agenda into the band workspace? 👍 or 👎?" }];
  const call = withTheirNotesKept(callTool, { question: "yes", judge, said });
  const result = await call("move_note", MOVE);
  assert.notEqual(result.isError, true);
  assert.equal(calls.at(-1).name, "move_note");
  assert.deepEqual(asked[0].said.map((line) => line.from), ["tex", "person"], "the judge reads Tex's offer and their answer");
  assert.equal(asked[0].action, "move");
});

test("a judge that says no, or fails, keeps their note where it is", async () => {
  for (const judge of [async () => ({ allow: false, reason: "no" }), async () => { throw new Error("down"); }]) {
    const { calls, callTool } = dispatcher();
    const result = await withTheirNotesKept(callTool, { question: "thanks", judge })("archive_note", { path: "inbox/agenda.md" });
    assert.equal(result.isError, true);
    assert.ok(!calls.some((c) => c.name === "archive_note"));
  }
});

test("a note that isn't there is never kept as theirs: the call answers for itself", async () => {
  const { calls, callTool } = dispatcher();
  let judged = 0;
  const judge = async () => (judged++, { allow: false, reason: "no" });
  const result = await withTheirNotesKept(callTool, { question: "ok", judge })("move_note", { source: "inbox/missing.md", destination: "x.md" });
  assert.notEqual(result.isError, true);
  assert.equal(calls.at(-1).name, "move_note");
  assert.equal(judged, 0, "nothing to judge");
});

test("without the judge wired, the word list decides as before", async () => {
  const { calls, callTool } = dispatcher();
  const result = await withTheirNotesKept(callTool, { question: "yes" })("move_note", MOVE);
  assert.equal(result.isError, true);
  assert.ok(!calls.some((c) => c.name === "list_notes"), "no listing either");
});

test("the judge reads who said what, oldest first, newest kept when cut", () => {
  assert.equal(moveWords([{ from: "tex", text: "Move it?" }, { from: "person", text: "yes" }]), "Tex: Move it?\nThem: yes");
  assert.ok(moveWords([{ from: "person", text: "a".repeat(3000) + "END" }]).endsWith("END"));
  assert.deepEqual(saidBefore([{ role: "user", text: "move it to v2l" }, { role: "assistant", text: "Want me to?" }, { role: "tool", text: "x" }]), [
    { from: "person", text: "move it to v2l" },
    { from: "tex", text: "Want me to?" },
  ]);
});

test("a verdict only counts when it is a clear yes", async () => {
  const config = { accountId: "a", gatewayId: "g", token: "t" };
  const reply = (args) => async () => new Response(JSON.stringify({ content: [{ type: "tool_use", id: "v", name: "verdict", input: args }], stop_reason: "tool_use" }), { headers: { "content-type": "application/json" } });
  const said = [{ from: "person", text: "yes" }];
  assert.equal((await judgeMove({ said, action: "move", path: "a.md" }, config, { model: "anthropic/claude-haiku-5-5", fetchImpl: reply({ allow: false, reason: "no" }) })).allow, false);
  assert.equal((await judgeMove({ said, action: "move", path: "a.md" }, config, { model: "anthropic/claude-haiku-5-5", fetchImpl: reply({ allow: true, reason: "they said yes" }) })).allow, true, "a clear yes runs");
  assert.equal((await judgeMove({ said: [], action: "move", path: "a.md" }, config, { model: "m" })).allow, false, "no words, no yes");
  assert.equal((await judgeMove({ said, action: "move", path: "a.md" }, config, { model: "m", fetchImpl: async () => { throw new Error("down"); } })).allow, false);
  assert.match(MOVE_JUDGE_SYSTEM, /Examples:/, "judged from examples");
});

test("the move judge is wired: its code is on the runner, off the shelf, and main's config calls it from tools", () => {
  assert.equal(typeof GATEWAY_NODES.moveJudge, "function");
  assert.equal(SHELF.nodes.moveJudge, undefined);
  assert.ok(TEX_CONFIG.nodes.some((n) => n.id === "moveJudge" && n.on !== false));
  assert.ok(TEX_CONFIG.edges.some((e) => e.from === "tools" && e.to === "moveJudge" && e.mode === "uses" && e.when?.includes("move")));
});
