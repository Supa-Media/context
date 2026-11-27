/**
 * In-app test conversations on the bench (`benchAppChat.mjs`): a Dev chat's in-app text becomes a case with what was on
 * screen (`setsFd.mjs` `- on screen:`, `load.mjs`), and the world runs it as the app chat's turn, so the On screen node
 * reads that note into the front door's turn note as production does. Every model call here is scripted.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createWorld } from "../world.mjs";
import { fdTest } from "../setsFd.mjs";
import { parseTest } from "../load.mjs";

const FRONT = "job: texting-assistant\nrun_as: Maya\ntoday: 2026-10-08\nruns: 1\nweb: scripted";
const conv = (kind, msgs) => ({ id: "c1", set: "dev", kind, members: ["Maya"], world: "maya", msgs });
const unit = (c, at) => ({ convo: c, at, label: {}, row: { chat: c.id, msg: c.msgs[at].id, at, node: "fd" } });
const SCREEN = { note: { workspace: "@maya", path: "money/fund.md" }, selection: "1,200 saved" };

// Sabotage: drop the `- on screen:` line from `fdTest` (or its parse in `load.mjs`) and the first two fail.
test("an in-app text's case carries what was on screen, and nothing open as null", () => {
  const set = conv("app", [{ id: "m1", who: "Maya", text: "how much is saved here?", screen: SCREEN }]);
  assert.deepEqual(parseTest(fdTest([unit(set, 0)], FRONT)).questions[0].screen, SCREEN);
  const none = conv("app", [{ id: "m1", who: "Maya", text: "hi" }]);
  assert.equal(parseTest(fdTest([unit(none, 0)], FRONT)).questions[0].screen, null);
});

test("a 1:1 text's case has no screen, and a bad screen is refused when the case loads", () => {
  const raw = fdTest([unit(conv("one", [{ id: "m1", who: "Maya", text: "hi" }]), 0)], FRONT);
  assert.doesNotMatch(raw, /on screen:/);
  assert.equal(parseTest(raw).questions[0].screen, undefined);
  const bad = raw.replace("- kind: task", '- kind: task\n- on screen: {"note":{"workspace":"@maya","path":"/etc/passwd"}}');
  assert.throws(() => parseTest(bad), /on screen/);
});

const SETUP = "---\njob: texting-assistant\nmodels:\n  main: anthropic/claude-haiku-5-5\n---\n\nYou are a test assistant.\n";
const bench = {
  people: [{ person: "Maya", workspace: "maya", role: "owner", personal: true }],
  workspaces: { maya: { files: { "money/fund.md": "FUND-MARK 1,200 saved\n" }, heldBack: [] } },
};
const reply = (text) => new Response(JSON.stringify({ content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200, headers: { "Content-Type": "application/json" } });

// Sabotage: return `{}` from `appTurn` for a screen (no `chat: app:<user>`), or skip its TEX_CHAT, and the note is never read.
test("an in-app text runs as the app chat's turn and the front door is told the open note; a 1:1 text is not", async () => {
  const asked = [];
  const gatewayFetch = async (_url, init) => {
    asked.push(JSON.stringify(JSON.parse(init.body)));
    return reply("It says 1,200.");
  };
  const world = await createWorld(bench, "Maya", SETUP, { gatewayFetch });
  try {
    const app = await world.text("how much is saved here?", [], { screen: SCREEN });
    assert.ok(app.ok, app.error ?? "");
    assert.ok(asked.some((body) => body.includes("ON SCREEN IN THE APP") && body.includes("FUND-MARK")), "the open note reached the model");
    asked.length = 0;
    const one = await world.text("and now?");
    assert.ok(one.ok, one.error ?? "");
    assert.ok(!asked.some((body) => body.includes("ON SCREEN IN THE APP")), "a 1:1 text reads no screen");
  } finally {
    world.close();
  }
});
