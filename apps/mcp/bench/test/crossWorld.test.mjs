/**
 * The bench's group chats as production holds them (`groupChat.mjs`) and Tex asking Tex across chats (`crossWorld.mjs`):
 * a member's tag reads its workspace and never writes it, and a 1:1's `ask_chat` reaches its group's chat and its
 * answer comes back as the 1:1's own turn. Every model call here is scripted; nothing leaves the world.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createWorld } from "../world.mjs";
import { crossLines, groupName, groupNames } from "../crossWorld.mjs";
import { taggerRole } from "../groupChat.mjs";
import { asSixCall } from "../../test/sixCallFixture.mjs";

const SETUP = "---\njob: texting-assistant\nmodels:\n  main: anthropic/claude-haiku-5-5\n---\n\nYou are a test assistant.\n";

const bench = {
  people: [
    { person: "Maya", workspace: "maya", role: "owner", personal: true },
    { person: "Maya", workspace: "brand", role: "member", personal: false },
    { person: "Priya", workspace: "priya", role: "owner", personal: true },
    { person: "Priya", workspace: "brand", role: "owner", personal: false },
  ],
  workspaces: {
    maya: { files: { "money/fund.md": "FUND-MARK 1,200 saved\n" }, heldBack: [] },
    priya: { files: { "todo.md": "- nothing\n" }, heldBack: [] },
    brand: { files: { "gigs/shoot.md": "# Shoot\n\nFriday at the studio.\n" }, heldBack: [] },
  },
};

const reply = (content, stop = "end_turn") =>
  new Response(JSON.stringify({ content, stop_reason: stop, usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200, headers: { "Content-Type": "application/json" } });
const toolUse = (id, name, input) => {
  const six = asSixCall({ name, args: input });
  return { type: "tool_use", id, name: six.name, input: six.args };
};
const lastToolResult = (body) => {
  const last = body.messages.at(-1);
  return Array.isArray(last?.content) ? last.content.find((block) => block.type === "tool_result") : null;
};
const offers = (body, name) => JSON.stringify(body.tools ?? []).includes(name);

test("a member's tag holds the group at the member's role, as production does, and never a raised one", () => {
  assert.equal(taggerRole("member"), "member");
  assert.equal(taggerRole("editor"), "editor");
  assert.equal(taggerRole("owner"), "owner");
  assert.equal(taggerRole(undefined), "member", "a role people.md does not name is the lowest, never editor");
});

// Sabotage: give `benchGroup` the old `owner ? owner : editor` grant and the write lands in brand/, so this fails.
test("a group chat tagged by a member cannot write the shared workspace's note", async () => {
  const gatewayFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (!offers(body, "write")) return reply([{ type: "text", text: "On it." }]);
    const result = lastToolResult(body);
    if (result) return reply([{ type: "text", text: JSON.stringify(result.content).slice(0, 200) }]);
    return reply([toolUse("toolu_w", "write_note", { context: "@brand", path: "gigs/snare.md", content: "# Snare\n\nTheo brings the spare snare.\n" })], "tool_use");
  };
  const world = await createWorld(bench, "Maya", SETUP, { gatewayFetch, group: "brand" });
  try {
    const turn = await world.text("tex add to the shoot note that theo brings the snare");
    assert.ok(turn.ok, turn.error ?? "");
assert.deepEqual(world.changes().filter((change) => change.workspace === "brand"), [], "a member's chat wrote nothing to the shared workspace");
  } finally {
    world.close();
  }
});

// Sabotage: drop the `groups` list in `oneToOneGroups`, or `cross.counts()` from the 1:1 body, and `ask_chat` is never
// offered; drop `carry`'s group run and no answer comes back; either fails this.
test("a 1:1 asks Tex in its group, the group's run answers, and the answer is texted in the 1:1", async () => {
  const seen = { asked: false, groupRun: null, answerRun: null };
  const gatewayFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const words = JSON.stringify(body.messages ?? []);
    const system = JSON.stringify(body.system ?? "");
    if (!offers(body, "send") && !offers(body, "fetch")) return reply([{ type: "text", text: "{}" }]); // a judge or sorter
    if (/Tex in their 1:1 asks|asks you: \\"/.test(words) || system.includes("THIS RUN ANSWERS ANOTHER CHAT")) {
      seen.groupRun = { system, words };
      return reply([{ type: "text", text: "The shoot is Friday at the studio." }]);
    }
    if (system.includes("answered the ask you sent it") || words.includes("answered the ask you sent it")) {
      seen.answerRun = { system, words };
      return reply([{ type: "text", text: "Tex in Brand says the shoot is Friday at the studio." }]);
    }
    if (lastToolResult(body)) return reply([{ type: "text", text: "Asked Tex in Brand, I'll text you when it answers." }]);
    seen.asked = /Their groups: Brand|- Brand \(with @priya\)/.test(JSON.stringify(body.tools ?? []) + system);
    return reply([toolUse("toolu_a", "ask_chat", { chat: "Brand", what: "When is the shoot?" })], "tool_use");
  };
  const world = await createWorld(bench, "Maya", SETUP, { gatewayFetch, groups: "brand", ledgerTurns: true });
  try {
    await world.groupEarlier([{ chat: "brand", who: "priya", text: "PRIYA-MARK the shoot moved to Friday" }]);
    const turn = await world.text("ask tex in the brand chat when the shoot is");
    assert.ok(turn.ok, turn.error ?? "");
    assert.ok(seen.asked, "the 1:1's ask_chat names its group, from the control plane's list");
    assert.ok(turn.tools.some((call) => call.tool === "ask_chat" && call.ok), `ask_chat ran: ${JSON.stringify(turn.tools)}`);
    assert.equal(turn.crossAsks.length, 1, "the gate let the ask go");
    const carried = await world.crossAsk(turn.crossAsks[0]);
    assert.ok(seen.groupRun, "the ask ran in the group's chat");
    assert.match(seen.groupRun.words + seen.groupRun.system, /PRIYA-MARK the shoot moved to Friday/, "the group's run reads what was said in the group before");
    assert.equal(carried.state, "answered");
    assert.deepEqual(carried.said, ["The shoot is Friday at the studio."]);
    assert.ok(seen.answerRun, "the answer started the 1:1's own run");
    assert.ok(carried.answer.ok, carried.answer.error ?? "");
    const lines = crossLines(carried);
    assert.equal(lines[0].silent, true, "what the other chat said is a marker the person never saw");
    assert.match(lines[0].text, /Tex in the Brand chat took the ask "When is the shoot\?" and answered back: "The shoot is Friday at the studio\."/);
    assert.equal(lines[1].text, "Tex in Brand says the shoot is Friday at the studio.");
  } finally {
    world.close();
  }
});

// The other side of the sabotage above: with no `groups:` the bench's 1:1 has no list, so the gateway offers no ask_chat.
test("a 1:1 with no groups cannot ask another chat, and carries no ask", async () => {
  const gatewayFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (!offers(body, "send")) return reply([{ type: "text", text: "{}" }]);
    if (lastToolResult(body)) return reply([{ type: "text", text: "I can't ask there." }]);
    return reply([toolUse("toolu_a", "ask_chat", { chat: "Brand", what: "When is the shoot?" })], "tool_use");
  };
  const world = await createWorld(bench, "Maya", SETUP, { gatewayFetch });
  try {
    const turn = await world.text("ask tex in the brand chat when the shoot is");
    assert.ok(turn.ok, turn.error ?? "");
    assert.ok(!turn.tools.some((call) => call.tool === "ask_chat" && call.ok), "no ask went");
    assert.deepEqual(turn.crossAsks, []);
  } finally {
    world.close();
  }
});

test("a test's groups line and a group's name", () => {
  assert.deepEqual(groupNames("band, book-club"), ["band", "book-club"]);
  assert.deepEqual(groupNames(undefined), []);
  assert.equal(groupName("book-club"), "Book Club");
});

// The group and cross-chat cases are scored by the Area 2 metric ids (`@supa projects/tex-quality/eval-metrics.md`):
// every case tags at least one line, and every id the five name is in the table, so a typo fails here, not at a run.
test("groups.md and cross-chat.md read, every case tagged with Area 2 metric ids", async () => {
  const { readFile } = await import("node:fs/promises");
  const { parseTest } = await import("../load.mjs");
  const { METRICS } = await import("../metrics.mjs");
  const AREA2 = ["personal_leak_rate", "permission_scope_compliance", "sender_identity_accuracy", "cross_chat_routing_honesty", "group_signal_to_noise"];
  for (const id of AREA2) assert.ok(METRICS[id], id);
  assert.equal(METRICS.personal_leak_rate.better, "lower");
  const seen = new Set();
  for (const name of ["groups", "cross-chat"]) {
    const parsed = parseTest(await readFile(new URL(`../ai/tests/${name}.md`, import.meta.url), "utf8"));
    for (const q of parsed.questions) {
      assert.ok(q.metrics.length > 0, `${name} case ${q.n} tags no metric`);
      for (const tag of q.metrics) for (const id of tag.ids) (assert.ok(AREA2.includes(id), `${name} case ${q.n}: ${id}`), seen.add(id));
    }
    if (name === "cross-chat") {
      assert.equal(parsed.front.groups, "band");
      assert.ok(!parsed.questions.some((q) => q.checks.some((c) => c.line === "call send")), "must call names ask_chat, the tool that runs, never send");
    }
  }
  assert.deepEqual([...seen].sort(), [...AREA2].sort(), "the cases cover all five metrics");
});
