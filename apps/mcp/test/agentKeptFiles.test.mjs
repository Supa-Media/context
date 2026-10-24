/**
 * A FILE THEY TEXTED IS KEPT, SO A LATER TEXT OR A JOB CAN READ IT AGAIN
 * (the owner's review of a chat, 2026-10-24).
 *
 * The owner texted Tex a bank export (a CSV) for a spending breakdown. Its
 * words reached only that turn ("Seen only on that turn"): the job doing the
 * breakdown never had it, every later text asked for it again, and Tex texted
 * cash-flow figures that were not in it. Now the file is kept in the person's
 * own bucket for 30 days under a `download:` id, the saved conversation keeps
 * the id, and `read_file` (or `read_note`, or `fetch`) with it reads the whole
 * file again, part by part.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *   `keepSentFiles` returning the attachments untouched → "a texted CSV is
 *     read again on a later text" fails (no id in the saved conversation).
 *   `withKeptFiles` left out of the route's dispatcher → the same check fails
 *     (read_note is asked for a note called download:…).
 *   `readKeptFile` returning the whole text with no parts → "a long file is
 *     read in parts" fails.
 *   `anthropicAttachmentBlocks` showing the whole kept text → "a long file is
 *     shown to its turn cut" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { anthropicAttachmentBlocks, attachmentsLine, carriesData, MAX_TEXT_CHARS } from "../src/agent/attachments.js";
import { keepSentFiles, keptRef, readKeptFile, withKeptFiles } from "../src/agent/keptFiles.js";
import { createEgressWorld, request, toolReplies, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";

/** An in-memory store, enough for `downloads.js`. */
function memoryStore() {
  const objects = new Map();
  return {
    objects,
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

const ROWS = ["Date,Description,Amount", "2026-10-01,Groceries,-82.10", "2026-10-02,Salary,4200.00", "2026-10-03,Rent,-2100.00"].join("\n");
const CSV = { name: "transactions.csv", mediaType: "text/csv", text: ROWS };
const textOf = (result) => result?.content?.map((part) => part.text).join("\n") ?? "";

test("a texted file is kept under a download: id and read again whole", async () => {
  const store = memoryStore();
  const [kept] = await keepSentFiles(store, [CSV]);
  assert.match(kept.kept.id, /^download:\d{13}-l-[a-f0-9]{32}$/);
  assert.equal(kept.kept.keptFor, "30 days");
  const read = await readKeptFile(store, null, keptRef(kept.kept.id));
  assert.equal(read.isError, undefined, textOf(read));
  const words = textOf(read);
  assert.match(words, /rows: 3 \(not counting the header\)/);
  assert.match(words, /header: Date, Description, Amount/);
  assert.match(words, /duplicate rows: none/);
  assert.match(words, /total of Amount: 2,017\.90/);
  assert.match(words, /trust: untrusted/);
  assert.match(words, /2026-10-03,Rent,-2100\.00/);
});

test("a voice message and a picture are not kept as files; a PDF is", async () => {
  const store = memoryStore();
  const out = await keepSentFiles(store, [
    { name: "a.caf", mediaType: "audio/x-caf", text: "pick up milk", heard: true },
    { name: "p.png", mediaType: "image/png", data: "iVBORw0KGgo=" },
    { name: "lease.pdf", mediaType: "application/pdf", data: Buffer.from("%PDF-1.4\n").toString("base64") },
  ]);
  assert.equal(out[0].kept, undefined);
  assert.equal(out[1].kept, undefined);
  assert.ok(out[2].kept?.id);
});

test("a long file is read in parts, each ending at a line and saying where the next starts", async () => {
  const store = memoryStore();
  const long = { name: "big.csv", mediaType: "text/csv", text: `h\n${"1,2,3\n".repeat(30_000)}` };
  const [kept] = await keepSentFiles(store, [long]);
  const first = textOf(await readKeptFile(store, null, keptRef(kept.kept.id)));
  // 100,000 falls inside a row, so the part ends at the line before it.
  assert.match(first, /characters: 0 to 99998 of 180002/);
  assert.match(first, new RegExp(`more: read_file with path "${kept.kept.id}@99998"`));
  assert.match(first, /rows: 30000/, "a table's facts count every row on every part");
  const second = textOf(await readKeptFile(store, null, keptRef(`${kept.kept.id}@99998`)));
  assert.match(second, /characters: 99998 to 180002 of 180002/);
  assert.doesNotMatch(second, /more:/);
  const viaFrom = withKeptFiles(store, null, async () => null);
  assert.match(textOf(await viaFrom("read_file", { path: kept.kept.id, from: 99998 })), /characters: 99998 to 180002/);
});

test("an id kept in one bucket finds nothing in another", async () => {
  const mine = memoryStore();
  const theirs = memoryStore();
  const [kept] = await keepSentFiles(mine, [CSV]);
  const read = await readKeptFile(theirs, null, keptRef(kept.kept.id));
  assert.equal(read.isError, true);
  assert.match(textOf(read), /not kept here/);
});

test("read_file, read_note and fetch with a download: id read the kept file and mark the turn; anything else passes through", async () => {
  const store = memoryStore();
  const [kept] = await keepSentFiles(store, [CSV]);
  let marked = 0;
  const passed = [];
  const call = withKeptFiles(store, () => (marked += 1), async (name, args) => {
    passed.push([name, args]);
    return { content: [{ type: "text", text: "dispatcher" }] };
  });
  for (const [name, args] of [["read_file", { path: kept.kept.id }], ["read_note", { path: kept.kept.id }], ["fetch", { id: ` ${kept.kept.id} ` }]]) {
    assert.match(textOf(await call(name, args)), /Groceries/, name);
  }
  assert.equal(marked, 3);
  assert.equal(passed.length, 0);
  assert.equal(textOf(await call("read_note", { path: "todo.md" })), "dispatcher");
  assert.equal(textOf(await call("read_note", { path: "download:not-an-id" })), "dispatcher");
  assert.equal(passed.length, 2);
});

test("the saved conversation names a kept file by its id, and not as seen only on that turn", async () => {
  const line = attachmentsLine([{ ...CSV, kept: { id: "download:1792000000000-l-" + "a".repeat(32), keptFor: "30 days" } }]);
  assert.match(line, /transactions\.csv \(kept as download:1792000000000-l-a{32}\)/);
  assert.doesNotMatch(line, /Seen only on that turn/);
  assert.match(line, /never ask them to resend it/);
  assert.match(attachmentsLine([CSV]), /Seen only on that turn/);
});

test("a long file is shown to its turn cut, with where the rest is and the rule for its figures", () => {
  const id = "download:1792000000000-l-" + "b".repeat(32);
  const text = `Date,Amount\n${"2026-10-01,-1.00\n".repeat(10_000)}`;
  const blocks = anthropicAttachmentBlocks([{ name: "rocket.csv", mediaType: "text/csv", text, kept: { id, keptFor: "30 days" } }], "breakdown please");
  assert.equal(blocks[0].source.data.length, MAX_TEXT_CHARS);
  const words = blocks.at(-1).text;
  assert.match(words, new RegExp(`only the first ${MAX_TEXT_CHARS} are shown above\\. The rest: read_file with path "${id}@${MAX_TEXT_CHARS}"`));
  assert.match(words, new RegExp(`kept for 30 days as ${id}`));
  assert.match(words, /never estimated or made up/);
  assert.match(words, /start a background job for it with the file's id in the brief/);
  assert.equal(carriesData([{ name: "rocket.csv", mediaType: "text/csv", text }]), true);
  assert.equal(carriesData([{ name: "note.txt", mediaType: "text/plain", text }]), false);
  assert.equal(carriesData([{ name: "tiny.csv", mediaType: "text/csv", text: "a,b\n1,2" }]), false);
});

test("a texted CSV is read again on a later text, from the id the conversation kept", async () => {
  const world = await createEgressWorld();
  try {
    world.model.install([{ text: "Got it, starting on it." }]);
    const first = await request(world.env, TOKEN_TEXTS, "/agent", { question: "here's my export", conversation: "texts", attachments: [CSV] });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const kept = world.objectsUnder(".context/agent/downloads/");
    assert.equal(kept.length, 1, "the file is kept in their own bucket");
    // The next text sees the id in its history, and reads the file by it.
    let id = null;
    world.model.install([
      (req) => {
        id = /download:\d{13}-l-[a-f0-9]{32}/.exec(JSON.stringify(req.messages))?.[0] ?? null;
        return { toolCalls: [{ name: "read_note", args: { path: id ?? "download:missing" } }] };
      },
      (req) => ({ text: toolReplies(req).some((reply) => /2026-10-03,Rent,-2100\.00/.test(reply)) ? "Rent was 2,100." : "I can't open it." }),
    ]);
    const later = await request(world.env, TOKEN_TEXTS, "/agent", { question: "what was my rent?", conversation: "texts" });
    assert.ok(id, "the saved conversation carries the file's id");
    assert.equal(later.body.answer, "Rent was 2,100.");
  } finally {
    world.restore();
  }
});
