import assert from "node:assert/strict";
import { groupOf, groupPrompt, groupWriteTools } from "../../../../../packages/tex/gateway/agent/groupTurn.js";
import { GROUP_RUN_LINE } from "../../../../../packages/tex/gateway/agent/groupRunLine.js";
import { toolDefinitions } from "../../../src/tools/registry.js";

export default {
  id: "guest-chat-polls",
  incident:
    "2026-11-24 9:53 PM ET, Battle of the Bots (one person and two AI assistants with no account): \"each of u drop a poll\" got " +
    "\"I can't start a native poll, boss. I can post a numbered list and tally replies\", twice, the morning polls shipped.",
  cause:
    "A chat whose people don't all share a workspace got its own hand-written prompt (`guestPrompt`) and a shorter tool list, so the poll " +
    "line added to the group prompt never reached it; 14 capability lines differed between the two.",
  path: "group text",
  // Sabotage (2026-11-25): return any smaller prompt for `homeOnly` at the top of `groupPrompt`, or drop GROUP_RUN_LINE
  // behind a `homeOnly` check, and this fails.
  async run() {
    const base = groupOf({ group: { key: "c3".repeat(32), members: "d4".repeat(32), from: "shyoh", people: ["shyoh"], guests: ["guest-66ef", "guest-6ce3"] } });
    const chat = { ...base, homeOnly: true, home: { folder: "tex/groups/cactus-lotus-badge" } };
    const told = groupPrompt(chat, "context-lc");
    assert.ok(told.includes(GROUP_RUN_LINE), "a chat with guests is told it can start a real poll, like every group");
    assert.match(told, /You can't publish, share or change who sees anything from here/, "and keeps its privacy limits, said in words");
    const member = groupOf({ group: { key: "c3".repeat(32), members: "d4".repeat(32), from: "shyoh", people: ["shyoh", "seyi"], reach: ["supa"] } });
    const names = (group) => groupWriteTools(toolDefinitions(), group).map((tool) => tool.name).sort();
    assert.deepEqual(names(chat), names(member), "the same tools as a chat where everyone shares a workspace");
  },
};
