/**
 * A PDF opened with open_page (`pdfPage`, `src/agent/browserProviders.js`).
 * A browser shows a PDF with no text, so a race's course map texted as a link
 * reached Tex as nothing (2026-10-17), and so would a payment page that is a
 * PDF. The screenshot Worker now hands the file on; this reads it.
 *
 * ## Sabotage record
 *
 * 1. **`readPage` returning the page without `pdfPage`** — "a PDF at an
 *    address is read for its words and its links" fails.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { siteShotsComputer } from "../src/agent/browserProviders.js";

const PDF = "%PDF-1.4\n1 0 obj << /Type /Annot /A << /S /URI /URI (https://pay.example/invoice/7) >> >> endobj\n%%EOF";
const b64 = Buffer.from(PDF, "latin1").toString("base64");

function binding(page) {
  return { fetch: async () => new Response(JSON.stringify({ page }), { status: 200, headers: { "content-type": "application/json" } }) };
}

test("a PDF at an address is read for its words and its links", async () => {
  const seen = [];
  const AI = {
    async toMarkdown(files) {
      seen.push(files[0].blob.type);
      return [{ format: "markdown", data: "Course map: four laps of the park." }];
    },
  };
  const page = { url: "https://race.example/maps/course%20map.pdf", title: "", text: "", truncated: false, links: [], via: "file", file: { type: "application/pdf", data: b64 } };
  const read = await siteShotsComputer({ SITE_SHOTS: binding(page), AI }).readPage(page.url);
  assert.deepEqual(seen, ["application/pdf"]);
  assert.match(read.text, /four laps of the park/);
  assert.match(read.text, /https:\/\/pay\.example\/invoice\/7/);
  assert.deepEqual(read.links, [{ text: "", href: "https://pay.example/invoice/7" }]);
  assert.equal(read.title, "course map.pdf");
  assert.equal(read.file, undefined, "the bytes never reach the model");
});

test("a PDF that cannot be read says so instead of looking empty", async () => {
  const page = { url: "https://race.example/a.pdf", title: "", text: "", truncated: false, links: [], via: "file", file: { type: "application/pdf", data: b64 } };
  const read = await siteShotsComputer({ SITE_SHOTS: binding(page) }).readPage(page.url);
  // No Workers AI: the words can't be read, but the links still are.
  assert.match(read.text, /This is a PDF, and reading files is not available/);
  assert.equal(read.links.length, 1);
});

test("an ordinary page is passed on as it came", async () => {
  const page = { url: "https://a.example/", title: "A", text: "Hello.", truncated: false, links: [], via: "html" };
  assert.deepEqual(await siteShotsComputer({ SITE_SHOTS: binding(page) }).readPage(page.url), page);
});
