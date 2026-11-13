import assert from "node:assert/strict";
import { oneToOne } from "../chats.mjs";

/** A deck past what a later text carries again (`CARRY_PDF_BYTES`), so the next text must read it with read_file. */
const DECK = Buffer.concat([Buffer.from("%PDF-1.4\n% an events deck, every page a picture\n"), Buffer.alloc(3 * 1024 * 1024 + 4096, 0x20)]).toString("base64");
/** Workers AI's words for a PDF with no text layer: a title, metadata and empty pages. */
const NO_WORDS = ["# deck.pdf", "## Metadata", "- Creator=Canva", "", "## Contents", ...Array.from({ length: 9 }, (_, n) => `### Page ${n + 1}\n\n`)].join("\n");

const KEPT = /download:\d{13}-[sl]-[a-f0-9]{32}/;

export default {
  id: "pdf-of-pictures",
  incident:
    "2026-11-13 (review 65b381): a group planning an outing sent a venue's events deck, a PDF whose pages are all pictures. Tex read the prices off its pages on that text, then on the next one read_file found no words in it and Tex took the right prices back.",
  cause: "read_file turned a PDF into words only, so a PDF of pictures came back empty, and nothing said the earlier reply had read its pages.",
  path: "1:1 text",
  async run() {
    const chat = await oneToOne();
    const restoreAi = chat.world.env.AI;
    chat.world.env.AI = { run: async () => ({}), toMarkdown: async ([file]) => [{ name: file.name, format: "markdown", data: NO_WORDS }] };
    try {
      const first = await chat.text("what are the group packages in this deck?", "The Birdie package is $48 a person.", {
        attachments: [{ name: "events-deck.pdf", mediaType: "application/pdf", data: DECK }],
      });
      assert.match(first.shown, /"type":"document"/, "the turn it came with is shown the PDF whole");
      // The kept file's id, as the saved conversation names it (`attachmentsLine`).
      const key = [...chat.world.bucket.keys()].find((name) => name.startsWith(".context/agent/downloads/"));
      assert.ok(key, "the deck is kept for later texts");
      const id = `download:${key.slice(".context/agent/downloads/".length).replace(/\.json$/, "")}`;
      assert.match(id, KEPT);
      const second = await chat.text("are the shared plates unlimited?", [
        { toolCalls: [{ name: "fetch", args: { id } }] },
        { text: "Three shared plates, not unlimited." },
      ]);
      const reread = second.shown.split("\n").at(-1);
      assert.match(reread, /This PDF's pages are pictures with no words in them/, "read_file says the pages are pictures");
      assert.match(reread, /"type":"tool_result"[^]*"type":"document","source":\{"type":"base64","media_type":"application\/pdf"/, "and hands the PDF back whole, as a document the model reads");
    } finally {
      chat.world.env.AI = restoreAi;
      chat.restore();
    }
  },
};
