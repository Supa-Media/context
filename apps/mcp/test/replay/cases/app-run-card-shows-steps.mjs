import assert from "node:assert/strict";
import { buildRows } from "../../../../../packages/tex/gateway/agent/appChatRows.js";
import { withLive } from "../../../../../packages/tex/gateway/agent/liveSteps.js";
import { appRunKeeper, APP_RUN_KEY } from "../../../../../packages/tex/worker/appRun.ts";

const CHAT = "app:k7m2q9x4b8n3c6v1";

function storage() {
  const map = new Map();
  return { map, get: async (key) => map.get(key), put: async (key, value) => void map.set(key, structuredClone(value)), delete: async (key) => map.delete(key), list: async () => new Map() };
}

export default {
  id: "app-run-card-shows-steps",
  incident: "2026-11-20: in the app, a 41-second turn showed only three dots; Dev2 could not tell a slow answer from a stuck one (the in-app Tex review, gap 3).",
  cause: "The turn's thinking and tool calls went only to its ledger; nothing carried them to the app while it ran, and the finished answer showed none of what it did.",
  path: "1:1 text (app)",
  // Sabotage (2026-11-20): make `withLive` return the turn's observer alone and no step reaches the card; drop `runCards`
  // in appChatRows.js and the answered turn has no "Worked Ns" card.
  async run() {
    const chat = storage();
    const keeper = appRunKeeper(chat, "turn-1", ["e1"], 1_000);
    const ledger = [];
    const observe = withLive(keeper.onLive, true, (event) => ledger.push(event));
    observe({ kind: "thinking", text: "They want the chapter 6 notes, like chapter 5's" });
    observe({ kind: "tool", name: "read_note", args: { path: "areas/bible-study/daniel-5.md" }, ok: true, ms: 90, result: "# Daniel 5" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const live = await chat.get(APP_RUN_KEY);
    assert.equal(live.steps.length, 2, "the app sees both steps while the turn runs");
    assert.equal(live.steps[1].what, "areas/bible-study/daniel-5.md");
    assert.equal(ledger.length, 2, "the ledger still gets every event");
    await keeper.end();
    assert.equal(await chat.get(APP_RUN_KEY), undefined, "gone once the turn ends");
    const asked = { id: "e1", at: 0, chat: CHAT, from: { kind: "person", who: "f".repeat(64) }, kind: "text", text: "notes on Daniel 6" };
    const answer = { id: "t1", at: 41_000, chat: CHAT, from: { kind: "tex" }, kind: "text", text: "Done", turn: "turn-1", covers: ["e1"] };
    const steps = ledger.map((event, i) => ({ ...event, turn: "turn-1", at: 1_000 + i * 2_000 }));
    const [, tex] = buildRows([], { events: [asked, answer] }, 41_000, {}, steps);
    assert.equal(tex.run.secs, 41, "Worked 41s");
    assert.equal(tex.run.steps.length, 2);
  },
};
