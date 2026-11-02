/**
 * A PICTURE THEY TEXTED GOES ON THE EMAIL THROUGH GMAIL ITSELF
 * (`src/agent/emailFiles.js`, `attachedWords` in `src/tools/email.js`).
 *
 * From a review of a chat, 2026-10-27: asked for a Gmail draft to a support
 * team "with the example image attached", Tex used Gmail's web uploader,
 * claimed "the screenshot attached" (the wrong one), then said every upload
 * came through empty and told the person to tap the paperclip.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted (2026-10-27).
 *
 *  1. `withEmailFiles` reading the picture with the store directly instead of
 *     the wrapped `callTool`. → "a picture an earlier text sent is read as the
 *     person, then attached by its kept id" fails.
 *  2. `attachedWords` trusting the call instead of Gmail's count.
 *     → "only Gmail's own answer lets Tex say attached" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { attachSource, withEmailFiles } from "../src/agent/emailFiles.js";
import { readDownload } from "../src/agent/downloads.js";
import { attachedWords, toolSaveEmailDraft } from "../src/tools/email.js";

const b64 = (text) => Buffer.from(text, "latin1").toString("base64");

function memoryStore() {
  const objects = new Map();
  return {
    objects,
    async put(key, value) {
      objects.set(key, value);
    },
    async get(key) {
      const value = objects.get(key);
      return value === undefined ? null : { text: async () => value };
    },
    async list() {
      return { objects: [], truncated: false };
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

const NOTE = "tex/transcripts/2026-10-27.md";
const LEAF = "upload-efa705696e909140.png";

/** The callTool a turn wraps: read_image answers only for the one picture the note shows, and every call is recorded. */
function inner() {
  const calls = [];
  const callTool = async (name, args) => {
    calls.push({ name, args });
    if (name === "read_image") {
      return args.note === NOTE && args.image === LEAF
        ? { content: [{ type: "text", text: "image" }, { type: "image", data: b64("PNGBYTES"), mimeType: "image/png" }] }
        : { content: [{ type: "text", text: "not found" }], isError: true };
    }
    return { content: [{ type: "text", text: "ok" }] };
  };
  return { calls, callTool };
}

const draft = (attach) => ({ to: ["help@example.com"], subject: "Link previews", body: "Example below.", attach });

test("each way Tex is shown a file names a source an upload step reads", () => {
  assert.deepEqual(attachSource("attachment:2"), { sent: 2 });
  assert.deepEqual(attachSource(`${LEAF} in ${NOTE}`), { file: LEAF, note: NOTE });
  assert.deepEqual(attachSource(`image ${LEAF} in ${NOTE}`), { file: LEAF, note: NOTE });
  assert.match(attachSource("email:me@example.com/18c0ffee").error, /forward/);
  assert.deepEqual(attachSource("areas/receipts/october.pdf"), { file: "areas/receipts/october.pdf" });
  assert.equal(attachSource("  "), null);
});

test("a picture an earlier text sent is read as the person, then attached by its kept id", async () => {
  const store = memoryStore();
  const { calls, callTool } = inner();
  const wrapped = withEmailFiles({ store, attachments: [] }, callTool);
  await wrapped("save_email_draft", draft([`${LEAF} in ${NOTE}`]));
  assert.deepEqual(calls[0], { name: "read_image", args: { note: NOTE, image: LEAF } });
  const sent = calls.at(-1);
  assert.equal(sent.name, "save_email_draft");
  assert.equal(sent.args.attach.length, 1);
  const kept = await readDownload(store, sent.args.attach[0]);
  assert.equal(kept.file.type, "image/png");
  assert.equal(Buffer.from(kept.file.data, "base64").toString("latin1"), "PNGBYTES");
  // Named again in the same turn (a draft, then the send), it is the same id: a held email still matches.
  await wrapped("send_email", draft([`${LEAF} in ${NOTE}`]));
  assert.deepEqual(calls.at(-1).args.attach, sent.args.attach);
  assert.equal(calls.filter((call) => call.name === "read_image").length, 1);
});

test("a picture a note does not show, or the person cannot see, is refused before anything is kept or saved", async () => {
  const store = memoryStore();
  const { calls, callTool } = inner();
  const answer = await withEmailFiles({ store, attachments: [] }, callTool)("save_email_draft", draft([`upload-0000000000000000.png in ${NOTE}`]));
  assert.equal(answer.isError, true);
  assert.match(answer.content[0].text, /^Not saved: could not attach upload-0000000000000000\.png in .*not found/);
  assert.ok(!calls.some((call) => call.name === "save_email_draft"));
  assert.equal(store.objects.size, 0);
});

test("a picture sent with this text is attached as attachment:N; one already kept goes by its id", async () => {
  const store = memoryStore();
  const { calls, callTool } = inner();
  const attachments = [
    { name: "IMG_2691.png", mediaType: "image/png", data: b64("SHOT") },
    { name: "export.csv", mediaType: "text/csv", text: "a,b", kept: { id: "download:1761590000000-l-0123456789abcdef0123456789abcdef" } },
    { name: "resume.pdf", mediaType: "application/pdf", data: b64("%PDF"), carried: true },
  ];
  const wrapped = withEmailFiles({ store, attachments }, callTool);
  await wrapped("send_email", draft(["attachment:1", "attachment:2"]));
  const [picture, csv] = calls.at(-1).args.attach;
  assert.equal((await readDownload(store, picture)).file.name, "IMG_2691.png");
  assert.equal(csv, attachments[1].kept.id);
  // A file shown again from an earlier text is not "sent with this text".
  const refused = await wrapped("send_email", draft(["attachment:3"]));
  assert.match(refused.content[0].text, /^Not sent: could not attach attachment:3: not a file sent with this text\.$/);
});

test("download ids and every other tool pass through untouched", async () => {
  const { calls, callTool } = inner();
  const wrapped = withEmailFiles({ store: memoryStore(), attachments: [] }, callTool);
  const id = "download:1761590000000-l-0123456789abcdef0123456789abcdef";
  await wrapped("send_email", draft([id]));
  await wrapped("read_note", { path: `${LEAF} in ${NOTE}` });
  assert.deepEqual(calls.map((call) => call.name), ["send_email", "read_note"]);
  assert.deepEqual(calls[0].args.attach, [id]);
});

test("only Gmail's own answer lets Tex say attached", () => {
  const files = [{ filename: "IMG_2691.png" }];
  assert.match(attachedWords(files, [{ filename: "IMG_2691.png", size: 48_000 }], { draft: true }), /Gmail shows it holds IMG_2691\.png \(47 KB\): checked/);
  const empty = attachedWords(files, [{ filename: "IMG_2691.png", size: 0 }], { draft: true });
  assert.match(empty, /Gmail shows no file on it, not IMG_2691\.png: never say it is attached/);
  assert.match(empty, /Save the draft again/);
  assert.match(attachedWords(files, [], { draft: false }), /never say it is attached.*second email/);
  assert.match(attachedWords(files, undefined, { draft: true }), /not checked/);
  assert.equal(attachedWords([], [], { draft: true }), "");
});

test("a draft's answer says what Gmail holds", async () => {
  const store = memoryStore();
  const id = "download:" + Date.now() + "-l-0123456789abcdef0123456789abcdef";
  await store.put(`.context/agent/downloads/${id.slice("download:".length)}.json`, JSON.stringify({ name: "shot.png", type: "image/png", data: b64("PNG") }));
  let saw = null;
  store.email = {
    async draft(email) {
      saw = email;
      return { ok: true, from: "me@example.com", attached: [{ filename: "shot.png", size: 0 }] };
    },
  };
  const answer = await toolSaveEmailDraft(store, draft([id]));
  assert.equal(saw.files[0].filename, "shot.png");
  assert.match(answer.content[0].text, /^Saved as a draft.*never say it is attached/s);
});
