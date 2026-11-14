/**
 * THE MODEL SOCKET (`bench/modelSocket.mjs`; Dev2, 2026-11-13: an examiner session answers the gate's calls, CI checks).
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-11-13):
 *  1. `requestHash` ignoring the request -> "a call is named by exactly what would be sent" fails;
 *  2. replay answering a missing call with an empty reply -> "a replay refuses answers made for other code" fails;
 *  3. `reviewWait` keeping the 8 s timeout when socketed -> "a socketed review waits for the examiner" fails;
 *  4. `gate` letting a socketed run reach an area outside SOCKET_AREAS -> "an area whose calls don't go through the socket is refused" fails;
 *  5. `readExaminerNotes` reading part 1 only -> "a large answer set is split across notes and read back whole" fails.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { reviewWait } from "../review.mjs";
import { ANSWER_WAIT_MS, answerCall, collectAnswers, examinerNote, examinerNotes, examinerPath, modelSocket, NOTE_PART_BYTES, readExaminerNotes, splitAnswers, pendingCalls, readExaminerNote, requestHash, socketRequest, stableJson } from "../modelSocket.mjs";

const RUN = fileURLToPath(new URL("../run.mjs", import.meta.url));
const exec = promisify(execFile);

test("a call is named by exactly what would be sent, whatever order its keys are in", () => {
  assert.equal(stableJson({ b: 1, a: [{ d: 2, c: 3 }] }), stableJson({ a: [{ c: 3, d: 2 }], b: 1 }));
  assert.equal(requestHash("claude", { a: 1, b: 2 }), requestHash("claude", { b: 2, a: 1 }));
  assert.notEqual(requestHash("claude", { a: 1 }), requestHash("claude", { a: 2 }));
  assert.notEqual(requestHash("claude", { a: 1 }), requestHash("workers-ai", { a: 1 }));
});

test("a live call waits for the examiner's answer, and the same call again is answered at once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "socket-"));
  const socket = modelSocket({ BENCH_MODEL_SOCKET: dir }, { pollMs: 5 });
  assert.equal(socket.covers("claude"), true);
  assert.equal(socket.covers("workers-ai"), false, "the judge keeps its real model unless asked");
  const asked = socketRequest(socket)({ model: "claude-haiku", system: "Be brief.", messages: [{ role: "user", text: "hi" }], maxTokens: 50 });
  let pending = [];
  for (let i = 0; i < 200 && pending.length === 0; i += 1) {
    pending = await pendingCalls(dir);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, "claude");
  assert.equal(pending[0].request.system, "Be brief.");
  assert.ok(pending[0].expects.includes("Answer as the model"));
  await answerCall(dir, pending[0].hash, "hello");
  assert.equal((await asked).text, "hello");
  assert.deepEqual(await pendingCalls(dir), []);
  const again = await socketRequest(socket)({ model: "claude-haiku", system: "Be brief.", messages: [{ role: "user", text: "hi" }], maxTokens: 50 });
  assert.equal(again.text, "hello");
  assert.deepEqual(await collectAnswers(dir), { [pending[0].hash]: { text: "hello" } });
});

test("a replay refuses answers made for other code", async () => {
  const dir = await mkdtemp(join(tmpdir(), "replay-"));
  const request = { model: "m", system: null, messages: [], tools: [], maxTokens: null };
  await writeFile(join(dir, "answers.json"), JSON.stringify({ [requestHash("claude", request)]: { text: "yes" } }));
  const socket = modelSocket({ BENCH_MODEL_REPLAY: join(dir, "answers.json") });
  assert.equal((await socket.ask("claude", request)).text, "yes");
  await assert.rejects(socket.ask("claude", { ...request, system: "changed" }), /made for other code/);
});

test("an examiner note carries its answers for one commit only", () => {
  const sha = "a".repeat(40);
  const note = examinerNote({ sha, by: "examiner session", at: "2026-11-13T13:00:00Z", answers: { x: { text: "ok" } } });
  assert.deepEqual(readExaminerNote(note, sha).answers, { x: { text: "ok" } });
  assert.throws(() => readExaminerNote(note, "b".repeat(40)), /not bbbbbbbbbbbb/);
});

test("a review answered through the socket scores as CI scores it again from the answers alone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "review-socket-"));
  const env = { ...process.env, BENCH_MODEL_SOCKET: dir, AI_GATEWAY_TOKEN: "" };
  const live = exec(process.execPath, [RUN, "review", "--set", "from_chats", "--json", join(dir, "live.json")], { env });
  // The examiner: every reply is let go, except the one about the back room, which goes back.
  let answered = 0;
  for (let i = 0; i < 600 && answered < 8; i += 1) {
    for (const call of await pendingCalls(dir)) {
      const sendBack = call.request.messages[0].text.includes("holds 50");
      await answerCall(dir, call.hash, sendBack ? '{"verdict":"send_back","kind":"task","problems":["unsourced"],"feedback":"Nothing read says 50."}' : '{"verdict":"ok","kind":"task"}');
      answered += 1;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await live;
  const liveRows = JSON.parse(await readFile(join(dir, "live.json"), "utf8"));
  assert.equal(liveRows.length, 8);
  assert.deepEqual(liveRows.filter((row) => !row.right).map((row) => row.id).sort(), ["from_chats/failed-search-as-nothing", "from_chats/roster-with-numbers", "from_chats/still-running-after-done"]);
  // CI: no examiner, no key, only the answers.
  await writeFile(join(dir, "answers.json"), JSON.stringify(await collectAnswers(dir)));
  await exec(process.execPath, [RUN, "review", "--set", "from_chats", "--json", join(dir, "replay.json")], { env: { ...process.env, BENCH_MODEL_REPLAY: join(dir, "answers.json"), AI_GATEWAY_TOKEN: "" } });
  assert.deepEqual(JSON.parse(await readFile(join(dir, "replay.json"), "utf8")), liveRows);
});

test("a socketed review waits for the examiner, and an unsocketed one keeps the reviewer's own limit", () => {
  assert.deepEqual(reviewWait(modelSocket({ BENCH_MODEL_SOCKET: "/x" })), { timeoutMs: ANSWER_WAIT_MS });
  assert.deepEqual(reviewWait(null), {});
});

test("an area whose calls don't go through the socket is refused, never quietly sent to the real model", async () => {
  const { gate } = await import("../replayGate.mjs");
  const saved = process.env.BENCH_MODEL_REPLAY;
  process.env.BENCH_MODEL_REPLAY = "/nowhere.json";
  try {
    await assert.rejects(gate({ branch: "b", base: "m", areas: ["tasks"], scratch: "/nowhere", runners: {}, limits: {} }), /tasks area can't be answered by an examiner yet/);
  } finally {
    if (saved === undefined) delete process.env.BENCH_MODEL_REPLAY;
    else process.env.BENCH_MODEL_REPLAY = saved;
  }
});

test("the note command writes the same note publish would, for a session with its own Context connection", async () => {
  const { socketCommand } = await import("../modelSocket.mjs");
  const dir = await mkdtemp(join(tmpdir(), "note-"));
  const sha = "c".repeat(40);
  await socketCommand({ job: "note", dir, sha, by: "examiner", out: join(dir, "note.md") }, { write: () => {} });
  assert.deepEqual(readExaminerNote(await readFile(join(dir, "note.md"), "utf8"), sha).answers, {});
});

test("a large answer set is split across notes and read back whole", async () => {
  // The core area's 371 answers made a 173 KB note, which a session's Context connector refused (2026-11-13, #3268).
  const sha = "d".repeat(40);
  const answers = Object.fromEntries(Array.from({ length: 371 }, (_, i) => [requestHash("claude", { i }), { text: `answer ${i} `.repeat(40) }]));
  const notes = examinerNotes({ sha, by: "examiner", at: "2026-11-13T23:00:00Z", answers });
  assert.ok(notes.length > 1, "it needs more than one note");
  for (const note of notes) assert.ok(Buffer.byteLength(note.content) < NOTE_PART_BYTES + 1000, `${note.path} fits one note`);
  assert.deepEqual(notes.map((note) => note.path).slice(0, 2), [examinerPath(sha), `ai/results/examiner/${sha}-2.md`]);
  const byPath = new Map(notes.map((note) => [note.path, note.content]));
  const read = (n) => byPath.get(examinerPath(sha, n)) ?? null;
  assert.deepEqual((await readExaminerNotes(read, sha)).answers, answers);
  // A missing part, or a part from another publish, is refused, never scored short.
  await assert.rejects(readExaminerNotes((n) => (n === 2 ? null : read(n)), sha), /missing part 2 of/);
  const other = examinerNotes({ sha, by: "examiner", at: "2026-11-13T23:30:00Z", answers });
  await assert.rejects(readExaminerNotes((n) => (n === 2 ? other[1].content : read(n)), sha), /from another set/);
  // A small set stays one note, as before.
  assert.equal(examinerNotes({ sha, at: "t", answers: { x: { text: "ok" } } }).length, 1);
  assert.throws(() => splitAnswers({ x: { text: "y".repeat(100) } }, 50), /alone is/);
});

test("the note command writes one file a part, named after --out", async () => {
  const { socketCommand } = await import("../modelSocket.mjs");
  const dir = await mkdtemp(join(tmpdir(), "notes-"));
  const sha = "e".repeat(40);
  await mkdir(join(dir, "answers"));
  for (let i = 0; i < 120; i += 1) await writeFile(join(dir, "answers", `${requestHash("claude", { i })}.json`), JSON.stringify({ text: "z".repeat(600) }));
  const files = await socketCommand({ job: "note", dir, sha, by: "examiner", out: join(dir, "note.md") }, { write: () => {} });
  assert.deepEqual(files.slice(0, 2), [join(dir, "note.md"), join(dir, "note-2.md")]);
  const texts = await Promise.all(files.map((file) => readFile(file, "utf8")));
  const answers = (await readExaminerNotes((n) => texts[n - 1] ?? null, sha)).answers;
  assert.equal(Object.keys(answers).length, 120);
});
