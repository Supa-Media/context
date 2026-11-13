/**
 * THE CORE AREA THROUGH THE MODEL SOCKET (`bench/modelSocket.mjs` `socketSend`, `bench/clock.mjs` stepped clock;
 * Dev2, 2026-11-13, no API credits: an examiner session answers the gate's calls). The texting assistant's turn, its
 * tools, the played person and the judge all post Messages API bodies; an examiner answers each, tool calls included,
 * and CI replays the run from those answers alone. That works only if the run asks the very same things both times.
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-11-13):
 *  1. `run.mjs` dropping `assertAnswered` -> "a replay with one answer missing fails the run" fails (the turn fell back
 *     to another model and the run said ok);
 *  2. `installClock` ignoring `stepped` -> "a stepped clock stands still until an answer moves it" fails;
 *  3. `messagesReply` naming tool calls with a fresh random id -> "a tool call's id is the same every time" fails;
 *  4. `claudeAnswer` taking any tool name -> "an answer may call only the tools offered" fails.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { advanceSteppedClock, installClock } from "../clock.mjs";
import { answerCall, claudeAnswer, collectAnswers, messagesReply, messagesRequest, modelSocket, pendingCalls, requestHash, socketSend } from "../modelSocket.mjs";

const RUN = fileURLToPath(new URL("../run.mjs", import.meta.url));

test("an answer may call only the tools offered, each with an input object", () => {
  const request = { tools: [{ name: "search", input_schema: {} }] };
  assert.deepEqual(claudeAnswer(request, "plain words"), { text: "plain words" });
  assert.deepEqual(claudeAnswer(request, { text: "", toolCalls: [{ name: "search", input: { query: "dentist" } }] }), { text: "", toolCalls: [{ name: "search", input: { query: "dentist" } }] });
  assert.throws(() => claudeAnswer(request, { toolCalls: [{ name: "send_email", input: {} }] }), /offers no tool "send_email"/);
  assert.throws(() => claudeAnswer(request, { toolCalls: [{ name: "search", input: "dentist" }] }), /needs an input object/);
});

test("a tool call's id is the same every time, so the next request hashes the same live and replayed", () => {
  const hash = "a".repeat(64);
  const answer = { text: "Looking.", toolCalls: [{ name: "search", input: { query: "x" } }] };
  const one = messagesReply(hash, answer);
  assert.deepEqual(one, messagesReply(hash, answer));
  assert.deepEqual(one.content.map((block) => block.type), ["text", "tool_use"]);
  assert.equal(one.stop_reason, "tool_use");
  assert.equal(messagesReply(hash, { text: "Done." }).stop_reason, "end_turn");
});

test("a Messages body is named without its metadata, and answered as the Messages API would", async () => {
  const dir = await mkdtemp(join(tmpdir(), "core-socket-"));
  const body = { model: "claude-haiku-5-5", max_tokens: 100, system: "s", messages: [{ role: "user", content: "hi" }], tools: [{ name: "search", input_schema: {} }] };
  const request = messagesRequest(JSON.stringify({ ...body, metadata: { user_id: "u1" } }));
  assert.equal(requestHash("claude", request), requestHash("claude", messagesRequest(JSON.stringify(body))), "metadata is not part of the call");
  const hash = requestHash("claude", request);
  await writeFile(join(dir, "answers.json"), JSON.stringify({ [hash]: { text: "", toolCalls: [{ name: "search", input: { query: "q" } }] } }));
  const send = socketSend(modelSocket({ BENCH_MODEL_REPLAY: join(dir, "answers.json") }));
  const reply = await (await send(JSON.stringify(body))).json();
  assert.deepEqual(reply.content, [{ type: "tool_use", id: `toolu_socket_${hash.slice(0, 16)}_0`, name: "search", input: { query: "q" } }]);
});

test("a stepped clock stands still until an answer moves it, and chance is the same on every run", async () => {
  let first;
  const undo = installClock("2026-10-08", { stepped: true });
  try {
    const at = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(Date.now(), at, "an examiner's minutes never reach the world's clock");
    assert.equal(new Date().toISOString(), "2026-10-08T12:00:00.000Z");
    advanceSteppedClock(3000);
    assert.equal(new Date().toISOString(), "2026-10-08T12:00:03.000Z");
    first = [Math.random(), crypto.randomUUID()];
  } finally {
    undo();
  }
  const again = installClock("2026-10-08", { stepped: true });
  try {
    assert.deepEqual([Math.random(), crypto.randomUUID()], first, "each world rolls the same ids");
  } finally {
    again();
  }
  assert.notEqual(Math.random(), first[0], "the real chance is back");
});

const TEST = [
  "---",
  "run_as: Ana",
  "runs: 1",
  "today: 2026-10-08",
  "played_by: claude-sonnet-5-5",
  "good_enough:",
  "  score: 100%",
  "  price: under $1 a question",
  "  speed: under 90 s",
  "  texts: 4 or fewer",
  "---",
  "",
  "## 1. When is the dentist",
  "",
  "- kind: task",
  '- person starts: "when is the dentist"',
  "- must: say Tuesday 3 pm",
  "",
].join("\n");

async function folder(testText = TEST) {
  const dir = await mkdtemp(join(tmpdir(), "core-socket-bench-"));
  const files = {
    "README.md": "# Bench\n",
    "workspaces/people.md": "| Person | Workspace | Role |\n|---|---|---|\n| Ana | ana (personal) | owner |\n",
    "workspaces/ana/health/dentist.md": "Dentist Tuesday 3 pm\n",
    "tests/core.md": testText,
    "setups/texting-assistant/production.md": "---\njob: texting-assistant\nmodels:\n  main: anthropic/claude-haiku-5-5\n---\n\nYou are a test assistant.\n",
  };
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  return dir;
}

/** `pnpm ai run` in a child process, resolving `{ code, stderr }`. */
function runBench(dir, out, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [RUN, "run", "texting-assistant", "--dir", dir, "--test", "core", "--setups", "production", "--runs", "1", "--out", out], { env: { ...process.env, BENCH_MODEL_SOCKET: "", BENCH_MODEL_REPLAY: "", ...env } }, (error, _stdout, stderr) =>
      resolve({ code: error ? (error.code ?? 1) : 0, stderr }),
    );
  });
}

/** A scripted examiner: searches once when it can, then answers; the played person is done at once. */
async function examine(dir, done) {
  while (!done.value) {
    for (const call of await pendingCalls(dir)) {
      const request = call.request;
      const searched = JSON.stringify(request.messages).includes("tool_result");
      const person = /playing a person/.test(JSON.stringify(request.system ?? ""));
      const canSearch = (request.tools ?? []).some((tool) => tool.name === "search");
      const answer = person ? "DONE" : canSearch && !searched ? { text: "", toolCalls: [{ name: "search", input: { query: "dentist" } }] } : "The dentist is Tuesday at 3 pm.";
      await answerCall(dir, call.hash, answer);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const answersOf = (raw) => raw.split("\n").filter((line) => /Tuesday at 3 pm/.test(line));

test("a core run answered live by an examiner replays from its answers alone, and a missing answer fails it", { timeout: 240_000 }, async () => {
  const dir = await folder();
  const socket = await mkdtemp(join(tmpdir(), "core-socket-dir-"));
  const done = { value: false };
  const examiner = examine(socket, done);
  const live = await runBench(dir, join(dir, "live.md"), { BENCH_MODEL_SOCKET: socket });
  done.value = true;
  await examiner;
  assert.equal(live.code, 0, live.stderr);
  assert.match(live.stderr, /through the model socket \(socket\)/);

  const answers = await collectAnswers(socket);
  const calls = Object.values(answers);
  assert.ok(calls.some((answer) => answer.toolCalls?.length), "the turn called a tool and was answered with its result");
  await writeFile(join(dir, "answers.json"), JSON.stringify(answers));
  const replay = await runBench(dir, join(dir, "replay.md"), { BENCH_MODEL_REPLAY: join(dir, "answers.json") });
  assert.equal(replay.code, 0, replay.stderr);
  assert.deepEqual(answersOf(await readFile(join(dir, "replay.md"), "utf8")), answersOf(await readFile(join(dir, "live.md"), "utf8")), "the replay gave the live run's answer");

  const cut = { ...answers };
  delete cut[Object.keys(cut).find((hash) => answers[hash].toolCalls?.length)];
  await writeFile(join(dir, "cut.json"), JSON.stringify(cut));
  const missing = await runBench(dir, join(dir, "cut.md"), { BENCH_MODEL_REPLAY: join(dir, "cut.json") });
  assert.notEqual(missing.code, 0, "a turn that fell back for a missing answer is never scored");
  assert.match(missing.stderr, /had no examiner answer for \d+ call/);
});

test("a socketed run refuses a test that pins no day", { timeout: 60_000 }, async () => {
  const dir = await folder(TEST.replace("today: 2026-10-08\n", ""));
  const run = await runBench(dir, join(dir, "out.md"), { BENCH_MODEL_REPLAY: join(dir, "none.json") });
  assert.notEqual(run.code, 0);
  assert.match(run.stderr, /pins no day/);
});
