import assert from "node:assert/strict";
import { oneToOne } from "../chats.mjs";

export default {
  id: "cross-chat-answer",
  incident: "2026-11-17 (Dev2): a 1:1 Tex should ask a group's Tex for something and hear back, and the other way round (design N3ZawPjhhgYcNfHm7xWa37). Nothing had gone wrong yet; this case holds the shape the design promised.",
  cause: "An answer from another chat is a new run (the generators model), never a text from them, and an ask from another chat is answered back to that chat, never texted here.",
  path: "1:1 cross-chat ask and answer",
  async run() {
    const chat = await oneToOne();
    try {
      await chat.text("is the Lab demo still Friday? ask Tex Devs", "I asked Tex in Tex Devs; I'll tell you when it answers.");
      // Tex in the group answered; the Worker starts this chat's run by code with the answer.
      const back = await chat.byCode("is the Lab demo still Friday?", "Tex Devs says yes, Friday at 3 PM.", { event: "chat_answer", crossChat: { kind: "answer", id: "xabcdefghij0123", from: "Tex Devs", what: "is the Lab demo still Friday?", state: "answered", texts: ["Yes, Friday at 3 PM."] } });
      assert.match(back.shown, /Not a text from them\. Tex in Tex Devs answered the ask you sent it/, "the run is told the answer came from the other chat, not from them");
      assert.match(back.shown, /Friday at 3 PM/, "and is shown what it said");
      assert.equal(back.answer, "Tex Devs says yes, Friday at 3 PM.", "and tells them");
      // A group's Tex asks this 1:1 for something: the answer goes back, and nothing is texted here.
      const asked = await chat.byCode("which hotel did I book?", "The Hoxton, Williamsburg.", { event: "chat_ask", crossChat: { kind: "ask", id: "xbbbbbbbbbb", from: "a group chat they're in", what: "which hotel did I book?", do: false } });
      assert.match(asked.shown, /THIS RUN ANSWERS ANOTHER CHAT/, "the run knows its answer leaves this chat");
      assert.equal(asked.answer, "", "nothing is texted to them");
      assert.equal(asked.body.crossBack?.id, "xbbbbbbbbbb", "the answer goes back to the chat that asked");
      assert.deepEqual(asked.body.crossBack?.texts, ["The Hoxton, Williamsburg."]);
    } finally {
      chat.restore();
    }
  },
};
