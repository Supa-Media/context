import assert from "node:assert/strict";
import { oneToOne } from "../chats.mjs";

export default {
  id: "record-read-local",
  incident:
    "2026-11-17: a front-door turn answered what a note said by reopening an earlier read with read_back, and was sent back as if it had read nothing this turn.",
  cause:
    "read_back is a local tool. The record check only saw calls that went through callTool, so a turn that reopened a kept read was told it had not read the record.",
  path: "1:1 text",
  async run() {
    const chat = await oneToOne();
    try {
      await chat.text("what does fifth say?", [
        { toolCalls: [{ name: "read_note", args: { path: "2-areas/fifth.md" } }] },
        { text: "Fifth is a short note." },
      ]);
      let ref = null;
      const opened = await chat.text("what does the note say about the trip", [
        (body) => {
          ref = JSON.stringify(body).match(/- (r[A-Za-z0-9]{1,10}) · [^·]+ · read_note: 2-areas\/fifth\.md/)?.[1] ?? null;
          return { toolCalls: [{ name: "fetch", args: { id: `read:${ref ?? "none"}` } }] };
        },
        { text: "The note says Lisbon in October." },
        // Used only if that read is not counted: the false send-back then shows in what the model was shown.
        { text: "The note says Lisbon in October." },
      ]);
      assert.ok(ref !== null, "the earlier read is listed, so fetch read:<ref> can reopen it");
      assert.doesNotMatch(opened.shown, /have not read any of it this turn/, "reopening it with read_back is a read");
      assert.match(opened.answer, /Lisbon in October/, "the answer from that read goes out");
    } finally {
      chat.restore();
    }
  },
};
