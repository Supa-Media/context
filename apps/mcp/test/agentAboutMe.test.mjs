/**
 * WHAT TEX KNOWS ABOUT THE PERSON, IN `tex/about-me.md` (owner, 2026-10-14).
 *
 * A texted turn reads the note through the session's own dispatcher and puts
 * it in the system prompt; a missing note is a turn that is told to start
 * one, never a failed turn.
 *
 * ## Sabotage record
 *
 *   `runTurn` dropping `aboutMe` from the system prompt
 *     → "a texted turn is told what the note says, and to keep it" fails
 *   `bodyOf` keeping read_note's header lines
 *     → "the note's body is read, without read_note's header" fails
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BUILTIN_PROVIDER } from "../src/agent/builtin.js";
import { runTurn } from "../src/agent/turn.js";
import { ABOUT_ME_PATH, MAX_ABOUT_ME_CHARS, aboutMePrompt, readAboutMe } from "../src/agent/aboutMe.js";

const MODEL = "@cf/zai-org/glm-4.7-flash";
const WRITE = { name: "write_note", description: "Write a note.", inputSchema: { type: "object", properties: {} } };

function fakeAi(text) {
  const calls = [];
  return {
    calls,
    async run(model, input) {
      calls.push({ model, input });
      return { choices: [{ message: { content: text } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    },
  };
}

const READ_RESULT = (body) => ({
  content: [{ type: "text", text: `etag: e1\npath: ${ABOUT_ME_PATH}\nvisibility: private\ndocument_id: doc-1\n\n${body}` }],
});

test("the note's body is read, without read_note's header", async () => {
  const asked = [];
  const text = await readAboutMe(async (name, args) => {
    asked.push([name, args]);
    return READ_RESULT("# About Maya\n\n- Prefers texts before 9 pm.\n");
  });
  assert.deepEqual(asked, [["read_note", { path: ABOUT_ME_PATH }]]);
  assert.equal(text, "# About Maya\n\n- Prefers texts before 9 pm.");
});

test("a missing note, a refusal or a throw is an empty note, never a failed turn", async () => {
  assert.equal(await readAboutMe(async () => ({ content: [{ type: "text", text: "Not found" }], isError: true })), "");
  assert.equal(await readAboutMe(async () => { throw new Error("storage down"); }), "");
  assert.equal(await readAboutMe(async () => ({ content: [{ type: "text", text: "no header here" }] })), "");
});

test("the prompt says what the note holds, bounded, and to keep it only when the turn can write", () => {
  const kept = aboutMePrompt("- Has a dog called Pip.", { edits: true });
  assert.match(kept, /What you know about them, from tex\/about-me\.md/);
  assert.match(kept, /Has a dog called Pip/);
  assert.match(kept, /add it to tex\/about-me\.md/);
  assert.doesNotMatch(aboutMePrompt("- Has a dog.", { edits: false }), /add it to/);
  assert.match(aboutMePrompt("", { edits: true }), /doesn't exist yet/);
  assert.equal(aboutMePrompt("", { edits: false }), "");
  const long = aboutMePrompt("x".repeat(MAX_ABOUT_ME_CHARS + 500), { edits: true });
  assert.ok(long.length < MAX_ABOUT_ME_CHARS + 600);
  assert.match(long, /\[cut: the note is longer/);
});

test("a texted turn is told what the note says, and to keep it", async () => {
  const ai = fakeAi("Hey.");
  await runTurn({
    question: "yo",
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    tools: [WRITE],
    callTool: async () => ({ content: [] }),
    env: { AI: ai, AGENT_BUILTIN_MODEL: MODEL },
    providerOptions: { ai },
    texting: true,
    aboutMe: "- Goes by Mo.",
  });
  const system = ai.calls[0].input.messages.find((message) => message.role === "system").content;
  assert.match(system, /Goes by Mo\./);
  assert.match(system, /add it to tex\/about-me\.md/);
});
