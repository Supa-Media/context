import assert from "node:assert/strict";
import { groupChat } from "../chats.mjs";

export default {
  id: "group-setting-own-words",
  incident: "2026-11-18: in a group, Maya asked Tex for fewer emojis and reactions; the change was saved, and Tex pasted the tool's dictated line (\"Saved: maya set: ...\") where the answer she needed (\"got it, I'll hold back\") belonged.",
  cause: "The instructions tool's answer ordered Tex to say a sentence in these words, so the turn repeated it verbatim instead of giving the facts in its own short voice.",
  path: "group tag",
  async run() {
    const chat = await groupChat();
    // The control plane's command route (`texCommands.js`), answered here: done, with the line kept and who set it.
    const sent = [];
    const previous = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input?.url ?? "");
      if (url.endsWith("/gateway/tex/command")) {
        const { command } = JSON.parse(init.body);
        sent.push(command);
        return new Response(JSON.stringify({ status: "done", instructions: command.text ?? "", setBy: "maya" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return previous(input, init);
    };
    try {
      const turn = await chat.tag(
        "maya",
        "Tex fewer emojis and reactions please",
        [
          { toolCalls: [{ name: "tex_instructions_set", args: { action: "add", text: "Fewer emojis and reactions." } }] },
          // The judge's yes (`privacy/judge.js`): the words ask for the change, so the tool runs.
          { toolCalls: [{ name: "verdict", args: { allow: true, reason: "asks for fewer emojis from now on" } }] },
          { text: "Got it, I'll hold back on emojis and reactions." },
        ],
        [],
        { group: { people: ["maya"] } },
      );
      assert.deepEqual(sent.at(-1), { kind: "instructions", action: "add", text: "Fewer emojis and reactions." }, "the change is asked of the control plane");
      const followUp = turn.requests.at(-1);
      const results = (followUp?.messages ?? [])
        .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
        .filter((block) => block?.type === "tool_result")
        .map((block) => String(block.content ?? ""));
      assert.equal(results.length, 1, "the change's answer is handed back to the turn");
      assert.match(results[0], /Facts to tell the group in your own words, short, never pasted: maya changed how Tex talks here/, "the turn gets the facts");
      assert.match(results[0], /it now reads "Fewer emojis and reactions\."/, "and what the change now says");
      assert.match(results[0], /Anyone here can text "Tex, undo the change" to put it back\./, "and that anyone here can undo it");
      assert.doesNotMatch(results[0], /in these words|set: "/, "no sentence to paste");
      assert.match(turn.answer, /Got it, I'll hold back on emojis and reactions\./, "the answer is Tex's own");
      assert.doesNotMatch(turn.answer, /Saved|set:/, "and the dictated line is not repeated");
    } finally {
      globalThis.fetch = previous;
      chat.restore();
    }
  },
};
