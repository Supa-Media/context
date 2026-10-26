/**
 * A FILE A TEXT KEPT IS SHOWN AGAIN ON THE TEXTS THAT FOLLOW, AND TEX NEVER
 * SAYS IT WON'T OPEN (the owner's review of a chat, 2026-10-26).
 *
 * A resume PDF came with a text and Tex wrote a pitch from it. On the next
 * text it looked for the file with `list_notes { prefix: "download:…" }` and
 * `fetch { id: "download:…", args: { mail: false } }`, neither of which
 * reached the kept file, said "the kept PDF won't load", took back what it
 * had read, and asked the person to paste the text. Told "make sure this
 * never happens again", it wrote the lesson into their about-me note.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted (2026-10-26).
 *
 *   `carryKeptFiles` answering [] → "the next text sees the PDF again"
 *     fails (no document block on the later turn).
 *   `attachmentsLine` not leaving carried files out → "a file shown again is
 *     not saved as sent again" fails.
 *   `sixTools` resolve without its `download:` branch → "fetch with a kept
 *     id reads it, whatever args ride along" fails (the mail error).
 *   `READERS` without `list_notes` → "a listing of a kept id reads it" fails.
 *   `claimCheck` without the kept-file notice → "\"won't load\" with the
 *     file kept and unread gets one more round" fails.
 *   `lessonInAboutMe` answering null → "a lesson is refused from about-me"
 *     fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { anthropicAttachmentBlocks, attachmentsLine, carriesData, pictureFallback } from "../src/agent/attachments.js";
import { lessonInAboutMe } from "../src/agent/bugCheck.js";
import { claimCheck } from "../src/agent/claimCheck.js";
import { givesUpOnAFile } from "../src/agent/keptClaims.js";
import { CARRY_PDF_BYTES, CARRY_TEXTS, CARRY_TEXT_CHARS, carryKeptFiles, keepSentFiles, keptIdsOf, keptInHistory, withKeptFiles } from "../src/agent/keptFiles.js";
import { LESSONS_LINE, SAME_NAME_LINE, systemPrompt } from "../src/agent/prompt.js";
import { sixToolsOver } from "../src/agent/sixTools.js";
import { toolDefinitions } from "../src/tools/registry.js";
import { createEgressWorld, request, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";

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

const PDF_DATA = Buffer.from("%PDF-1.4\nSenior Analyst, Acme Bank\n").toString("base64");
const RESUME = { name: "Jordan_Lee_Resume.pdf", mediaType: "application/pdf", data: PDF_DATA };
const textOf = (result) => result?.content?.map((part) => part.text).join("\n") ?? "";
const said = (text) => ({ role: "user", text });
const answered = (text) => ({ role: "assistant", text });

test("the next text sees the PDF again, and a file shown again is not saved as sent again", async () => {
  const world = await createEgressWorld();
  try {
    world.model.install([{ text: "Here's the pitch." }]);
    const first = await request(world.env, TOKEN_TEXTS, "/agent", { question: "in 150 words why should we hire this person", conversation: "texts", attachments: [RESUME] });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    let seen = null;
    world.model.install([
      (req) => {
        seen = JSON.stringify(req.messages);
        return { text: "Fixed: the referral is about Jordan Lee only." };
      },
    ]);
    const later = await request(world.env, TOKEN_TEXTS, "/agent", { question: "Jordan Park is not Jordan Lee", conversation: "texts" });
    assert.equal(later.status, 200, JSON.stringify(later.body));
    assert.ok(seen.includes(PDF_DATA), "the kept PDF rides along on the later text");
    assert.match(seen, /a file they sent earlier in this chat, kept as download:/);
    assert.match(seen, /never say it won't open or load/);
    // The second exchange's saved line names nothing as sent with it.
    world.model.install([
      (req) => {
        seen = JSON.stringify(req.messages);
        return { text: "ok" };
      },
    ]);
    await request(world.env, TOKEN_TEXTS, "/agent", { question: "thanks", conversation: "texts" });
    assert.equal((seen.match(/\[Sent with this text:/g) ?? []).length, 1, "only the text that came with it names the file");
  } finally {
    world.restore();
  }
});

test("a kept file rides along for the last few texts only, newest two, each once", () => {
  const id = (n) => `download:179200000000${n}-l-${String(n).repeat(32)}`;
  const history = [
    said(`old [Sent with this text: a.pdf (kept as ${id(1)}).]`),
    answered("a"),
    ...Array.from({ length: CARRY_TEXTS - 1 }, (_, i) => [said(`text ${i}`), answered("b")]).flat(),
    said(`[Sent with this text: b.pdf (kept as ${id(2)}), c.csv (kept as ${id(3)}).]`),
    answered("c"),
  ];
  assert.deepEqual(keptInHistory(history), [id(3), id(2)], "the oldest is past the window");
  assert.deepEqual(keptInHistory([...history, said(`again [Sent with this text: c.csv (kept as ${id(3)}).]`)]), [id(3), id(2)]);
  assert.deepEqual(keptIdsOf([{ kept: { id: id(4) } }, { name: "p.png" }], [id(3)]), [id(4), id(3)]);
});

test("a big PDF is left to read_file; a long text file is carried cut, saying where the rest is", async () => {
  const store = memoryStore();
  const big = { name: "book.pdf", mediaType: "application/pdf", data: Buffer.alloc(CARRY_PDF_BYTES + 3).toString("base64") };
  const csv = { name: "export.csv", mediaType: "text/csv", text: `Date,Amount\n${"2026-10-01,-1.00\n".repeat(3_000)}` };
  const kept = await keepSentFiles(store, [big, csv]);
  const history = [said(attachmentsLine(kept)), answered("ok")];
  const carried = await carryKeptFiles(store, history, []);
  assert.deepEqual(carried.map((file) => file.name), ["export.csv"]);
  assert.equal(carried[0].text.length, CARRY_TEXT_CHARS);
  assert.equal(carriesData(carried), false, "a file shown again does not send every later text to the planner");
  const words = anthropicAttachmentBlocks(carried, "what was rent?").at(-1).text;
  assert.match(words, /^Files from earlier in this chat, shown again:/);
  assert.match(words, new RegExp(`the rest: read_file with path "${carried[0].kept.id}@${CARRY_TEXT_CHARS}"`));
  assert.doesNotMatch(words, /start a background job/);
  assert.equal(attachmentsLine(carried), "");
  // Nothing carried twice when the same file came with this very text, and nothing from another bucket.
  assert.deepEqual(await carryKeptFiles(store, history, kept), []);
  assert.deepEqual(await carryKeptFiles(memoryStore(), history, []), []);
});

test("fetch with a kept id reads it, whatever args ride along, and a listing of a kept id reads it", async () => {
  const definitions = new Map(toolDefinitions().map((tool) => [tool.name, tool]));
  const six = sixToolsOver(["orient", "search_notes", "read_note", "list_notes", "read_file"].map((name) => definitions.get(name)).filter(Boolean));
  const id = "download:1792000000000-l-0123456789abcdef0123456789abcdef";
  const resolved = six.resolve("fetch", { id, args: { mail: false } });
  assert.equal(resolved.error, undefined, resolved.error);
  assert.ok(["read_file", "read_note"].includes(resolved.name));
  assert.equal(resolved.args.path, id);
  assert.deepEqual(six.resolve("fetch", { id: `${id}@500`, args: { from: 900 } }).args, { path: `${id}@500`, from: 900 });

  const store = memoryStore();
  const [kept] = await keepSentFiles(store, [{ name: "notes.txt", mediaType: "text/plain", text: "Acme Bank, Example Health" }]);
  const call = withKeptFiles(store, null, async () => ({ content: [{ type: "text", text: "dispatcher" }] }));
  assert.match(textOf(await call("list_notes", { prefix: kept.kept.id })), /Acme Bank/);
  assert.equal(textOf(await call("list_notes", { prefix: "projects/" })), "dispatcher");
});

test("\"won't load\" with the file kept and unread gets one more round; a read that ran lets it go", async () => {
  const id = "download:1792000000000-l-0123456789abcdef0123456789abcdef";
  const answer = "I tried again and still can't open the resume. The kept PDF won't load. Can you paste the resume's text here?";
  const first = claimCheck({ question: "Jordan Park is not Jordan Lee", kept: [id], keptShown: true });
  const notice = await first.check(answer);
  assert.match(String(notice), new RegExp(`kept as ${id}, and it is shown above`));
  assert.match(String(notice), /never ask them to paste, copy or resend it/);
  assert.doesNotMatch(String(await first.check(answer) ?? ""), /kept as/, "once a turn");

  const read = claimCheck({ question: "check it", kept: [id] });
  await read.wrap(async () => ({ isError: true, content: [{ type: "text", text: "no words could be taken out of this file" }] }))("read_file", { path: id });
  assert.doesNotMatch(String((await read.check("Sorry, that PDF won't open: no words could be taken out of it.")) ?? ""), /kept as/);

  const none = claimCheck({ question: "hi" });
  assert.doesNotMatch(String((await none.check(answer)) ?? ""), /kept as/, "no kept file, no notice");
});

test("what reads as giving up on a file", () => {
  for (const words of [
    "The kept PDF won't load.",
    "I can't open the file you sent.",
    "Copy the text from the PDF on your phone and paste it here.",
    "Could you resend the resume?",
    "I'm not able to read that attachment.",
  ]) {
    assert.equal(givesUpOnAFile(words), true, words);
  }
  for (const words of ["Here's the pitch from the resume.", "I can't make Thursday work, the file says Friday.", "Rent was 2,100."]) {
    assert.equal(givesUpOnAFile(words), false, words);
  }
});

test("a lesson is refused from about-me; a fact about them is not", () => {
  const write = (path) => ["write_note", { path, content: "x" }];
  const lesson = "Improvement Agent, take note of this please and make sure this never happens again";
  assert.match(textOf(lessonInAboutMe(lesson, ...write("tex/about-me.md"))), /report_problem/);
  assert.match(textOf(lessonInAboutMe("don't do that again", ...write("@seyi/tex/about-me.md"))), /lesson about how you work/);
  assert.equal(lessonInAboutMe(lesson, ...write("projects/referral.md")), null);
  assert.equal(lessonInAboutMe("take note that I'm vegetarian", ...write("tex/about-me.md")), null);
  assert.equal(lessonInAboutMe(lesson, "read_note", { path: "tex/about-me.md" }), null);
});

test("a texted turn is told that one name can be two people, and where a lesson goes", () => {
  const prompt = systemPrompt(null, { texting: true, edits: true });
  assert.ok(prompt.includes(SAME_NAME_LINE));
  assert.ok(prompt.includes(LESSONS_LINE));
  assert.match(SAME_NAME_LINE, /never because a first name or nickname matches/);
  assert.ok(systemPrompt(null, { texting: true, edits: false }).includes(SAME_NAME_LINE));
});

test("a PDF turn falls back to a model that can read it", () => {
  const pick = pictureFallback("@cf/zai-org/glm-4.7-flash", ["anthropic/claude-haiku-5-5", "anthropic/claude-opus-5-5"], [RESUME]);
  assert.equal(typeof pick, "function");
  assert.equal(pick("anthropic/claude-haiku-5-5"), "anthropic/claude-opus-5-5");
  assert.equal(pictureFallback("@cf/zai-org/glm-4.7-flash", ["anthropic/claude-haiku-5-5"], [{ name: "a.txt", mediaType: "text/plain", text: "hi" }]), "@cf/zai-org/glm-4.7-flash");
});
