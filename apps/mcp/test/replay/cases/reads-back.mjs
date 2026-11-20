import assert from "node:assert/strict";
import { oneToOne } from "../chats.mjs";
import { sixToolsOver } from "../../../../../packages/tex/gateway/agent/sixTools.js";
import { groupChatsTool, readsGroups } from "../../../../../packages/tex/gateway/agent/groupChats.js";
import { texStep } from "../../../../../packages/tex/gateway/agent/texConfig.js";
import { readDayTool, dayLine } from "../../../../../packages/tex/gateway/agent/weekHistory.js";
import { readThreadTool } from "../../../../../packages/tex/gateway/agent/conversationThreads.js";

export default {
  id: "reads-back",
  incident: "2026-11-12: a later turn told a group that a restaurant's private room \"wasn't on any page I read\", because the page an earlier turn had read was no longer in front of it; it mistook \"I can't see it now\" for \"it was never there\" (one record per chat, part 4). 2026-11-16: a job's part was shown the list of earlier reads and told \"read_back opens one\", but the six tools it was offered never showed read_back, and its advisor told it to read_back refs it had no tool for. 2026-11-17: the same for group_chats, read_day and read_thread: in a Lab test of a 1:1 reading its person's group chats, Tex said it had no group tool, and no live turn in two days had called read_day though every day summary named it.",
  cause: "A turn could not see or reopen what the chat had read before, only what its own stretch carried; then, the refs were listed to a turn whose offered tools could not open them; a local tool with no fetch id or action is never shown to the model.",
  path: "1:1 job part",
  async run() {
    const chat = await oneToOne();
    try {
      await chat.text("what does fifth say?", [{ toolCalls: [{ name: "read_note", args: { path: "2-areas/fifth.md" } }] }, { text: "Fifth is a short note." }]);
      let ref = null;
      let offersIt = false;
      const job = { id: "job-replay-00002", title: "Fifth summary", brief: "Write up what fifth says", attempt: 1, followUps: [] };
      const part = await chat.jobPart("write up what fifth says", job, [
        (body) => {
          ref = JSON.stringify(body).match(/- (r[A-Za-z0-9]{1,10}) · [^·]+ · read_note: 2-areas\/fifth\.md/)?.[1] ?? null;
          // The refs are shown only beside a tool that opens them: fetch lists read:<ref> among its ids.
          offersIt = (body.tools ?? []).some((tool) => /read:<ref> opens one of this chat's earlier reads/.test(JSON.stringify(tool)));
          return { toolCalls: [{ name: "fetch", args: { id: `read:${ref ?? "none"}` } }] };
        },
        { text: "Fifth is one heading." },
      ]);
      assert.ok(ref !== null, "the part is shown what the chat read before, with where it came from");
      assert.ok(offersIt, "and the tools it is offered open those refs");
      assert.match(part.shown, /# Fifth/, "and fetch read:<ref> opens it whole, as it was read");
      // Every chat reader is reached through the six, as read:<ref> is (2026-11-17).
      const group = groupChatsTool({ groups: [{ key: "e".repeat(64), name: "Book Club", people: ["mara"], lastSeenAt: 1 }], ledgerOf: () => null, log: () => {} }).tool;
      const notes = [{ name: "search_notes", description: "Search.", inputSchema: { type: "object" } }, { name: "read_note", description: "Read.", inputSchema: { type: "object" } }];
      const six = sixToolsOver([...notes, group, readDayTool({ ledger: null, chat: "c", log: () => {} }).tool, readThreadTool({ threads: [], render: () => "" }).tool]);
      const shown = six.tools.map((tool) => tool.description).join("\n");
      for (const way of [/groups:<chat>/, /groups: true/, /day:<YYYY-MM-DD>/, /thread:<id>/]) assert.match(shown, way, "the model is shown how to call each chat reader");
      assert.equal(six.resolve("search", { query: "picnic", args: { groups: true } }).name, "group_chats");
      // And a 1:1's front door reads them (promoted 2026-11-17): asked to sum up a group's week, Tex had no list of its groups.
      assert.equal(readsGroups(texStep("fd")), true, "the front door's ctx lists the person's group chats");
      assert.deepEqual(six.resolve("fetch", JSON.parse(dayLine("2026-11-09").match(/fetch (\{.*\})/)[1])), { name: "read_day", args: { day: "2026-11-09" } }, "a day summary's last line is a call it can make");
    } finally {
      chat.restore();
    }
  },
};
