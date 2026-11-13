/**
 * THE MODEL SOCKET: the replay gate without API credits (Dev2, 2026-11-13:
 * "spawn a sub-agent that essentially runs the entire harness and acts as the
 * harness ... have it upload its results and then the CI/CD just checks the
 * results"; chose "Separate examiner session").
 *
 * A bench command asks its model through here when one of two variables is set:
 *
 *   BENCH_MODEL_SOCKET=<dir>   live: each call is written to <dir>/calls/<hash>.json
 *                              and waits for <dir>/answers/<hash>.json, which an
 *                              examiner session writes (`pnpm ai socket next|answer`).
 *   BENCH_MODEL_REPLAY=<file>  replay: each call is answered from a recorded
 *                              { hash: answer } map, and a call with no answer
 *                              fails the run: the answers are not for this code.
 *
 * A call is named by the hash of exactly what the harness would send, so CI
 * rebuilds every request from the commit under test and finds the examiner's
 * answer for it, then scores in its own code. The score is CI's; only the
 * model's words come from the examiner. A request asked twice (a rerun, or the
 * same case on main) is answered once, so one examiner answer stands for the
 * model and a case regresses only when the change's request is answered wrong
 * and main's right.
 *
 * What this cannot prove is that a model wrote the answers. The examiner is a
 * separate session that never sees the change (`docs/decisions/testing/replay-gate.md`,
 * "Examiner"), and the nightly asks the real models a sample of the same calls.
 */
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { advanceSteppedClock } from "./clock.mjs";

export const SOCKET_ENV = "BENCH_MODEL_SOCKET";
export const REPLAY_ENV = "BENCH_MODEL_REPLAY";
/**
 * Which kinds of call go through the socket: Claude's by default, the calls API credits pay for. The judge (Clef on
 * Workers AI, a fraction of a cent a run) keeps its real model unless "workers-ai" is listed too, because a stand-in
 * for a small classifier measures the stand-in.
 */
export const KINDS_ENV = "BENCH_MODEL_SOCKET_KINDS";
/**
 * PROMPT FINGERPRINTS (Dev2, 2026-11-13: "even if it's a letter different, we need to check that"; chose "Prompt
 * fingerprints"). `BENCH_MODEL_FINGERPRINT=<file>`: every call, of every kind, is hashed exactly as the socket names
 * it and the hash appended to <file> as a JSON line; a Claude call gets a fixed stand-in answer and any other call is
 * refused, so a run costs nothing and needs no key. What is hashed is every prompt a case's run builds from its first
 * on, by the commit's own code:
 * one byte of a prompt, a module's order or a tool's description changed, and the area's fingerprint changes
 * (`promptFingerprint.mjs`).
 */
export const FINGERPRINT_ENV = "BENCH_MODEL_FINGERPRINT";
/** What a fingerprint run answers every Claude call with. */
export const FINGERPRINT_ANSWER = Object.freeze({ text: "Fingerprint run: no answer." });
/** How long a live call waits for its answer before the case counts as no answer. */
export const ANSWER_WAIT_MS = 45 * 60 * 1000;
/**
 * How far a stepped clock (`clock.mjs`) moves on for each answered call, the
 * same live and replayed: a conversation's times move forward the way they
 * would, and never by how long the examiner took.
 */
export const ANSWER_STEP_MS = 3000;

/** JSON with every object's keys sorted, so one request always hashes the same. */
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The name of one call: `kind` ("claude" or "workers-ai") and exactly what would be sent. */
export const requestHash = (kind, request) => createHash("sha256").update(`${kind}\n${stableJson(request)}`).digest("hex");

/** What the examiner must answer with, by kind: the shape the harness reads back. */
export const EXPECTS = {
  claude:
    'Answer as the model named in "model" would, given "system" and "messages": write only the reply text it would send, in the format its system prompt asks for. ' +
    'Where "tools" are offered and it would call some, answer with --json (or --json-file) \'{"text": "<words before the calls, or empty>", "toolCalls": [{"name": "<a tool offered>", "input": { ... }}]}\': the results come back as the next call.',
  "workers-ai": 'Answer as the classifier would: a JSON object { "answers": { <question>: { "choice": <one of its choices>, "confidence": <0..1> } } } for every question in input.questions, reading input.state.',
};

/** Sleeps without letting the event loop run: nothing else in the process moves while it waits. */
const sleepBlocking = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function readJsonNow(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined; // half written: read again on the next poll
  }
}

/**
 * The socket a bench command uses, or null when neither variable is set (the real models answer).
 *
 * `blocking` waits for a live answer with the whole process held still (the texting assistant's runs and their judge,
 * `run.mjs`): a turn's own timers (the reviewer's 8 s, the advisor's 40 s, a tool's) cannot run out while the examiner
 * thinks, so a turn takes the path it takes replayed, where every answer is instant. Every answer, live or replayed,
 * moves a stepped clock on by `ANSWER_STEP_MS`.
 */
export function modelSocket(env = process.env, { wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), waitMs = ANSWER_WAIT_MS, pollMs = 500, blocking = false } = {}) {
  const kinds = new Set(String(env[KINDS_ENV] || "claude").split(",").map((kind) => kind.trim()).filter(Boolean));
  const covers = (kind) => kinds.has(kind);
  // Every call left with no answer. The code that asked may well survive one (a turn falls back to another model, a
  // reviewer's silence lets a draft through), so a run reads this at its end and fails rather than score that path.
  const missed = [];
  const miss = (message) => {
    missed.push(message);
    return new Error(message);
  };
  if (env[FINGERPRINT_ENV]) {
    const file = env[FINGERPRINT_ENV];
    return {
      mode: "fingerprint",
      covers: () => true,
      missed,
      async ask(kind, request) {
        const hash = requestHash(kind, request);
        appendFileSync(file, `${JSON.stringify({ kind, hash })}\n`);
        // A Claude call is answered with the same stand-in words every time, so a conversation goes on the way it
        // always does from there (a played person's next text, a reviewer's read), and those prompts are hashed too.
        // Anything else is refused, which every caller already survives. The clock never moves.
        if (kind === "claude") return FINGERPRINT_ANSWER;
        throw new Error(`fingerprint run: ${kind} call ${hash.slice(0, 12)} recorded, not answered`);
      },
    };
  }
  if (env[REPLAY_ENV]) {
    let answers = null;
    return {
      mode: "replay",
      covers,
      missed,
      async ask(kind, request) {
        answers ??= JSON.parse(await readFile(env[REPLAY_ENV], "utf8"));
        const hash = requestHash(kind, request);
        if (!(hash in answers)) throw miss(`no examiner answer for ${kind} call ${hash.slice(0, 12)}: the answers were made for other code`);
        advanceSteppedClock(ANSWER_STEP_MS);
        return answers[hash];
      },
    };
  }
  if (env[SOCKET_ENV]) {
    const dir = env[SOCKET_ENV];
    return {
      mode: "socket",
      covers,
      missed,
      async ask(kind, request) {
        const hash = requestHash(kind, request);
        const answerFile = join(dir, "answers", `${hash}.json`);
        const answered = (answer) => {
          advanceSteppedClock(ANSWER_STEP_MS);
          return answer;
        };
        const have = await readJson(answerFile);
        if (have !== undefined) return answered(have);
        await mkdir(join(dir, "calls"), { recursive: true });
        await writeFile(join(dir, "calls", `${hash}.json`), JSON.stringify({ hash, kind, expects: EXPECTS[kind], request }), { flag: "w" });
        for (let waited = 0; waited < waitMs; waited += pollMs) {
          const answer = blocking ? readJsonNow(answerFile) : await readJson(answerFile);
          if (answer !== undefined) return answered(answer);
          if (blocking) sleepBlocking(pollMs);
          else await wait(pollMs);
        }
        throw miss(`no examiner answer for ${kind} call ${hash.slice(0, 12)} in ${Math.round(waitMs / 60000)} min`);
      },
    };
  }
  return null;
}

async function readJson(file) {
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined; // half written: read again on the next poll
  }
}

/** The calls still waiting for an answer, oldest file name first. */
export async function pendingCalls(dir) {
  const calls = (await readdir(join(dir, "calls")).catch(() => [])).filter((name) => name.endsWith(".json")).sort();
  const answered = new Set(await readdir(join(dir, "answers")).catch(() => []));
  const pending = [];
  for (const name of calls) if (!answered.has(name)) pending.push(JSON.parse(await readFile(join(dir, "calls", name), "utf8")));
  return pending;
}

/** Write the examiner's answer to one waiting call: `text` for a Claude call, a JSON object for a classifier. */
export async function answerCall(dir, hash, answer) {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("a call is named by its 64-character hash");
  const call = await readJson(join(dir, "calls", `${hash}.json`));
  if (call === undefined) throw new Error(`no waiting call ${hash.slice(0, 12)}`);
  const value = call.kind === "claude" ? claudeAnswer(call.request, answer) : typeof answer === "string" ? JSON.parse(answer) : answer;
  await mkdir(join(dir, "answers"), { recursive: true });
  // Written whole under another name and renamed would be atomic; a half-read file is skipped by `readJson` instead.
  await writeFile(join(dir, "answers", `${hash}.json`), JSON.stringify(value));
  return call.kind;
}

/** Throws when the socket had no answer for some call: what the code did instead is not the model's answer to score. */
export function assertAnswered(socket, what = "the run") {
  if (socket?.missed?.length) throw new Error(`${what} had no examiner answer for ${socket.missed.length} call(s), so its result is not scored: ${socket.missed[0]}`);
}

/** Every answer the examiner gave, as the { hash: answer } map a replay reads. */
export async function collectAnswers(dir) {
  const out = {};
  for (const name of (await readdir(join(dir, "answers")).catch(() => [])).filter((file) => file.endsWith(".json")).sort()) {
    out[name.slice(0, -5)] = JSON.parse(await readFile(join(dir, "answers", name), "utf8"));
  }
  return out;
}

const toolName = (tool) => (typeof tool === "string" ? tool : tool?.name);

/**
 * A Claude answer as kept: `{ text }`, or `{ text, toolCalls: [{ name, input }] }` when it calls tools. `answer` is the
 * reply text, or that object (or its JSON). A call to a tool the request did not offer is refused here, while the
 * examiner can still fix it.
 */
export function claudeAnswer(request, answer) {
  const given = typeof answer === "string" ? { text: answer } : answer ?? {};
  const text = String(given.text ?? "");
  const calls = Array.isArray(given.toolCalls) ? given.toolCalls : [];
  if (calls.length === 0) return { text };
  const offered = new Set((request?.tools ?? []).map(toolName));
  const toolCalls = calls.map((call) => {
    const name = String(call?.name ?? "");
    if (!offered.has(name)) throw new Error(`the call offers no tool "${name}"`);
    const input = call?.input ?? call?.args ?? {};
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`tool call "${name}" needs an input object`);
    return { name, input };
  });
  return { text, toolCalls };
}

/** Each tool call's id, from the call's hash and its place: the same id live and replayed, so the next request hashes the same. */
const toolUseId = (hash, index) => `toolu_socket_${hash.slice(0, 16)}_${index}`;

/** One kept answer as the Messages API's reply body. */
export function messagesReply(hash, answer) {
  const text = String(answer?.text ?? "");
  const calls = Array.isArray(answer?.toolCalls) ? answer.toolCalls : [];
  const content = [...(text || calls.length === 0 ? [{ type: "text", text }] : []), ...calls.map((call, index) => ({ type: "tool_use", id: toolUseId(hash, index), name: call.name, input: call.input ?? {} }))];
  return { id: `msg_socket_${hash.slice(0, 16)}`, type: "message", role: "assistant", content, stop_reason: calls.length ? "tool_use" : "end_turn", usage: { input_tokens: 0, output_tokens: 0 } };
}

/** What a Messages API body asks, as the socket names it: everything sent but the gateway's metadata. */
export function messagesRequest(body) {
  const { metadata: _metadata, ...request } = typeof body === "string" ? JSON.parse(body) : body;
  return request;
}

/**
 * `claudeTransport`'s `send(body)` (`models.mjs`) answered through the socket: the texting assistant's turn, its
 * advisor and reviewer, the played person and the judge all post Messages API bodies through it. The request is keyed
 * whole (tools with their schemas, which the examiner needs to call them), never the keys or the metadata.
 */
export function socketSend(socket) {
  const send = async (body) => {
    const request = messagesRequest(body);
    const answer = await socket.ask("claude", request);
    return new Response(JSON.stringify(messagesReply(requestHash("claude", request), answer)), { status: 200, headers: { "content-type": "application/json" } });
  };
  send.route = "socket";
  return send;
}

/**
 * The gateway's `request(call, config, options)` answered through the socket: a Claude call keyed by what would be
 * sent (model, system, messages, tools, the token cap), never the keys or the metadata.
 */
export function socketRequest(socket) {
  return async (call) => {
    const request = { model: call.model, system: call.system ?? null, messages: call.messages ?? [], tools: (call.tools ?? []).map((tool) => tool?.name ?? tool), maxTokens: call.maxTokens ?? null };
    const answer = await socket.ask("claude", request);
    const hash = requestHash("claude", request);
    const toolCalls = (Array.isArray(answer?.toolCalls) ? answer.toolCalls : []).map((tool, index) => ({ id: toolUseId(hash, index), name: tool.name, args: tool.input ?? {} }));
    return { text: String(answer?.text ?? ""), toolCalls, stop: toolCalls.length ? "tool_use" : "end_turn", usage: { input: 0, output: 0 } };
  };
}

/** Workers AI's `ai.run(model, input)` answered through the socket. */
export function socketAi(socket) {
  return { run: (model, input) => socket.ask("workers-ai", { model, input }) };
}

/** Where an examiner's answers for one commit live: Context, never the repository (held-out answers are among them). */
export const EXAMINER_FOLDER = "ai/results/examiner";
export const examinerPath = (sha) => `${EXAMINER_FOLDER}/${sha}.md`;

/** The note an examiner publishes: who answered, when, and the { hash: answer } map in one JSON block. */
export function examinerNote({ sha, by, at, answers }) {
  return [
    `# Examiner answers for ${sha.slice(0, 12)}`,
    "",
    `Answered by ${by || "an examiner session"} at ${at}. These are a model's answers to the replay gate's calls for this commit, made by a session that did not write the change; CI rebuilds every call from the commit and scores the answers itself (\`apps/mcp/bench/modelSocket.mjs\`). Never copy them into a prompt or a case.`,
    "",
    "```json",
    JSON.stringify({ sha, by: by || null, at, answers }),
    "```",
    "",
  ].join("\n");
}

/** The answers in an examiner note, checked to be for `sha`. */
export function readExaminerNote(text, sha) {
  const m = /```json\n([\s\S]*?)\n```/.exec(text);
  if (!m) throw new Error("the examiner note has no json block");
  const body = JSON.parse(m[1]);
  if (body.sha !== sha) throw new Error(`the examiner note is for ${String(body.sha).slice(0, 12)}, not ${sha.slice(0, 12)}`);
  return body;
}

/**
 *   pnpm ai socket next --dir <dir> [--wait <s>]             the waiting calls, one JSON line each
 *   pnpm ai socket answer --dir <dir> --hash <h> --text <t>  answer one (or --file <f>; --json <j> or --json-file <f> to call tools)
 *   pnpm ai socket publish --dir <dir> --sha <sha> [--by <who>]   the answers into Context
 *   pnpm ai socket note --dir <dir> --sha <sha> [--by <who>] --out <file>   the same note as a file, for a session
 *                                                            that writes to Context with its own connection
 *   pnpm ai socket pull --sha <sha> --out <file>             CI: the answers for a replay
 */
export async function socketCommand(options, { write = (text) => process.stdout.write(text), connect, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const sub = options.job;
  if (sub === "next") {
    if (!options.dir) throw new Error("usage: pnpm ai socket next --dir <dir> [--wait <seconds>]");
    const until = Date.now() + Number(options.wait ?? 60) * 1000;
    let pending = await pendingCalls(options.dir);
    while (pending.length === 0 && Date.now() < until) {
      await wait(1000);
      pending = await pendingCalls(options.dir);
    }
    write(pending.length ? `${pending.map((call) => JSON.stringify(call)).join("\n")}\n` : "none waiting\n");
    return pending;
  }
  if (sub === "answer") {
    if (!options.dir || !options.hash || (options.text === undefined && options.json === undefined && !options.file && !options["json-file"])) {
      throw new Error("usage: pnpm ai socket answer --dir <dir> --hash <hash> --text <text> | --file <file> | --json <{text, toolCalls}> | --json-file <file>");
    }
    // --json and --json-file: a Claude answer that calls tools, `{ text, toolCalls: [{ name, input }] }`.
    const answer =
      options["json-file"] ? JSON.parse(await readFile(options["json-file"], "utf8")) : options.json !== undefined ? JSON.parse(options.json) : options.file ? await readFile(options.file, "utf8") : options.text;
    const kind = await answerCall(options.dir, options.hash, answer);
    write(`answered ${kind} call ${options.hash.slice(0, 12)}\n`);
    return kind;
  }
  if (sub === "publish") {
    if (!options.dir || !options.sha) throw new Error("usage: pnpm ai socket publish --dir <dir> --sha <full sha> [--by <who>]");
    if (!/^[0-9a-f]{40}$/.test(options.sha)) throw new Error("--sha takes the full 40-character commit");
    const answers = await collectAnswers(options.dir);
    const connection = await connect();
    const { callTool, splitNote } = await import("./context.mjs");
    const path = examinerPath(options.sha);
    const existing = await callTool(connection, "read_note", { path });
    const etag = existing.isError ? null : (splitNote(existing.text).header.etag ?? null);
    const written = await callTool(connection, "write_note", { path, content: examinerNote({ sha: options.sha, by: options.by, at: new Date().toISOString(), answers }), summary: `examiner answers for ${options.sha.slice(0, 12)}`, ...(etag ? { expected_etag: etag } : {}) });
    if (written.isError) throw new Error(`write_note ${path}: ${written.text}`);
    write(`published ${Object.keys(answers).length} answers to ${path}\n`);
    return path;
  }
  if (sub === "note") {
    if (!options.dir || !options.sha || !options.out) throw new Error("usage: pnpm ai socket note --dir <dir> --sha <full sha> [--by <who>] --out <file>");
    if (!/^[0-9a-f]{40}$/.test(options.sha)) throw new Error("--sha takes the full 40-character commit");
    const answers = await collectAnswers(options.dir);
    await writeFile(options.out, examinerNote({ sha: options.sha, by: options.by, at: new Date().toISOString(), answers }), { mode: 0o600 });
    write(`wrote ${Object.keys(answers).length} answers to ${options.out}; save it as ${examinerPath(options.sha)} in @context-lc\n`);
    return options.out;
  }
  if (sub === "pull") {
    if (!options.sha || !options.out) throw new Error("usage: pnpm ai socket pull --sha <full sha> --out <file>");
    const connection = await connect();
    const { callTool, splitNote } = await import("./context.mjs");
    const read = await callTool(connection, "read_note", { path: examinerPath(options.sha) });
    if (read.isError) throw new Error(`no examiner answers for ${options.sha.slice(0, 12)} (${examinerPath(options.sha)})`);
    const body = readExaminerNote(splitNote(read.text).content, options.sha);
    await writeFile(options.out, JSON.stringify(body.answers), { mode: 0o600 });
    write(`pulled ${Object.keys(body.answers).length} examiner answers, made by ${body.by ?? "an examiner session"} at ${body.at}\n`);
    return body;
  }
  throw new Error("usage: pnpm ai socket next | answer | publish | note | pull");
}
