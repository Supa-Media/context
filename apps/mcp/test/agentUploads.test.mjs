/**
 * TEX ATTACHES THE PERSON'S OWN FILES (`src/agent/uploads.js`, the `upload`
 * step in `src/agent/browse.js`). Dev, 2026-10-20: "why can't you attach the
 * receipt yourself?", after Tex said its browser could not use the file picker.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted (2026-10-20).
 *
 *  1. `fromNotes` skipping the `read_file` read as the person.
 *     → "a file the person cannot see is not found, and its bytes are never read" fails.
 *  2. The upload step planned with no `onlyOn` when the web is not open.
 *     → "off the open web, a file goes only to a site the person named, re-checked by the browser" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveUpload, uploadName, printedEmail } from "../src/agent/uploads.js";
import { browserSession } from "../src/agent/browse.js";
import { wrap } from "../src/agent/textPdf.js";

const PDF = "%PDF-1.4 receipt";
const b64 = (text) => Buffer.from(text, "latin1").toString("base64");
const words = (file) => Buffer.from(file.data, "base64").toString("latin1");

function deps({ visible = ["files/receipt.pdf"], picture = null } = {}) {
  const reads = [];
  const store = {
    reads,
    async get(key) {
      reads.push(key);
      return key === "files/receipt.pdf" ? { size: PDF.length, arrayBuffer: async () => Buffer.from(PDF, "latin1") } : null;
    },
    email: {
      async read(address, id, options) {
        if (id === "gone") return { ok: false, refused: "not_found" };
        if (options?.attachment) return { ok: true, message: {}, attachment: { filename: "Receipt #7.pdf", data: b64(PDF) } };
        return { ok: true, message: { from: "Church Center <no-reply@example.com>", to: "dev@example.com", date: "Oct 9", subject: "Registration Confirmation: Creative", body: "Paid $45.00" } };
      },
    },
  };
  const dispatch = async (name, args) => {
    if (name === "read_file") {
      return visible.includes(args.path) ? { content: [{ type: "text", text: "words" }] } : { content: [{ type: "text", text: "not found" }], isError: true };
    }
    if (name === "read_image") {
      return picture && args.note === picture.note && args.image === picture.image
        ? { content: [{ type: "image", data: b64("PNGDATA"), mimeType: "image/png" }] }
        : { content: [{ type: "text", text: "not found" }], isError: true };
    }
    throw new Error(`unexpected ${name}`);
  };
  return { dispatch, store };
}

test("a file in their notes is attached as it is stored", async () => {
  const { file } = await resolveUpload({ file: "files/receipt.pdf" }, deps());
  assert.deepEqual({ ...file, data: words(file) }, { name: "receipt.pdf", type: "application/pdf", data: PDF });
});

test("a file the person cannot see is not found, and its bytes are never read", async () => {
  const d = deps({ visible: [] });
  assert.deepEqual(await resolveUpload({ file: "files/receipt.pdf" }, d), { error: "not found" });
  assert.deepEqual(d.store.reads, []);
  assert.match((await resolveUpload({ file: "@band/files/receipt.pdf" }, d)).error, /their own workspace/);
});

test("an email's attachment, or the email itself printed to a PDF", async () => {
  const attached = await resolveUpload({ file: "email:dev@example.com/abc123", attachment: 1 }, deps());
  assert.equal(attached.file.name, "Receipt #7.pdf");
  assert.equal(words(attached.file), PDF);

  const printed = await resolveUpload({ file: "email:dev@example.com/abc123" }, deps());
  assert.equal(printed.file.type, "application/pdf");
  assert.equal(printed.file.name, "Registration Confirmation Creative.pdf");
  const pdf = words(printed.file);
  assert.ok(pdf.startsWith("%PDF-1.4"));
  assert.match(pdf, /\(From: Church Center <no-reply@example.com>\) Tj/);
  assert.match(pdf, /\(Paid \$45.00\) Tj/);

  assert.match((await resolveUpload({ file: "email:dev@example.com/gone" }, deps())).error, /no longer has/);
  assert.match((await resolveUpload({ file: "email:dev@example.com/abc123" }, { ...deps(), store: {} })).error, /cannot read the person's email/);
});

test("a picture they texted, by its note and name", async () => {
  const d = deps({ picture: { note: "tex/transcripts/2026-10-20.md", image: "upload-1a.png" } });
  const { file } = await resolveUpload({ file: "upload-1a.png", note: "tex/transcripts/2026-10-20.md" }, d);
  assert.deepEqual({ ...file, data: words(file) }, { name: "upload-1a.png", type: "image/png", data: "PNGDATA" });
  assert.match((await resolveUpload({ file: "upload-1a.png", note: "other.md" }, d)).error, /not found/);
});

test("names a page is shown are a file's last part, and a PDF's lines wrap", () => {
  assert.equal(uploadName("../../etc/passwd"), "passwd");
  assert.equal(uploadName("a\u0000b.pdf"), "ab.pdf");
  assert.equal(uploadName(""), "file");
  assert.ok(wrap("word ".repeat(60)).every((line) => line.length <= 95));
  assert.match(printedEmail({ subject: "Hi", body: "x" }), /^From: \nTo: \nDate: \nSubject: Hi\n\nx$/);
});

function fakeComputer(url = "https://chapteros.example/expenses/new") {
  const calls = [];
  return {
    calls,
    async browse(session, steps) {
      calls.push(steps);
      return { session: "sess-upload-0001", ran: steps.map((step) => ({ do: step.do, ok: true })), page: { url, title: "", text: "", truncated: false, elements: [], uploads: 1 } };
    },
  };
}

function session(computer, { addresses, openWeb = false, files = async () => ({ file: { name: "r.pdf", type: "application/pdf", data: b64(PDF) } }) } = {}) {
  const allowed = new Set(["https://chapteros.example/expenses/new"]);
  allowed.webIsOpen = () => openWeb;
  return browserSession(computer, { allowed, addresses, takePages: () => true, files });
}

test("off the open web, a file goes only to a site the person named, re-checked by the browser", async () => {
  const computer = fakeComputer();
  const named = session(computer, { addresses: "attach my receipt on chapteros.example" });
  const done = await named.call({ steps: [{ do: "goto", url: "https://chapteros.example/expenses/new" }, { do: "upload", file: "files/receipt.pdf" }] });
  assert.ok(!done.isError);
  const step = computer.calls[0][1];
  assert.equal(step.do, "upload");
  assert.deepEqual(step.onlyOn, ["chapteros.example"]);
  assert.equal(step.file.name, "r.pdf");
  assert.match(done.content[0].text, /This page takes a file \(one upload box\)/);

  const unnamed = session(fakeComputer(), { addresses: "attach my receipt" });
  const refused = await unnamed.call({ steps: [{ do: "goto", url: "https://chapteros.example/expenses/new" }, { do: "upload", file: "files/receipt.pdf" }] });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /site they named/);
});

test("on the open web a file may go to the page, and a file that can't be read is said so", async () => {
  const computer = fakeComputer();
  const open = session(computer, { addresses: "attach it", openWeb: true });
  await open.call({ steps: [{ do: "goto", url: "https://chapteros.example/expenses/new" }, { do: "upload", ref: "[4]", file: "files/receipt.pdf" }] });
  assert.equal(computer.calls[0][1].onlyOn, undefined);
  assert.equal(computer.calls[0][1].ref, 4);

  const missing = session(fakeComputer(), { addresses: "attach it", openWeb: true, files: async () => ({ error: "not found" }) });
  const said = await missing.call({ steps: [{ do: "goto", url: "https://chapteros.example/expenses/new" }, { do: "upload", file: "x.pdf" }] });
  assert.equal(said.isError, true);
  assert.equal(said.content[0].text, "Not attached: not found.");

  const none = browserSession(fakeComputer(), { allowed: Object.assign(new Set(), { webIsOpen: () => true }), addresses: "", takePages: () => true });
  assert.doesNotMatch(none.definition.description, /upload step/);
  assert.match(session(fakeComputer(), { addresses: "" }).definition.description, /upload step/);
});
