import assert from "node:assert/strict";
import { groupChat } from "../chats.mjs";

export default {
  id: "group-mute-said-by-code",
  incident: "2026-11-19: a group chat had been muted for a week without anyone knowing; a turn had called chat_mute on \"Tex stop talking, forever\", the reviewer sent its \"text Tex, start\" line back, and later asks there were dropped in silence.",
  cause: "Whether the chat heard it was muted rode on the turn's own words, which a reviewer or the model could drop; nothing told the Worker the chat had been muted.",
  path: "group tag",
  // Sabotage (2026-11-20): drop the `onMute()` call in commandTools.js, or the `muted` field in sendTheReply.js, and
  // the reply carries no flag; the Worker's half (`groupMuteTold.test.ts`) then never says GROUP_LINES.stopped.
  async run() {
    const chat = await groupChat();
    const previous = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input?.url ?? "");
      if (url.endsWith("/gateway/tex/command")) return new Response(JSON.stringify({ status: "done" }), { status: 200, headers: { "Content-Type": "application/json" } });
      return previous(input, init);
    };
    try {
      const turn = await chat.tag(
        "maya",
        "Tex please stop talking in here, forever",
        [{ toolCalls: [{ name: "chat_mute", args: {} }] }, { toolCalls: [{ name: "send", args: { action: "say_nothing", args: { why: "muted" } } }] }],
        [],
        { group: { people: ["maya"] } },
      );
      assert.equal(turn.body.muted, true, "the reply tells the Worker the chat was muted, whatever the turn says");
      const plain = await chat.tag("maya", "Tex what's 2+2", [{ text: "4." }], [], { group: { people: ["maya"] } });
      assert.equal(plain.body.muted, undefined, "a turn that mutes nothing carries no flag");
    } finally {
      globalThis.fetch = previous;
      chat.restore();
    }
  },
};
