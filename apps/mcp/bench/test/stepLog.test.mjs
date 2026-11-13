/**
 * THE STEP LOG (`bench/stepLog.mjs`, `bench/labNodes.mjs`; the Tex Architecture Lab reads it to know what each model
 * call cost and which step made it).
 *
 * Why the first tests read the repository: `NODE_SIGNS` names a Lab step by a phrase copied out of that step's prompt.
 * A prompt rewrite that drops the phrase would not fail anything at run time; the call would quietly land on "?" and
 * the Lab would score the wrong step. So every phrase is found in its real source file here, and the test fails in CI.
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-11-13):
 *  1. a `NODE_SIGNS` phrase changed to text no source file holds -> "every node's phrase is in its source file" fails;
 *  2. `stepLog` writing a fingerprint run's calls -> "a fingerprint run writes nothing" fails;
 *  3. `labAi` sending the embeddings to the socket too -> "in a Lab run a Workers AI call asks to be run for real
 *     through Context, and the embeddings stay on the stand-in" fails.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { NODE_SIGNS, labNodeFor } from "../labNodes.mjs";
import { stepLine } from "../stepLog.mjs";
import { REAL_EXPECTS, answerCall, labAi, modelSocket, pendingCalls, requestHash, socketAi, stableJson } from "../modelSocket.mjs";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));

/** Every Lab step a model call can belong to, as the Lab config names them. */
const EXPECTED_NODES = ["fd", "planner", "advisor", "jobcheck", "mailadv", "mail", "card", "reviewer", "classifier", "selfreview", "job", "handback", "decide", "router", "bench:person", "bench:judge"];

/** A Workers AI question is declared as `name: {` or `name = {` in its file, never as a bare word in a sentence. */
const declaresQuestion = (source, name) => new RegExp(`\\b${name}\\s*[:=]`).test(source);

const workersAi = (questions) => ({ model: "@cf/cloudflare/clef", input: { model: "clef", state: "newest", questions } });

test("every node's phrase is in its real source file (a prompt rewrite that drops it fails here, not silently in the Lab)", () => {
  for (const sign of NODE_SIGNS) {
    const source = readFileSync(join(REPO, sign.file), "utf8");
    const found = sign.kind === "workers-ai" ? declaresQuestion(source, sign.phrase) : source.includes(sign.phrase);
    assert.ok(found, `${sign.node}: "${sign.phrase}" is not in ${sign.file}`);
  }
});

test("every Lab step a call can belong to has at least one sign, and the table names no others", () => {
  const nodes = new Set(NODE_SIGNS.map((sign) => sign.node));
  for (const node of EXPECTED_NODES) assert.ok(nodes.has(node), `no sign for ${node}`);
  for (const node of nodes) assert.ok(EXPECTED_NODES.includes(node), `unexpected node ${node}`);
});

test("a call names its step from what is sent: the system prompt for Claude, the question names for Workers AI", () => {
  assert.equal(labNodeFor("claude", { system: "You check one email before a person is asked to approve it. Go." }), "mail");
  assert.equal(labNodeFor("claude", { system: { stable: "x", context: "You are playing a person texting their notes assistant, in a test." } }), "bench:person");
  assert.equal(labNodeFor("claude", { system: [{ type: "text", text: "You grade answers from a notes assistant against a checklist." }] }), "bench:judge");
  assert.equal(labNodeFor("workers-ai", workersAi({ moved_on: {}, act: {} })), "decide");
  assert.equal(labNodeFor("workers-ai", workersAi({ tier: {} })), "router");
  assert.equal(labNodeFor("claude", { system: "a prompt nobody has named" }), "?");
  assert.equal(labNodeFor("workers-ai", workersAi({ unnamed_question: {} })), "?");
});

test("the more specific step wins: a background job's turn is the job, not the front door it was built from", () => {
  const system = [
    "You are Tex, the assistant built into Context (context.lc).",
    "This turn is a text message they sent you from their phone.",
    "This turn is a background job you started from their text: \"book the table\".",
  ].join("\n");
  assert.equal(labNodeFor("claude", { system }), "job");
});

test("a front door turn with a production identity is still named by the line every texting turn carries", () => {
  assert.equal(labNodeFor("claude", { system: "Be friendly.\n\nThis turn is a text message they sent you from their phone.\n" }), "fd");
});

/** Makes a socket that answers from a recorded map, with the step log on at `log`. */
function replaySocket(dir, answers, env = {}) {
  const answersFile = join(dir, "answers.json");
  writeFileSync(answersFile, JSON.stringify(answers));
  return modelSocket({ BENCH_MODEL_REPLAY: answersFile, BENCH_STEP_LOG: join(dir, "steps.jsonl"), ...env });
}

const readLines = (file) => readFileSync(file, "utf8").split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));

const ADVISOR_REQUEST = {
  model: "anthropic/claude-opus-5-5",
  system: "It has paused to ask you for advice. Tex is asking.",
  messages: [{ role: "user", text: "what now?" }],
  tools: [{ name: "search", description: "find a note" }],
  maxTokens: 300,
};

test("a socket call with BENCH_STEP_LOG writes one parseable line with the step, sizes, text and side", async () => {
  const dir = mkdtempSync(join(tmpdir(), "steplog-"));
  const branch = process.cwd();
  const socket = replaySocket(dir, { [requestHash("claude", ADVISOR_REQUEST)]: { text: "Check the dentist note first.", thinking: "weighing it" } }, { BENCH_LAB_BRANCH: branch });
  const answer = await socket.ask("claude", ADVISOR_REQUEST);
  assert.deepEqual(answer, { text: "Check the dentist note first.", thinking: "weighing it" }, "the call's answer is the one the socket gave");
  const lines = readLines(join(dir, "steps.jsonl"));
  assert.equal(lines.length, 1);
  const [line] = lines;
  assert.equal(line.node, "advisor");
  assert.equal(line.model, "anthropic/claude-opus-5-5");
  assert.equal(line.kind, "claude");
  assert.equal(line.est, true);
  assert.equal(line.ok, true);
  assert.equal(line.side, "branch");
  assert.equal(line.hash, requestHash("claude", ADVISOR_REQUEST).slice(0, 12));
  assert.equal(line.output, "Check the dentist note first.");
  assert.equal(line.thinking, "weighing it");
  assert.deepEqual(line.steps, []);
  assert.equal(line.in, Math.ceil((stableJson(ADVISOR_REQUEST.system) + stableJson(ADVISOR_REQUEST.messages) + stableJson(ADVISOR_REQUEST.tools)).length / 4));
  assert.equal(line.out, Math.ceil("Check the dentist note first.".length / 4));
  assert.equal(typeof line.ms, "number");
  assert.ok(line.ms >= 0);
});

test("the steps a call made are its tool calls, and out counts them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "steplog-tools-"));
  const answer = { text: "", toolCalls: [{ name: "search", input: { query: "dentist" } }] };
  const socket = replaySocket(dir, { [requestHash("claude", ADVISOR_REQUEST)]: answer });
  await socket.ask("claude", ADVISOR_REQUEST);
  const [line] = readLines(join(dir, "steps.jsonl"));
  assert.deepEqual(line.steps, [{ name: "search", input: { query: "dentist" } }]);
  assert.equal(line.out, Math.ceil(stableJson(answer.toolCalls).length / 4));
});

test("a Workers AI call is logged with its answer as stable JSON, and kind workers-ai", async () => {
  const dir = mkdtempSync(join(tmpdir(), "steplog-ai-"));
  const request = workersAi({ moved_on: { instructions: "Has the talk moved on?" } });
  const answer = { moved_on: { choice: "false", confidence: 0.9 } };
  const socket = replaySocket(dir, { [requestHash("workers-ai", request)]: answer });
  assert.deepEqual(await socket.ask("workers-ai", request), answer);
  const [line] = readLines(join(dir, "steps.jsonl"));
  assert.equal(line.node, "decide");
  assert.equal(line.kind, "workers-ai");
  assert.equal(line.output, stableJson(answer));
  assert.equal(line.out, Math.ceil(stableJson(answer).length / 4));
});

test("a missed call writes ok:false with empty output, and the miss still reaches the caller unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "steplog-miss-"));
  const socket = replaySocket(dir, {});
  await assert.rejects(socket.ask("claude", ADVISOR_REQUEST), /no examiner answer for claude call/);
  assert.equal(socket.missed.length, 1, "the socket still counts the miss for the run");
  const [line] = readLines(join(dir, "steps.jsonl"));
  assert.equal(line.ok, false);
  assert.equal(line.output, "");
  assert.equal(line.node, "advisor");
  assert.deepEqual(line.steps, []);
});

test("side is main when the process runs outside BENCH_LAB_BRANCH, and branch when the variable is unset", async () => {
  const dir = mkdtempSync(join(tmpdir(), "steplog-side-"));
  const answers = { [requestHash("claude", ADVISOR_REQUEST)]: { text: "ok" } };
  await replaySocket(dir, answers, { BENCH_LAB_BRANCH: "/somewhere/else/entirely" }).ask("claude", ADVISOR_REQUEST);
  await replaySocket(dir, answers).ask("claude", ADVISOR_REQUEST);
  const [main, branch] = readLines(join(dir, "steps.jsonl"));
  assert.equal(main.side, "main");
  assert.equal(branch.side, "branch");
});

test("a log that cannot be written (its path is a directory) leaves the call's answer unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "steplog-fail-"));
  const logAsDirectory = join(dir, "is-a-folder");
  mkdirSync(logAsDirectory);
  const answers = { [requestHash("claude", ADVISOR_REQUEST)]: { text: "still answered" } };
  const socket = modelSocket({ BENCH_MODEL_REPLAY: writeAnswers(dir, answers), BENCH_STEP_LOG: logAsDirectory });
  assert.equal((await socket.ask("claude", ADVISOR_REQUEST)).text, "still answered");
  assert.equal(socket.missed.length, 0);
});

function writeAnswers(dir, answers) {
  const file = join(dir, "answers-for-fail.json");
  writeFileSync(file, JSON.stringify(answers));
  return file;
}

test("a fingerprint run writes nothing to the step log", async () => {
  const dir = mkdtempSync(join(tmpdir(), "steplog-fp-"));
  const socket = modelSocket({ BENCH_MODEL_FINGERPRINT: join(dir, "fingerprint.jsonl"), BENCH_STEP_LOG: join(dir, "steps.jsonl") });
  assert.equal((await socket.ask("claude", ADVISOR_REQUEST)).text, "Fingerprint run: no answer.");
  assert.equal(existsSync(join(dir, "steps.jsonl")), false, "no step log is created by a fingerprint run");
});

test("without BENCH_STEP_LOG the socket behaves as before and writes no file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "steplog-off-"));
  const answersFile = writeAnswers(dir, { [requestHash("claude", ADVISOR_REQUEST)]: { text: "plain" } });
  const socket = modelSocket({ BENCH_MODEL_REPLAY: answersFile });
  assert.equal((await socket.ask("claude", ADVISOR_REQUEST)).text, "plain");
  assert.equal(existsSync(join(dir, "steps.jsonl")), false);
});

test("a main worktree nested inside the branch's checkout is still main", () => {
  const branch = process.cwd();
  const line = stepLine({ env: { BENCH_LAB_BRANCH: join(branch, ".."), BENCH_LAB_MAIN: branch }, kind: "claude", request: ADVISOR_REQUEST, answer: { text: "x" }, ms: 1, ok: true });
  assert.equal(line.side, "main");
  assert.equal(stepLine({ env: { BENCH_LAB_BRANCH: branch, BENCH_LAB_MAIN: join(branch, "elsewhere") }, kind: "claude", request: ADVISOR_REQUEST, answer: { text: "x" }, ms: 1, ok: true }).side, "branch");
});

test("GLM on Workers AI is the fallback step; a model nobody names is ?", () => {
  assert.equal(labNodeFor("workers-ai", { model: "@cf/zai-org/glm-4.7-flash", input: { messages: [] } }), "fallback");
  assert.equal(labNodeFor("workers-ai", { model: "@cf/other/model", input: {} }), "?");
});

test("in a Lab run a Workers AI call asks to be run for real through Context, and the embeddings stay on the stand-in", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lab-real-"));
  const socket = modelSocket({ BENCH_MODEL_SOCKET: dir, BENCH_MODEL_SOCKET_KINDS: "claude,workers-ai", BENCH_LAB_REAL_MODELS: "1" }, { pollMs: 5, waitMs: 2000 });
  const embedded = [];
  const ai = labAi(socketAi(socket), { run: async (model, input) => (embedded.push(model), { data: [[0]] }) });
  await ai.run("@cf/baai/bge-m3", { text: ["hi"] });
  assert.deepEqual(embedded, ["@cf/baai/bge-m3"]);
  const asked = ai.run("@cf/cloudflare/clef", { model: "clef", state: "s", questions: { tier: {} } });
  let pending = [];
  for (let i = 0; i < 200 && pending.length === 0; i += 1) {
    pending = await pendingCalls(dir);
    await new Promise((done) => setTimeout(done, 5));
  }
  assert.equal(pending.length, 1);
  assert.equal(pending[0].expects, REAL_EXPECTS);
  assert.match(pending[0].expects, /run_model/);
  await answerCall(dir, pending[0].hash, { answers: { tier: { choice: "lookup", confidence: 0.9 } } });
  assert.deepEqual(await asked, { answers: { tier: { choice: "lookup", confidence: 0.9 } } });
});
