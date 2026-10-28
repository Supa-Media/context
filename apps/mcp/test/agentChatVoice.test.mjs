/**
 * How Tex sounds in each chat (`src/agent/chatVoice.js`,
 * `docs/decisions/texting-assistant/tex-voice.md`, Dev2, 2026-10-28): it
 * mirrors the chat and answers in its language on every texted turn, a length
 * someone set wins over a group's "line or two", and a group's voice note is
 * read into its words, bounded.
 *
 * Sabotage record (2026-10-28), each fails a test here:
 *  - `MIRROR_LINE` taken out of the texted lines in `prompt.js`: "every texted turn";
 *  - `OVERRIDES` dropped from the lengths in `texStyle.js`: "a length someone set";
 *  - `readGroupVoice` without its line cap: "a group's voice note".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { LANGUAGE_LINE, MAX_VOICE_CHARS, MIRROR_LINE, groupVoicePath, readGroupVoice, voicePrompt } from "../src/agent/chatVoice.js";
import { groupPrompt, readGroupMemory } from "../src/agent/groupTurn.js";
import { guestPrompt } from "../src/agent/groupGuests.js";
import { systemPrompt } from "../src/agent/prompt.js";
import { readTexStyle, stylePrompt } from "../src/agent/texStyle.js";

const GROUP = { key: "a".repeat(64), members: "b".repeat(64), from: "seyi", chat: [], people: [] };

test("every texted turn mirrors the chat and answers in its language, a production setup's words too", () => {
  for (const notes of [null, { prompt: "You are the production assistant." }]) {
    const said = systemPrompt(null, { texting: true, notes });
    assert.ok(said.includes(MIRROR_LINE), "mirror line");
    assert.ok(said.includes(LANGUAGE_LINE), "language line");
  }
  assert.ok(!systemPrompt(null).includes(MIRROR_LINE), "the app's own chat is not a texted turn");
});

test("a length someone set wins over a group's line or two; with none set, the line or two stands", () => {
  assert.match(groupPrompt(GROUP, "supa"), /in a line or two/);
  assert.match(guestPrompt({ ...GROUP, guestChat: true }, "supa"), /in a line or two/);
  for (const length of ["short", "detailed"]) {
    assert.match(stylePrompt(readTexStyle({ length })), /replaces any earlier rule about how long to answer, such as answering in a line or two/, length);
  }
  assert.doesNotMatch(stylePrompt(readTexStyle({ humor: 60 })), /replaces any earlier rule/, "no length set, nothing overridden");
});

test("a group's voice note is read into its words, bounded, and says how it is kept", async () => {
  const path = groupVoicePath("c".repeat(64));
  assert.equal(path, "tex/groups/voice-cccccccccccc.md");
  const long = ["# How this group talks", ...Array.from({ length: 20 }, (_, i) => `- bullet ${i} ${"x".repeat(150)}`)].join("\n");
  const dispatch = async (name, args) => {
    assert.equal(name, "read_note");
    assert.equal(args.path, path);
    return { content: [{ type: "text", text: `etag: v1\n\n${long}` }] };
  };
  const voice = await readGroupVoice(dispatch, path);
  assert.ok(voice.length <= MAX_VOICE_CHARS, "bounded in characters");
  assert.ok(voice.split("\n").length <= 6, "at most six lines");
  assert.doesNotMatch(voice, /^#/m, "headings are not shown");
  const many = Array.from({ length: 20 }, (_, i) => `- short ${i}`).join("\n");
  const few = await readGroupVoice(async () => ({ content: [{ type: "text", text: `etag: v2\n\n${many}` }] }), path);
  assert.equal(few.split("\n").length, 6, "at most six bullets, however short");

  const told = groupPrompt({ ...GROUP, voicePath: path, voice: "- casual, lots of emoji\n- Spanish and English" }, "supa");
  assert.match(told, /How this group talks is kept in tex\/groups\/voice-cccccccccccc\.md/);
  assert.match(told, /<<<VOICE\n- casual, lots of emoji\n- Spanish and English\nVOICE/);
  assert.match(told, /never a tool's output/);
  assert.equal(voicePrompt({ ...GROUP, voicePath: null }), "", "no note path, nothing said");
  assert.equal(await readGroupVoice(async () => ({ isError: true, content: [{ text: "not found" }] }), path), "", "no note yet");
});

test("every group turn reads the chat's voice note, beside its memory note", async () => {
  const read = [];
  const dispatch = async (name, args) => {
    read.push(args.path);
    if (/\/voice-[0-9a-f]{12}\.md$/.test(args.path)) return { content: [{ type: "text", text: "etag: v1\n\n- dry humor\n- lowercase" }] };
    return { isError: true, content: [{ type: "text", text: "not found" }] };
  };
  const group = { ...GROUP };
  await readGroupMemory({ get: async () => null }, group, dispatch);
  assert.match(group.voicePath, /^tex\/groups\/voice-[0-9a-f]{12}\.md$/);
  assert.ok(read.includes(group.voicePath), "the voice note is read");
  assert.equal(group.voice, "- dry humor\n- lowercase");
});

