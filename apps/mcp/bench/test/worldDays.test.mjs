/**
 * The bench's day summaries reach the chat's ledger: a chat that spans weeks gets one `day` entry for each day past the
 * Front door's word-for-word window, as production's nightly summary leaves them (`benchDays.mjs`, `worldChat.mjs`).
 * Split from `world.test.mjs`, which is at its size threshold.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createWorld } from "../world.mjs";

const SETUP = "---\njob: texting-assistant\nmodels:\n  main: anthropic/claude-haiku-5-5\n---\n\nYou are a test assistant.\n";

const bench = {
  people: [{ person: "Maya", workspace: "maya", role: "owner", personal: true }],
  workspaces: { maya: { files: { "todo.md": "- nothing\n" }, heldBack: [] } },
};

// A chat that spans weeks: its days past the word-for-word window get one `day` entry each, as production's nightly
// summary leaves them (`benchDays.mjs`). Sabotage: drop the day summaries from `worldChat.earlier`, and no `day`
// entry is written for the twenty-day-old line.
test("a line twenty days back is kept as a day entry, and a line inside the window is not", async () => {
  const gatewayFetch = async () => new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "Content-Type": "application/json" } });
  const world = await createWorld(bench, "Maya", SETUP, { gatewayFetch, ledgerTurns: true });
  try {
    await world.earlier([{ from: "person", text: "the first ask", minutesBefore: 20 * 24 * 60 }, { from: "tex", text: "On it.", minutesBefore: 20 * 24 * 60 - 1 }, { from: "person", text: "and now?", minutesBefore: 60 }]);
    const days = (await world.ledgerEntries()).filter((e) => e.kind === "day");
    assert.equal(days.length, 1, JSON.stringify(days));
    const [day] = days;
    const twenty = new Date(Date.now() - 20 * 24 * 3_600_000).toISOString().slice(0, 10);
    assert.ok(day.day === twenty || day.day === new Date(Date.parse(`${twenty}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10), `day ${day.day}`);
    assert.equal(day.model, "bench");
    assert.match(day.text, /They texted: "the first ask"\. You answered: "On it\."/);
  } finally {
    world.close();
  }
});

// A routine that ran weeks back is a sentence of its day, not dropped: its trigger goes into the day's summary.
// Sabotage: drop the trigger push in `worldChat.mjs` `keepTriggerThen`, and no sentence names the routine.
test("a routine that ran twenty days back is named in its day entry", async () => {
  const gatewayFetch = async () => new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "Content-Type": "application/json" } });
  const world = await createWorld(bench, "Maya", SETUP, { gatewayFetch, ledgerTurns: true });
  try {
    await world.earlier([{ from: "trigger", via: "routine", text: "Loose ends", minutesBefore: 20 * 24 * 60 }]);
    const days = (await world.ledgerEntries()).filter((e) => e.kind === "day");
    assert.equal(days.length, 1, JSON.stringify(days));
    assert.match(days[0].text, /^A routine ran: "Loose ends"\.$/);
  } finally {
    world.close();
  }
});
