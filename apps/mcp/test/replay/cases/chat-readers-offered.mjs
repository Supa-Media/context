import assert from "node:assert/strict";
import { sixToolsOver } from "../../../src/agent/sixTools.js";
import { groupChatsTool } from "../../../src/agent/groupChats.js";
import { readDayTool, dayLine } from "../../../src/agent/weekHistory.js";
import { readThreadTool } from "../../../src/agent/conversationThreads.js";

export default {
  id: "chat-readers-offered",
  incident:
    "2026-11-17: in a Lab test of a 1:1 that reads its person's group chats, asked to sum up a group's last week, Tex said it had no group tool and gave up; no live turn in two days had called read_day, though every day summary named it.",
  cause: "group_chats, read_day and read_thread were local tools the six tools never listed (no fetch id, no action), so the model was never shown a way to call them.",
  path: "1:1 text",
  async run() {
    const groups = [{ key: "e".repeat(64), name: "Book Club", people: ["mara"], lastSeenAt: 1 }];
    const group = groupChatsTool({ groups, ledgerOf: () => null, log: () => {} }).tool;
    const day = readDayTool({ ledger: null, chat: "c", log: () => {} }).tool;
    const thread = readThreadTool({ threads: [], render: () => "" }).tool;
    const base = [
      { name: "search_notes", description: "Search.", inputSchema: { type: "object" } },
      { name: "read_note", description: "Read.", inputSchema: { type: "object" } },
    ];
    const six = sixToolsOver([...base, group, day, thread]);
    const shown = six.tools.map((tool) => tool.description).join("\n");
    assert.match(shown, /groups:<chat>/, "the model is shown how to read a group chat");
    assert.match(shown, /groups: true/, "and how to search all of them");
    assert.match(shown, /day:<YYYY-MM-DD>/, "and how to open an earlier day of its own chat");
    assert.match(shown, /thread:<id>/, "and a conversation");
    assert.equal(six.resolve("fetch", { id: "groups:Book Club", args: { from: "2026-11-09", to: "2026-11-15" } }).name, "group_chats");
    assert.equal(six.resolve("search", { query: "picnic", args: { groups: true } }).name, "group_chats");
    // The summary's last line names a call the model can make.
    const named = JSON.parse(dayLine("2026-11-09").match(/fetch (\{.*\})/)[1]);
    assert.deepEqual(six.resolve("fetch", named), { name: "read_day", args: { day: "2026-11-09" } });
  },
};
