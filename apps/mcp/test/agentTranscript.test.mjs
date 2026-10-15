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
 *  3. `argsLine` without the `SECRET_KEY` test.
 *     → "an argument that looks like a secret is hidden" fails.
 *  4. `runTurn` without the thinking `tell`.
 *     → "runTurn tells the observer its thinking, its words between tools and each call" fails.
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

/** A note store behind a fake `read_note` / `write_note`, with etags. */
function fakeNotes(initial = {}) {
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
      if (note && args.expected_etag !== note.etag) return { ...text(`conflict: note changed since you read it (current etag ${note.etag}).`), isError: true };
      const etag = `e${(n += 1)}`;
      notes.set(args.path, { body: args.content, etag });
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
  const t = openTranscript(store.callTool, { now: NOW, timeZone: "UTC", question: "what's due today?", attachments: "Attached: photo.jpg" });
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
  assert.match(body, /_Attached: photo\.jpg_/);
  assert.match(body, /> 💭 They want today's tasks\.\n> Check todo\.md\./);
  assert.match(body, /\*\*Tex, while working:\*\* Looking\./);
  assert.match(body, /- `read_note` `\{"path":"todo\.md"\}` → ok, 0\.4 s/);
  assert.match(body, /\*\*Tex:\*\* Rent and the dentist\./);
  assert.doesNotMatch(body, /working_/);
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

test("an argument that looks like a secret is hidden, and long ones are cut", () => {
  const line = argsLine({ path: "a.md", password: "hunter2", nested: { api_key: "k", token: "t" }, content: "y".repeat(1000) });
  assert.doesNotMatch(line, /hunter2/);
  assert.match(line, /"password":"\[hidden\]"/);
  assert.match(line, /"api_key":"\[hidden\]"/);
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
  assert.match(bodies[0].system.map((block) => block.text).join(""), /tex\/transcripts\/ is your own record of these texts/);
});

test("the thinking is asked for in words only from a model that thinks by default", () => {
  const base = { system: "", messages: [{ role: "user", text: "hi" }], tools: [] };
  assert.deepEqual(gatewayBody({ ...base, model: "anthropic/claude-haiku-5-5", display: "summarized" }).thinking, { type: "adaptive", display: "summarized" });
  assert.deepEqual(gatewayBody({ ...base, model: "anthropic/claude-opus-5", display: "summarized" }).thinking, { type: "adaptive", display: "summarized" });
  assert.equal(gatewayBody({ ...base, model: "anthropic/claude-opus-4-8", display: "summarized" }).thinking, undefined);
  assert.equal(gatewayBody({ ...base, model: "anthropic/claude-haiku-4-5", display: "summarized" }).thinking, undefined);
  assert.equal(gatewayBody({ ...base, model: "anthropic/claude-haiku-5-5" }).thinking, undefined);
});
