/**
 * A job started from a voice message is asked what the person said aloud
 * (2026-11-05: the Morocco trip job was started from a voice-only text, so it
 * was handed an empty question, and the gateway refused every one of its ten
 * parts in eight seconds). The turn that starts it hands the Worker the heard
 * words (`heardWords.js`) beside the jobs (`background.js` `startedJobs`).
 *
 * Breaks if reverted:
 *  - `heardWords` returning "" or taking a carried file's words → "the words heard this turn";
 *  - `startedJobs` dropping `heard` → "the jobs carry them".
 */
import assert from "node:assert/strict";
import test from "node:test";
import { heardWords, MAX_HEARD_CHARS } from "../src/agent/heardWords.js";
import { backgroundSession, START_JOB_TOOL, startedJobs, withBackground } from "../src/agent/background.js";

const SAID = "Research the wedding in Morocco: the times, what to wear, and a packing list.";
const voice = { name: "Audio_Message.caf", mediaType: "audio/x-caf", text: SAID, heard: true };

test("the words heard this turn, and only those", () => {
  assert.equal(heardWords([voice]), SAID);
  assert.equal(heardWords([voice, { ...voice, text: "and update my calendar." }]), `${SAID} and update my calendar.`);
  assert.equal(heardWords([{ ...voice, carried: true }]), "", "a file from an earlier text is not this turn's ask");
  assert.equal(heardWords([{ name: "a.pdf", mediaType: "application/pdf", text: "pdf words" }]), "", "a document is not something they said");
  assert.equal(heardWords([{ ...voice, text: "   " }]), "");
  assert.equal(heardWords(undefined), "");
  assert.equal(heardWords([{ ...voice, text: "x".repeat(MAX_HEARD_CHARS + 50) }]).length, MAX_HEARD_CHARS);
});

test("the jobs a turn starts carry what was said aloud", async () => {
  const background = backgroundSession({ running: [], job: null, now: 1 });
  const call = withBackground(background, async () => assert.fail("not a background call"));
  const answer = await call(START_JOB_TOOL, { title: "Morocco trip", brief: "Find the wedding times, the dress code and a packing list." });
  assert.notEqual(answer.isError, true);
  const started = startedJobs(background, false, SAID);
  assert.equal(started.heard, SAID);
  assert.equal(started.jobs.length, 1);
  assert.equal(startedJobs(background, false).heard, undefined, "a typed ask adds nothing");
  const none = backgroundSession({ running: [], job: null, now: 1 });
  assert.deepEqual(startedJobs(none, false, SAID), {}, "no job, no words handed on");
});
