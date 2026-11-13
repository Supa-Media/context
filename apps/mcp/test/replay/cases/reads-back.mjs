import assert from "node:assert/strict";
import { oneToOne } from "../chats.mjs";

export default {
  id: "reads-back",
  incident: "2026-11-12: a later turn told a group that a restaurant's private room \"wasn't on any page I read\", because the page an earlier turn had read was no longer in front of it; it mistook \"I can't see it now\" for \"it was never there\" (one record per chat, part 4).",
  cause: "A turn could not see or reopen what the chat had read before, only what its own stretch carried.",
  path: "1:1 job part",
  async run() {
    const chat = await oneToOne();
    try {
      await chat.text("what does fifth say?", [{ toolCalls: [{ name: "read_note", args: { path: "2-areas/fifth.md" } }] }, { text: "Fifth is a short note." }]);
      let ref = null;
      const job = { id: "job-replay-00002", title: "Fifth summary", brief: "Write up what fifth says", attempt: 1, followUps: [] };
      const part = await chat.jobPart("write up what fifth says", job, [
        (body) => {
          ref = JSON.stringify(body).match(/- (r[A-Za-z0-9]{1,10}) · [^·]+ · read_note: 2-areas\/fifth\.md/)?.[1] ?? null;
          return { toolCalls: [{ name: "read_back", args: { ref: ref ?? "none" } }] };
        },
        { text: "Fifth is one heading." },
      ]);
      assert.ok(ref !== null, "the part is shown what the chat read before, with where it came from");
      assert.match(part.shown, /# Fifth/, "and read_back opens it whole, as it was read");
    } finally {
      chat.restore();
    }
  },
};
