import assert from "node:assert/strict";
import { groupChat } from "../chats.mjs";

const GROUP_ID = "11111111-2222-3333-4444-555555555555";

export default {
  id: "group-bubbles-under",
  incident: "2026-11-17, Battle of the Bots: \"tex, say alpha\" and \"tex, say bravo\" were answered in one turn, and both bubbles, \"alpha\" included, were threaded under \"say bravo\".",
  cause: "A turn answering several texts kept only the newest one's message id (`mergedGroup`), and the Worker threaded every bubble under it: nothing said which text each bubble answered.",
  path: "group tag",
  async run() {
    const chat = await groupChat();
    try {
      const now = Date.now();
      const alpha = { id: `${now - 2_000}-000001`, at: now - 2_000, chat: GROUP_ID, from: { kind: "person", name: "ada" }, kind: "text", text: "tex, say alpha" };
      const bravo = { id: `${now - 1_000}-000002`, at: now - 1_000, chat: GROUP_ID, from: { kind: "person", name: "ada" }, kind: "text", text: "tex, say bravo" };
      const body = { covers: [alpha.id, bravo.id], chat: GROUP_ID, recent: [alpha, bravo] };
      const both = await chat.tag("ada", "tex, say alpha\ntex, say bravo", "[1] alpha\n\n[2] bravo", [], { group: { people: ["ada"], cause: "named" }, body });
      assert.match(both.shown, /\[1\] @ada: tex, say alpha/, "the turn is shown the texts it answers, numbered");
      assert.match(both.shown, /\[2\] @ada: tex, say bravo/);
      // Lab, 2026-11-18: told "one reply that answers them all together needs no numbers", the front door answered
      // "say charlie" and "say delta" as one bubble. Texts that ask different things are each answered on their own.
      assert.match(both.shown, /When the texts ask different things, answer each in its own paragraph/, "different asks are answered apart");
      assert.equal(both.answer, "alpha\n\nbravo", "no number reaches the chat");
      assert.deepEqual(both.body.under, [{ under: alpha.id, text: "alpha" }, { under: bravo.id, text: "bravo" }], "each part names the text it goes under");
      // One text: no numbers shown, nothing to place.
      const one = await chat.tag("ada", "tex, say charlie", "charlie", [], { group: { people: ["ada"], cause: "named" }, body: { covers: [bravo.id], chat: GROUP_ID, recent: [bravo] } });
      assert.doesNotMatch(one.shown, /answers 2 texts at once/);
      assert.equal(one.body.under, undefined);
    } finally {
      chat.restore();
    }
  },
};
