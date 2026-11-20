import assert from "node:assert/strict";
import { oneToOne } from "../chats.mjs";
import { askGateNode } from "../../../../../packages/tex/gateway/agent/graph/nodes/askGate.js";

export default {
  id: "record-before-answer",
  incident:
    "2026-11-17: a turn answered what a note said without searching or fetching. The prompt already said to read the record first. The front door's check did not hold it. A check-in that mentions the chat is not that ask.",
  cause:
    "The front door's code check looked at an untried web and at figures. An ask to read a note, a page, mail or the calendar, with no read, went out.",
  path: "1:1 text",
  async run() {
    await askWithoutQuestionMark();
    const chat = await oneToOne();
    try {
      const unread = await chat.text("what does the note say about the trip", [
        { text: "The trip note says Lisbon in October." },
        { toolCalls: [{ name: "search", args: { query: "trip" } }] },
        { text: "The note says October 14 to 18." },
      ]);
      assert.match(unread.shown, /have not read any of it this turn/, "a note ask with no read is sent back");
      assert.match(unread.answer, /October 14 to 18/, "the rewrite answers after the read");
      const checkIn = await chat.text("(Time for this chat's check-in: look on your own at what is new. If nothing needs the chat, answer exactly SKIP.)", "SKIP");
      assert.equal(checkIn.answer, "SKIP", "a check-in that mentions the chat is not sent back for a read");
    } finally {
      chat.restore();
    }
  },
};

// 2026-11-20: on the lookup ladder's first live test text, the Front door asked the person for a fact Tex could look for
// ("Send me her address and tell me which sister it is") and the Before-asking step passed it unread, because it only
// read drafts with a question mark. An ask written as a request ("send me", "tell me", "let me know") is read too.
async function askWithoutQuestionMark() {
  const asked = [];
  const engine = async (state, questions) => (asked.push({ state, questions }), { kind: { choice: "fact", confidence: 0.9 } });
  const turn = { env: {}, question: "mail my sister her birthday card", drafts: { waiting: { draft: "I couldn't find it in your notes. Send me her address and I'll mail it." } } };
  const out = await askGateNode({ askChars: 32, draftChars: 72 }, { ctx: { turn }, use: {}, engine });
  assert.equal(asked.length, 1, "the gate's model reads an ask with no question mark");
  assert.notEqual(out.to, "pass", "and a fact to find is not let through unread");
  const done = await askGateNode({ ask: "mail it", draft: "Sent the card to Ana." }, { ctx: { turn: { env: {} } }, use: {}, engine });
  assert.equal(done.to, "pass", "a draft that asks nothing still passes with no model");
  assert.equal(asked.length, 1);
}
