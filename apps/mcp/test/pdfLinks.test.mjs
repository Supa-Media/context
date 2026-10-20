/**
 * Where a PDF's buttons go (`src/tools/pdfLinks.js`). A Lucky Strike contract
 * reached Tex as its words, "CLICK HERE to make payment", and never the
 * address behind the button (Dev, 2026-10-20).
 *
 * ## Sabotage record
 *
 * 1. **`fileWords` not calling `pdfLinks`** — "read_file hands back where a
 *    PDF's button goes" fails.
 * 2. **Compressed streams not inflated** — "a link inside a compressed object
 *    stream is found" fails.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { pdfLinks, MAX_LINKS } from "../src/tools/pdfLinks.js";
import { fileWords } from "../src/tools/readFile.js";

const ascii = (s) => new Uint8Array(Buffer.from(s, "latin1"));
const join = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

const PLAIN = ascii(
  "%PDF-1.4\n1 0 obj\n<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] /A << /S /URI /URI (https://pay.example.com/i/abc\\(1\\)) >> >>\nendobj\n" +
    "2 0 obj\n<< /Type /Annot /Subtype /Link /A << /S /URI /URI <68747470733A2F2F6578616D706C652E636F6D2F68> >> >>\nendobj\n" +
    "3 0 obj\n<< /A << /S /URI /URI (javascript:alert\\(1\\)) >> >>\nendobj\n%%EOF\n",
);

function compressed(uri) {
  const body = deflateSync(Buffer.from(`4 0 << /Type /Annot /Subtype /Link /A << /S /URI /URI (${uri}) >> >>`, "latin1"));
  return join(
    ascii(`%PDF-1.5\n5 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ${body.length} >>\nstream\n`),
    new Uint8Array(body),
    ascii("\nendstream\nendobj\n%%EOF\n"),
  );
}

test("a PDF's links are read from plain and hex strings, web and mail only", async () => {
  assert.deepEqual(await pdfLinks(PLAIN), ["https://pay.example.com/i/abc(1)", "https://example.com/h"]);
});

test("a link inside a compressed object stream is found", async () => {
  assert.deepEqual(await pdfLinks(compressed("https://pay.example.com/deposit")), ["https://pay.example.com/deposit"]);
});

test("a picture's stream is never inflated, and a broken file has no links", async () => {
  const image = join(ascii("%PDF-1.5\n6 0 obj\n<< /Subtype /Image /Filter /FlateDecode >>\nstream\n"), new Uint8Array(deflateSync(Buffer.from("/URI (https://hidden.example.com/)"))), ascii("\nendstream\n"));
  assert.deepEqual(await pdfLinks(image), []);
  assert.deepEqual(await pdfLinks(ascii("%PDF-1.5\n<< /Filter /FlateDecode >>\nstream\nnot deflate at all\nendstream\n")), []);
  const many = ascii(Array.from({ length: MAX_LINKS + 10 }, (_, i) => `<< /URI (https://e.example.com/${i}) >>`).join("\n"));
  assert.equal((await pdfLinks(many)).length, MAX_LINKS);
});

test("read_file hands back where a PDF's button goes, after its words", async () => {
  const ai = { async toMarkdown() { return [{ data: "CLICK HERE to make payment", format: "markdown" }]; } };
  const read = await fileWords(ai, "Kingdom City NYC.pdf", "application/pdf", compressed("https://pay.example.com/deposit"));
  assert.match(read.text, /^CLICK HERE to make payment\n\nLinks in this file \(where its buttons and linked words go\):\n- https:\/\/pay\.example\.com\/deposit$/);
  const sheet = await fileWords(ai, "a.csv", "text/csv", ascii("/URI (https://x.example.com/)"));
  assert.equal(sheet.text, "CLICK HERE to make payment");
});
