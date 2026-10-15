/**
 * TEX'S JOBS ARE TASK NOTES PEOPLE CAN SEE (owner, 2026-10-14).
 *
 * A job of several steps is a task note in the right workspace's projects
 * folder (status, owner "@maya's Tex", a checklist), so it shows on that
 * project's board; `tex/jobs.md` lists the open ones and is read into every
 * texted turn, so the next text picks a job up where it stopped.
 *
 * ## Sabotage record
 *
 *   `readTexNotes` not reading tex/jobs.md
 *     → "a texted turn reads its about-me and its jobs, side by side" fails
 *   `runTurn` dropping `jobs` from the system prompt
 *     → "a texted turn is told its open jobs and how to keep them" fails
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BUILTIN_PROVIDER } from "../src/agent/builtin.js";
import { ABOUT_ME_PATH } from "../src/agent/aboutMe.js";
import { JOBS_PATH, MAX_JOBS_LINES, jobsPrompt, readTexNotes } from "../src/agent/jobs.js";
import { runTurn } from "../src/agent/turn.js";

const MODEL = "@cf/zai-org/glm-4.7-flash";
const WRITE = { name: "write_note", description: "Write a note.", inputSchema: { type: "object", properties: {} } };
const JOB = "- [Plan the Lisbon trip](@maya/1-projects/lisbon/plan-the-trip.md)";

const READ_RESULT = (path, body) => ({
  content: [{ type: "text", text: `etag: e1\npath: ${path}\nvisibility: private\ndocument_id: doc-1\n\n${body}` }],
});

test("a texted turn reads its about-me and its jobs, side by side", async () => {
  const asked = [];
  const notes = await readTexNotes(async (name, args) => {
    asked.push(args.path);
    return args.path === JOBS_PATH ? READ_RESULT(JOBS_PATH, JOB) : READ_RESULT(ABOUT_ME_PATH, "- Goes by Mo.");
  });
  assert.deepEqual(asked.sort(), [JOBS_PATH, ABOUT_ME_PATH].sort());
  assert.deepEqual(notes, { aboutMe: "- Goes by Mo.", jobs: JOB });
  assert.deepEqual(await readTexNotes(async () => { throw new Error("down"); }), { aboutMe: "", jobs: "" });
});

test("the prompt says how a job becomes a task note, and lists the open ones", () => {
  const none = jobsPrompt("", { edits: true });
  assert.match(none, /is a task note, so they can watch it on their board/);
  assert.match(none, /owner: their handle's Tex/);
  assert.match(none, /tex\/jobs\.md/);
  assert.doesNotMatch(none, /Your open jobs/);
  const open = jobsPrompt(JOB, { edits: true });
  assert.match(open, /Your open jobs, from tex\/jobs\.md/);
  assert.match(open, /Plan the Lisbon trip/);
  assert.equal(jobsPrompt(JOB, { edits: false }), "");
  const long = jobsPrompt(Array.from({ length: MAX_JOBS_LINES + 5 }, (_, i) => `- job ${i}`).join("\n"), { edits: true });
  assert.match(long, /\[cut: 5 more lines; tidy the list\]/);
});

test("a texted turn is told its open jobs and how to keep them", async () => {
  const calls = [];
  const ai = {
    async run(model, input) {
      calls.push(input);
      return { choices: [{ message: { content: "On it." } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    },
  };
  await runTurn({
    question: "carry on with lisbon",
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    tools: [WRITE],
    callTool: async () => ({ content: [] }),
    env: { AI: ai, AGENT_BUILTIN_MODEL: MODEL },
    providerOptions: { ai },
    texting: true,
    jobs: JOB,
  });
  const system = calls[0].messages.find((m) => m.role === "system")?.content ?? "";
  assert.match(system, /Your open jobs, from tex\/jobs\.md/);
  assert.match(system, /plan-the-trip\.md/);
});
