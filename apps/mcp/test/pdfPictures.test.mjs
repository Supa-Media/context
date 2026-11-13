/**
 * A PDF OF PICTURES IS READ AS PICTURES (review 65b381, 2026-11-13; Dev2 chose
 * option A).
 *
 * A planner's deck (a Canva export, every page a picture) was texted to a
 * group. On that turn the PDF went to the model whole and Tex quoted the
 * packages' prices from its pages. On the next text read_file turned the kept
 * file into words, got nine empty pages, and Tex took back prices that were
 * right. Now a PDF that gives up no words comes back from read_file whole,
 * the model reads it as a document, and the saved line for a PDF sent with a
 * text says it was read page by page on that turn.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *   `pdfHasNoWords` always false → "a kept PDF of pictures comes back whole"
 *     fails (no resource part).
 *   `toolResultImages` ignoring resources → "a PDF handed back reaches the
 *     model as a document" fails.
 *   `anthropicMessages` sending every part as an image → the same check fails
 *     (an image block for application/pdf).
 *   the provenance sentence left out of `attachmentsLine` → "the saved line
 *     for a PDF says its pages were read" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { attachmentsLine } from "../src/agent/attachments.js";
import { keepSentFiles, keptRef, readKeptFile } from "../src/agent/keptFiles.js";
import { anthropicMessages } from "../src/agent/providers.js";
import { toolResultImages } from "../src/agent/toolResults.js";
import { PICTURE_PAGES, PICTURE_PAGES_UNSEEN, pdfHasNoWords, wordsWithoutPages } from "../src/tools/readFile.js";

/** What Workers AI's toMarkdown gives back for a PDF with no text layer: a title, metadata and empty pages. */
const PICTURE_DECK = [
  "# deck.pdf",
  "## Metadata",
  "- PDFFormatVersion=1.4",
  "- Creator=Canva",
  "- Title=Events Guide",
  "",
  "## Contents",
  ...Array.from({ length: 9 }, (_, n) => `### Page ${n + 1}\n\n\n`),
].join("\n");

const WORDY_DECK = [
  "# menu.pdf",
  "## Metadata",
  "- Creator=Word",
  "",
  "## Contents",
  "### Page 1",
  "Par package: a round of golf, chips and dip and three shareable plates, per person before tax.",
  "### Page 2",
  "Beer and wine bar for two hours, per person, with a minimum spend on Saturday evenings.",
].join("\n");

function memoryStore() {
  const objects = new Map();
  return {
    async put(key, value) {
      objects.set(key, String(value));
    },
    async get(key) {
      const body = objects.get(key);
      return body === undefined ? null : { text: async () => body };
    },
    async list({ prefix }) {
      return { objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })), truncated: false };
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

const fakeAi = (markdown) => ({ toMarkdown: async ([file]) => [{ name: file.name, format: "markdown", data: markdown }] });
const PDF_BYTES = Buffer.from("%PDF-1.4\n% a deck of pictures\n").toString("base64");
const textOf = (result) => result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");

test("a PDF's title, metadata and empty page headings are not words", () => {
  assert.equal(pdfHasNoWords(PICTURE_DECK), true);
  assert.equal(pdfHasNoWords(""), true);
  assert.equal(pdfHasNoWords(WORDY_DECK), false);
});

test("a kept PDF of pictures comes back whole, beside words that say so", async () => {
  const store = memoryStore();
  const [kept] = await keepSentFiles(store, [{ name: "deck.pdf", mediaType: "application/pdf", data: PDF_BYTES }]);
  const read = await readKeptFile(store, fakeAi(PICTURE_DECK), keptRef(kept.kept.id));
  assert.equal(read.isError, undefined, textOf(read));
  assert.match(textOf(read), new RegExp(PICTURE_PAGES.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const resource = read.content.find((part) => part.type === "resource");
  assert.equal(resource?.resource.mimeType, "application/pdf");
  assert.equal(resource.resource.blob, PDF_BYTES);
  assert.equal(resource.resource.uri, kept.kept.id);
});

test("a PDF of pictures past the document page limit is not handed on", async () => {
  const store = memoryStore();
  const [kept] = await keepSentFiles(store, [{ name: "scan.pdf", mediaType: "application/pdf", data: PDF_BYTES }]);
  const book = ["## Contents", ...Array.from({ length: 101 }, (_, n) => `### Page ${n + 1}\n`)].join("\n");
  const read = await readKeptFile(store, fakeAi(book), keptRef(kept.kept.id));
  assert.equal(read.content.some((part) => part.type === "resource"), false);
});

test("a kept PDF with words comes back as words only", async () => {
  const store = memoryStore();
  const [kept] = await keepSentFiles(store, [{ name: "menu.pdf", mediaType: "application/pdf", data: PDF_BYTES }]);
  const read = await readKeptFile(store, fakeAi(WORDY_DECK), keptRef(kept.kept.id));
  assert.match(textOf(read), /Par package/);
  assert.equal(read.content.some((part) => part.type === "resource"), false);
});

test("a PDF handed back reaches the model as a document, beside the words", () => {
  const result = { content: [{ type: "text", text: PICTURE_PAGES }, { type: "resource", resource: { uri: "download:x", mimeType: "application/pdf", blob: PDF_BYTES } }] };
  const images = toolResultImages(result);
  assert.deepEqual(images, [{ mediaType: "application/pdf", data: PDF_BYTES }]);
  const wire = anthropicMessages([{ role: "tool", id: "toolu_1", name: "read_file", text: PICTURE_PAGES, images }]);
  const block = wire[0].content[0];
  assert.equal(block.type, "tool_result");
  assert.deepEqual(block.content[1], { type: "document", source: { type: "base64", media_type: "application/pdf", data: PDF_BYTES } });
  // A picture stays a picture.
  const picture = anthropicMessages([{ role: "tool", id: "toolu_2", name: "read_image", text: "a photo", images: [{ mediaType: "image/png", data: "iVBORw0KGgo=" }] }]);
  assert.equal(picture[0].content[0].content[1].type, "image");
});

test("a resource that is not a PDF, or too big, is not handed to the model", () => {
  assert.deepEqual(toolResultImages({ content: [{ type: "resource", resource: { uri: "x", mimeType: "text/html", blob: "PGh0bWw+" } }] }), []);
  const huge = "A".repeat(Math.ceil((10 * 1024 * 1024 * 4) / 3) + 4);
  assert.deepEqual(toolResultImages({ content: [{ type: "resource", resource: { uri: "x", mimeType: "application/pdf", blob: huge } }] }), []);
});

test("a caller that can't hand the file on never says it is shown", () => {
  assert.equal(wordsWithoutPages({ text: PICTURE_PAGES, pages: true }), PICTURE_PAGES_UNSEEN);
  assert.equal(wordsWithoutPages({ text: "words" }), "words");
});

test("the saved line for a PDF says its pages were read on that turn", () => {
  const pdf = attachmentsLine([{ name: "deck.pdf", mediaType: "application/pdf", data: PDF_BYTES, kept: { id: "download:1794590661339-s-" + "a".repeat(32) } }]);
  assert.match(pdf, /shown to you whole on that turn, its pages as pictures, so what you said about it then came from its pages/);
  const csv = attachmentsLine([{ name: "t.csv", mediaType: "text/csv", text: "a,b", kept: { id: "download:1794590661339-l-" + "b".repeat(32) } }]);
  assert.doesNotMatch(csv, /its pages as pictures/);
});
