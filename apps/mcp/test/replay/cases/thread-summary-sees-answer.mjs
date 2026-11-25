import assert from "node:assert/strict";
import { classifyText, threadsSortAndWrite } from "../../../../../packages/tex/gateway/agent/conversationThreads.js";
import { groupOf, groupPrompt } from "../../../../../packages/tex/gateway/agent/groupTurn.js";

export default {
  id: "thread-summary-sees-answer",
  incident:
    "2026-11-23 (a group chat where two other assistants tested Tex): one asked Tex three questions and Tex answered in three texts; " +
    "seconds later the other asked what the most recent message before theirs was, and Tex named the first assistant's question, leaving out its own three replies. " +
    "Asked in the same text whether it could reply threaded, it said no, while that very answer went threaded.",
  cause:
    "The conversation list the next turn reads said of that conversation \"Tex has not replied yet\": the classifier writes each summary after the reply goes, " +
    "but was handed only the person's text, never Tex's answer. Nothing told Tex its own texts count as the chat's messages, or that its answers thread.",
  path: "group text",
  // Sabotage (2026-11-24): drop `answer` from threadsMessage in conversationThreads.js, or call sort() with no answer in
  // threadsSortAndWrite, or take GROUP_SELF_LINE out of either group prompt, and this fails.
  async run() {
    const shown = [];
    const request = async (sent) => (shown.push(sent.messages[0].text), { text: '{"thread":"new","title":"Retest","description":"Tex answered all three.","finished":[]}' });
    const sort = (answer) => classifyText({ threads: [], lines: { byThread: new Map(), recent: [] }, question: "tex, quick retest: who asked us to test you?", replying: [], group: true, config: {}, request, answer }).then(() => []);
    await threadsSortAndWrite(sort, {}, {}, "Rae asked you both to test me, at 7:03 pm.");
    assert.match(shown[0], /TEX'S ANSWER\nRae asked you both to test me, at 7:03 pm\./, "the summary is written knowing what Tex said");
    const group = groupOf({ group: { key: "c3".repeat(32), members: "d4".repeat(32), from: "rae", people: ["rae", "lee"] } });
    for (const prompt of [groupPrompt(group, "acme"), groupPrompt({ from: "rae", people: ["rae"], home: { folder: "tex/chats/x" }, homeOnly: true }, "acme")]) {
      assert.match(prompt, /Your own texts are messages in this chat like anyone's/);
      assert.match(prompt, /goes under the text it answers, as an iMessage threaded reply/);
    }
  },
};
