import assert from "node:assert/strict";
import { weekView, weekStart } from "../../../../../packages/tex/gateway/agent/weekHistory.js";
import { ONE_TO_ONE_CHAT, eventEntry } from "../../../../../packages/tex/gateway/agent/ledger.js";
import { buildRows } from "../../../../../packages/tex/gateway/agent/appChatRows.js";

const ZONE = "America/New_York";
const NOW = Date.parse("2026-11-21T11:50:00Z");
const ASKED = NOW - 22 * 3_600_000;
const TURN = "turn-daniel";

export default {
  id: "lost-turn-not-revived",
  incident: "2026-11-21: in the app, \"What's the capital Argentina\" was answered beside a Daniel 6 ask from the day before, and a job started to redo notes a lost turn had already written; the card said \"Worked 80681s\".",
  cause: "The 11-20 turn wrote the note and was lost before its reply was recorded, so its text stayed in the queue and its work was in no history; Decide could not run in the app chat (sender app:<id>, looked up by phone), and the fallback joined both texts. The run card timed from the oldest text covered.",
  path: "1:1 text (app)",
  // Sabotage (2026-11-21): `lostReplies` returning [] and the history shows the ask with nothing done; `Math.min` back in
  // `runCards` and the card says the day. The Worker's leftover rule is proven in worker/inboxTurn.test.ts.
  async run() {
    const entries = [
      eventEntry({ id: `${NOW - 14_000}-000045`, at: NOW - 14_000, chat: ONE_TO_ONE_CHAT, from: { kind: "person", name: "Seyi", who: "h-seyi" }, kind: "text", text: "What's the capital Argentina" }),
      { v: 1, id: "r1", at: ASKED + 40_000, kind: "reply", turn: TURN, text: "Daniel 6 is saved in your Bible study folder.", clean: true },
      { v: 1, id: "t1", at: ASKED + 30_000, kind: "tool", turn: TURN, name: "write_note", ok: true },
      eventEntry({ id: `${ASKED}-000043`, at: ASKED, chat: ONE_TO_ONE_CHAT, from: { kind: "person", name: "Seyi", who: "h-seyi" }, kind: "text", text: "Prepare daniel 6 notes" }),
    ];
    const view = weekView({ entries, chat: ONE_TO_ONE_CHAT, start: weekStart(NOW, ZONE), timeZone: ZONE, chars: 100_000 });
    assert.match(view.text, /Daniel 6 is saved/, "the lost turn's drafted answer is in the history");
    assert.match(view.text, /\(used: write_note\)/, "with what it did");
    assert.match(view.text, /its turn was lost before this was sent/);
    const person = (id, at, text) => ({ id, at, chat: "app:k7m2q9x4b8n3c6v1", from: { kind: "person", who: "f".repeat(64) }, kind: "text", text });
    const old = person("e0", ASKED, "Prepare daniel 6 notes");
    const asked = person("e1", NOW - 14_000, "What's the capital Argentina");
    const answer = { id: "t1", at: NOW, chat: asked.chat, from: { kind: "tex" }, kind: "text", text: "Buenos Aires", turn: "turn-1", covers: ["e0", "e1"] };
    const [, , tex] = buildRows([], { events: [old, asked, answer] }, NOW, {}, [{ kind: "thinking", turn: "turn-1", at: NOW - 12_000, text: "Buenos Aires" }]);
    assert.equal(tex.run.secs, 14, "Worked 14s, not the day");
  },
};
