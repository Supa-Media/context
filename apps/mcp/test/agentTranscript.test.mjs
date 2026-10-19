/**
 * TEX'S DAILY TRANSCRIPT (`src/agent/transcript.js`, owner, 2026-10-15).
 *
 * A texted turn is written into `tex/transcripts/YYYY-MM-DD.md`, dated in the
 * person's zone, as it happens: their text, the thinking, each tool call with
 * its arguments (secrets hidden, results never), and the answer. It never
 * overwrites a day it could not read, and a lost race re-reads and goes again
 * without keeping its own part twice.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted (2026-10-15).
 *
 *  1. `readDay` treating every refusal as "missing".
 *     → "a day that could not be read is never overwritten" fails.
 *  2. `withoutTurn` returning the text unchanged.
 *     → "a write that lost a race re-reads, appends after the other turn, and keeps its own part once" fails.
 *  3. `argsLine` without the `SECRET_KEY` test, or without `CONTENT_KEY`.
 *     → "an argument that looks like a secret is hidden, a note's text is only its length…" fails.
 *  4. `runTurn` without the thinking `tell`.
 *     → "runTurn tells the observer its thinking, its words between tools and each call" fails.
 *  6. `writeOnce` not reading back after a successful write.
 *     → "a write merged with another turn's part is read back…" fails.
 *  7. `sentItems` naming a picture instead of embedding it, or writing a voice message as its name.
 *     → "a texted picture is stored once and shown, a voice message is quoted…" fails.
 *  8. `writeOnce` keeping a refused picture.
 *     → "a picture write_note refuses is named instead, and the turn is still written" fails.
 *  9. `writeOnce` not marking the transcript dirty while pictures remain.
 *     → "more pictures than one write takes all go up…" fails.
 *  5. `gatewayBody` sending `thinking` to every model.
 *     → "the thinking is asked for in words only from a model that thinks by default" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { argsLine, MAX_DAY_CHARS, openTranscript, transcriptPath } from "../src/agent/transcript.js";
import { aiGatewayConfig, gatewayBody } from "../src/agent/aiGateway.js";
import { AI_GATEWAY_ENV } from "./agentModelFixture.mjs";
import { runTurn } from "../src/agent/turn.js";
import { BUILTIN_PROVIDER } from "../src/agent/builtin.js";

// 2026-10-15 03:30 UTC: still the 14th in New York.
const NOW = Date.UTC(2026, 9, 15, 3, 30);

/**
 * A note store behind a fake `read_note` / `write_note`, with etags. With
 * `merges`, a write against an older etag is merged like a collaboratively
 * edited note's: the writer's change to that older version, applied on top
 * of what is there now.
 */
function fakeNotes(initial = {}, { merges = false } = {}) {
  const versions = new Map();
  const notes = new Map(Object.entries(initial).map(([path, body], i) => [path, { body, etag: `e${i}` }]));
  let n = 100;
  const calls = [];
  const callTool = async (name, args) => {
    calls.push([name, args]);
    const text = (value) => ({ content: [{ type: "text", text: value }] });
    if (name === "read_note") {
      const note = notes.get(args.path);
      if (!note) return { ...text("not found"), isError: true };
      return text(`etag: ${note.etag}\npath: ${args.path}\nvisibility: private\n\n${note.body}`);
    }
    if (name === "write_note") {
      const note = notes.get(args.path);
      let body = args.content;
      if (note && args.expected_etag !== note.etag) {
        const base = versions.get(args.expected_etag);
        if (!merges || base === undefined || !note.body.startsWith(base)) {
          return { ...text(`conflict: note changed since you read it (current etag ${note.etag}).`), isError: true };
        }
        body = args.content + note.body.slice(base.length);
      }
      const etag = `e${(n += 1)}`;
      versions.set(etag, body);
      notes.set(args.path, { body, etag });
      return text(`written: ${args.path} (etag ${etag})\nvisibility: private`);
    }
    throw new Error(`unexpected tool ${name}`);
  };
  return { notes, calls, callTool };
}

test("the day is the person's own, in their zone", () => {
  assert.equal(transcriptPath(NOW, "America/New_York"), "tex/transcripts/2026-10-14.md");
  assert.equal(transcriptPath(NOW, "Europe/London"), "tex/transcripts/2026-10-15.md");
  assert.equal(transcriptPath(NOW, "not/a-zone"), "tex/transcripts/2026-10-14.md");
  assert.equal(transcriptPath(NOW, "UTC", 2), "tex/transcripts/2026-10-15-2.md");
});

test("a turn is in the note before it is answered, then whole after", async () => {
  const store = fakeNotes();
  const t = openTranscript(store.callTool, { now: NOW, timeZone: "UTC", question: "what's due today?", attachments: [{ name: "report.pdf", mediaType: "application/pdf", data: "JVBERi0=" }] });
  t.record({ kind: "thinking", text: "They want today's tasks.\nCheck todo.md." });
  t.record({ kind: "say", text: "Looking." });
  t.record({ kind: "tool", name: "read_note", args: { path: "todo.md" }, ok: true, ms: 420 });
  // Mid-turn: the note already holds the question and is marked as working.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const during = store.notes.get("tex/transcripts/2026-10-15.md")?.body ?? "";
  assert.match(during, /\*\*Them:\*\* what's due today\?/);
  assert.match(during, /_…working_/);
  await t.finish({ answer: "Rent and the dentist." });
  const body = store.notes.get("tex/transcripts/2026-10-15.md").body;
  assert.match(body, /^# Tex, October 15, 2026/);
  assert.match(body, /## 3:30 am/);
  assert.match(body, /_Sent report\.pdf\._/);
  assert.doesNotMatch(body, /JVBERi0/);
  assert.match(body, /> 💭 They want today's tasks\.\n> Check todo\.md\./);
  assert.match(body, /\*\*Tex, while working:\*\* Looking\./);
  assert.match(body, /- `read_note` `\{"path":"todo\.md"\}` → ok, 0\.4 s/);
  assert.match(body, /\*\*Tex:\*\* Rent and the dentist\./);
  assert.doesNotMatch(body, /working_/);
});

test("an inline reply shows the message it answers above the person's words", async () => {
  const store = fakeNotes();
  const t = openTranscript(store.callTool, { now: NOW, timeZone: "UTC", question: "try again", quoted: "The Oct 30 price isn't in your notes." });
  await t.finish({ answer: "Looking for the Oct 30 price again." });
  const body = store.notes.get("tex/transcripts/2026-10-15.md").body;
  assert.match(body, /> ↩︎ Replying to: The Oct 30 price isn't in your notes\.\n\n\*\*Them:\*\* try again/);
  const plain = fakeNotes();
  const u = openTranscript(plain.callTool, { now: NOW, timeZone: "UTC", question: "hi" });
  await u.finish({ answer: "Hi." });
  assert.doesNotMatch(plain.notes.get("tex/transcripts/2026-10-15.md").body, /Replying to/);
});

// A 1×1 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

test("a texted picture is stored once and shown, a voice message is quoted, another file is named", async () => {
  const store = fakeNotes();
  const t = openTranscript(store.callTool, {
    now: NOW,
    timeZone: "UTC",
    question: "",
    attachments: [
      { name: "IMG_1.png", mediaType: "image/png", data: PNG },
      { name: "Audio Message.m4a", mediaType: "audio/mp4", text: "Buy milk on the way home.", heard: true },
      { name: "odd.bin", mediaType: "application/octet-stream", unread: "Not a kind I can open." },
    ],
  });
  t.record({ kind: "say", text: "Noted." });
  await t.finish({ answer: "Will do." });
  const body = store.notes.get("tex/transcripts/2026-10-15.md").body;
  const writes = store.calls.filter(([name]) => name === "write_note").map(([, args]) => args);
  const withImages = writes.filter((args) => args.images);
  assert.equal(withImages.length, 1, "the picture goes up with one write, not every write");
  assert.equal(withImages[0], writes[0]);
  assert.match(withImages[0].images[0].name, /^upload-[0-9a-f]{16}\.png$/);
  assert.equal(withImages[0].images[0].data, `data:image/png;base64,${PNG}`);
  assert.ok(body.includes(`![[${withImages[0].images[0].name}|IMG_1.png]]`));
  assert.match(body, /\*\*Them:\*\* _\(no words\)_/);
  assert.match(body, /> 🎤 Voice message: "Buy milk on the way home\."/);
  assert.match(body, /_Sent odd\.bin, which could not be opened\._/);
  assert.doesNotMatch(body, new RegExp(PNG.slice(0, 20)));
});

test("more pictures than one write takes all go up, even with nothing else happening", async () => {
  const store = fakeNotes();
  const base = Buffer.from(PNG, "base64");
  // Eleven different pictures: one write takes ten.
  const attachments = Array.from({ length: 11 }, (_, i) => ({
    name: `IMG_${i}.png`,
    mediaType: "image/png",
    data: Buffer.concat([base, Buffer.from([i])]).toString("base64"),
  }));
  const t = openTranscript(store.callTool, { now: NOW, timeZone: "UTC", question: "all of these", attachments });
  await t.finish({ answer: "Got them." });
  const uploaded = store.calls.filter(([name, args]) => name === "write_note" && args.images).flatMap(([, args]) => args.images);
  assert.equal(new Set(uploaded.map((image) => image.name)).size, 11);
  const body = store.notes.get("tex/transcripts/2026-10-15.md").body;
  assert.equal(body.match(/!\[\[upload-/g)?.length, 11);
});

test("a picture write_note refuses is named instead, and the turn is still written", async () => {
  const store = fakeNotes();
  const callTool = async (name, args) =>
    name === "write_note" && args.images
      ? { content: [{ type: "text", text: "images[0]: refused" }], isError: true }
      : store.callTool(name, args);
  const t = openTranscript(callTool, {
    now: NOW,
    timeZone: "UTC",
    question: "look",
    attachments: [{ name: "IMG_2.png", mediaType: "image/png", data: PNG }],
  });
  await t.finish({ answer: "Nice." });
  const body = store.notes.get("tex/transcripts/2026-10-15.md")?.body ?? "";
  assert.match(body, /_Sent IMG_2\.png, a picture that could not be kept\._/);
  assert.doesNotMatch(body, /!\[\[upload-/);
  assert.match(body, /\*\*Tex:\*\* Nice\./);
});

test("the next turn goes after the last, and nothing earlier is lost", async () => {
  const store = fakeNotes({ "tex/transcripts/2026-10-15.md": "# Tex, October 15, 2026\n\n## 1:00 am\n\n**Them:** hi\n" });
  const t = openTranscript(store.callTool, { now: NOW, timeZone: "UTC", question: "again" });
  await t.finish({ answer: "Hi again." });
  const body = store.notes.get("tex/transcripts/2026-10-15.md").body;
  assert.match(body, /\*\*Them:\*\* hi\n[\s\S]*\*\*Them:\*\* again[\s\S]*Hi again\./);
});

test("a write that lost a race re-reads, appends after the other turn, and keeps its own part once", async () => {
  const store = fakeNotes({ "tex/transcripts/2026-10-15.md": "# Tex\n" });
  const t = openTranscript(store.callTool, { now: NOW, timeZone: "UTC", question: "first" });
  t.record({ kind: "say", text: "on it" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  // Another turn writes the day in between.
  const note = store.notes.get("tex/transcripts/2026-10-15.md");
  store.notes.set("tex/transcripts/2026-10-15.md", { body: `${note.body}\n## other\n\n**Them:** second\n`, etag: "other" });
  await t.finish({ answer: "Done." });
  const body = store.notes.get("tex/transcripts/2026-10-15.md").body;
  assert.match(body, /\*\*Them:\*\* second/);
  assert.equal(body.match(/\*\*Them:\*\* first/g)?.length, 1);
  assert.match(body, /\*\*Tex:\*\* Done\./);
});

test("a write merged with another turn's part is read back, so the next write keeps that part", async () => {
  const store = fakeNotes({}, { merges: true });
  const path = "tex/transcripts/2026-10-15.md";
  const a = openTranscript(store.callTool, { now: NOW, timeZone: "UTC", question: "first" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const b = openTranscript(store.callTool, { now: NOW, timeZone: "UTC", question: "second" });
  await b.finish({ answer: "B done." });
  // A's next write is against its older etag: merged, B's part kept.
  a.record({ kind: "say", text: "still going" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await a.finish({ answer: "A done." });
  const body = store.notes.get(path).body;
  assert.match(body, /\*\*Them:\*\* second[\s\S]*B done\./);
  assert.match(body, /\*\*Them:\*\* first[\s\S]*A done\./);
  assert.equal(body.match(/\*\*Them:\*\* first/g)?.length, 1);
});

test("a day that could not be read is never overwritten", async () => {
  const writes = [];
  const callTool = async (name, args) => {
    if (name === "write_note") writes.push(args);
    return { content: [{ type: "text", text: "storage unavailable" }], isError: true };
  };
  const t = openTranscript(callTool, { now: NOW, timeZone: "UTC", question: "hi" });
  await t.finish({ answer: "hello" });
  assert.deepEqual(writes, []);
});

test("a full day carries on in the next part", async () => {
  const store = fakeNotes({ "tex/transcripts/2026-10-15.md": "x".repeat(MAX_DAY_CHARS + 1) });
  const t = openTranscript(store.callTool, { now: NOW, timeZone: "UTC", question: "late one" });
  await t.finish({ answer: "ok" });
  assert.equal(store.notes.get("tex/transcripts/2026-10-15.md").body.length, MAX_DAY_CHARS + 1);
  assert.match(store.notes.get("tex/transcripts/2026-10-15-2.md").body, /late one/);
});

test("an argument that looks like a secret is hidden, a note's text is only its length, and long ones are cut", () => {
  const line = argsLine({ path: "a.md", password: "hunter2", nested: { api_key: "k", token: "t" }, content: "SHARED-WORDS ".repeat(80), query: "q".repeat(1000) });
  assert.doesNotMatch(line, /hunter2/);
  assert.match(line, /"password":"\[hidden\]"/);
  assert.match(line, /"api_key":"\[hidden\]"/);
  assert.doesNotMatch(line, /SHARED-WORDS/);
  assert.match(line, /"content":"\[1040 characters\]"/);
  assert.ok(line.length <= 801);
});

test("a routine's run says which routine, and a failed turn says so", async () => {
  const store = fakeNotes();
  const t = openTranscript(store.callTool, { now: NOW, timeZone: "UTC", question: "Routine: …", routine: "tex/routines/daily/standup.md" });
  await t.finish({ answer: "", outcome: "the turn failed" });
  const body = store.notes.get("tex/transcripts/2026-10-15.md").body;
  assert.match(body, /## 3:30 am · routine/);
  assert.match(body, /\*\*Routine\*\* `tex\/routines\/daily\/standup\.md` ran\./);
  assert.match(body, /_No answer: the turn failed\._/);
});

test("runTurn tells the observer its thinking, its words between tools and each call", async () => {
  const events = [];
  const replies = [
    {
      content: [
        { type: "thinking", thinking: "Need the todo list.", signature: "s" },
        { type: "text", text: "Checking." },
        { type: "tool_use", id: "t1", name: "read_note", input: { path: "todo.md" } },
      ],
      stop_reason: "tool_use",
    },
    { content: [{ type: "text", text: "Rent." }], stop_reason: "end_turn" },
  ];
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify(replies.shift()), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const turn = await runTurn({
    question: "what's due?",
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    tools: [{ name: "read_note", description: "Read.", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }],
    callTool: async () => ({ content: [{ type: "text", text: "- rent" }] }),
    env: { ...AI_GATEWAY_ENV, AGENT_BUILTIN_MODEL: "anthropic/claude-haiku-5-5" },
    providerOptions: { gateway: aiGatewayConfig(AI_GATEWAY_ENV), fetchImpl },
    builtinModelOverride: "anthropic/claude-haiku-5-5",
    texting: true,
    observe: (event) => events.push(event),
  });
  assert.equal(turn.answer, "Rent.");
  assert.deepEqual(
    events.map((event) => event.kind),
    ["thinking", "say", "tool"],
  );
  assert.equal(events[0].text, "Need the todo list.");
  assert.deepEqual(events[2].args, { path: "todo.md" });
  assert.equal(events[2].ok, true);
  assert.deepEqual(bodies[0].thinking, { type: "adaptive", display: "summarized" });
  // Asked "what is my Tex transcript folder called?", Tex once said it was not in their workspace (2026-10-16).
  const system = bodies[0].system.map((block) => block.text).join("");
  assert.match(system, /tex\/transcripts\/ in their personal workspace holds a transcript of these texts, one note a day/);
  assert.match(system, /they can open it like any note/);
  assert.doesNotMatch(system, /not their notes/);
});

test("the thinking is asked for in words only from a model that thinks by default", () => {
  const base = { system: "", messages: [{ role: "user", text: "hi" }], tools: [] };
  assert.deepEqual(gatewayBody({ ...base, model: "anthropic/claude-haiku-5-5", display: "summarized" }).thinking, { type: "adaptive", display: "summarized" });
  assert.deepEqual(gatewayBody({ ...base, model: "anthropic/claude-opus-5", display: "summarized" }).thinking, { type: "adaptive", display: "summarized" });
  assert.equal(gatewayBody({ ...base, model: "anthropic/claude-opus-4-8", display: "summarized" }).thinking, undefined);
  assert.equal(gatewayBody({ ...base, model: "anthropic/claude-haiku-4-5", display: "summarized" }).thinking, undefined);
  assert.equal(gatewayBody({ ...base, model: "anthropic/claude-haiku-5-5" }).thinking, undefined);
});
