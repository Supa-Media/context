/**
 * A job started from a voice message is asked what the person said aloud
 * (2026-11-05: the Morocco trip job was started from a voice-only text, so it
 * was handed an empty question, and the gateway refused every one of its ten
 * parts in eight seconds). The turn that starts it hands the Worker the heard
 * words (`heardWords.js`) beside the jobs (`background.js` `startedJobs`).
 *
 * Breaks if reverted:
 *  - `heardWords` returning "" or taking a carried file's words → "the words heard this turn";
 *  - `startedJobs` dropping `heard` → "the jobs a turn starts carry what was said aloud";
 *  - `startedJobs` handing words only to new jobs → "a job this text restarts gets what was said and sent";
 *  - `sentLine` naming nothing, or a voice message as a file → "the files sent with this text, named for a job".
 *
 * Bug hunt, 2026-11-05: a change texted to a running job as a voice message or a picture never reached it,
 * and a job never saw a picture sent with its ask.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { heardWords, MAX_HEARD_CHARS, sentLine } from "../src/agent/heardWords.js";
import { backgroundSession, RESTART_JOB_TOOL, START_JOB_TOOL, startedJobs, withBackground } from "../src/agent/background.js";

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
  const started = startedJobs(background, false, { heard: SAID });
  assert.equal(started.heard, SAID);
  assert.equal(started.jobs.length, 1);
  assert.equal(startedJobs(background, false).heard, undefined, "a typed ask adds nothing");
  const none = backgroundSession({ running: [], job: null, now: 1 });
  assert.deepEqual(startedJobs(none, false, { heard: SAID, sent: "[Sent with this text: a.png.]" }), {}, "no job, no words handed on");
});

const PICTURE_LINE = "[Sent with this text: IMG_1.png (image IMG_1.png in tex/pictures/2026-11-05.md). read_image with that note and image shows it again.]";

test("the files sent with this text, named for a job", () => {
  const picture = { name: "IMG_1.png", mediaType: "image/png", data: "AAAA" };
  assert.equal(sentLine([picture], `${PICTURE_LINE}\n[Voice message v.caf: "hi"]`), PICTURE_LINE, "the line, without the voice words heard already");
  assert.equal(sentLine([voice], `[Sent with this text: v.caf.]\n[Voice message v.caf: "hi"]`), "", "a voice message alone is its words, not a file");
  assert.equal(sentLine([{ ...picture, carried: true }], PICTURE_LINE), "", "a file from an earlier text was named then");
  assert.equal(sentLine([], ""), "");
});

test("a job this text restarts gets what was said and sent", async () => {
  const stopped = { id: "job-moroccotrip-0001", title: "Morocco trip", state: "failed", startedAt: 1, finishedAt: 2, steps: [], verdict: null, advice: "", result: "", status: "" };
  const background = backgroundSession({ running: [stopped], job: null, now: 3 });
  const call = withBackground(background, async () => ({ content: [] }));
  await call(RESTART_JOB_TOOL, {});
  assert.deepEqual(startedJobs(background, false, { heard: SAID, sent: PICTURE_LINE }), { steers: [{ id: stopped.id, resume: true }], heard: SAID, sent: PICTURE_LINE });
});
