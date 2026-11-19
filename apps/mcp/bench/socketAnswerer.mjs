#!/usr/bin/env node
/**
 * THE CLAUDE CODE ANSWERER: the model socket answered inside CI, on the subscription (Dev2, 2026-11-15: the
 * examiner "shouldn't be a project then, and should be some type of webhook", then "yes" to a GitHub Action that runs
 * Claude Code as soon as Tex replay required goes red).
 *
 * The replay gate runs with `BENCH_MODEL_SOCKET=<dir>` (`modelSocket.mjs`); this loop takes each waiting Claude call
 * and asks the model family the call names (haiku, sonnet or opus) through the Claude Code CLI in print mode, with the
 * call's own system prompt in place of Claude Code's, no tools of its own, and the conversation written out as one
 * message. A call that offers tools is answered as `{ text, toolCalls }`: first as that one JSON object in the CLI's
 * text (the prompt asks for exactly that), and only if it does not parse, through a JSON schema. The answer is written
 * where the gate reads it, and the gate scores it against main in its own code, as for the examiner session.
 *
 * Why it is shaped this way (measured in this container, claude 2.1.327, haiku, a tiny prompt, 2026-11-18): the CLI's
 * startup network traffic was ~2.1 s of a ~4.3 s call against ~1.2 s of model time, so `cliEnv` switches it off (wall
 * 2.2 s). A `--json-schema` call is run by the CLI as an extra structured-output round (3 turns, API ~3.0-3.7 s, wall
 * ~5 s), while the same answer as text came back in one turn (API ~1.25 s, wall ~2.2 s). Each call logs its wall and
 * model times, and the loop ends with their averages, so a Lab run's log shows where the time goes.
 *
 * It never sees the change, the diff or a case file: only what the harness would send a model. Unlike the examiner it
 * is the named model family, not another model playing it; what it cannot match is production's exact model version,
 * effort and token cap, which the CLI does not take per call.
 *
 *   CLAUDE_CODE_OAUTH_TOKEN=... node apps/mcp/bench/socketAnswerer.mjs --dir <sock> --stop <file> [--parallel 4]
 *
 * It runs until the stop file exists and nothing is waiting. A call the CLI fails three times stops it with exit 1,
 * leaving the call unanswered, so the gate's run fails rather than scoring a path the model never chose. A tool call
 * the model makes to a tool the call does not offer is not a CLI failure: the schema names only the offered tools,
 * and one that still gets through is dropped from that answer, so the row scores as Tex's miss.
 *
 * Pictures and PDFs go to the model as pictures and documents, not as words: a call that holds one is sent as stream-json
 * content blocks, each media block where it sat in the conversation (`socketPrompt.mjs`). Before, every picture was
 * written out as "[an image]" and the cc runs answered "I can't read it" for each picture row in the Dev set (Dev2,
 * 2026-11-19).
 */
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerCall, pendingCalls } from "./modelSocket.mjs";
import { hasMedia, promptBlocks, promptFor, systemText } from "./socketPrompt.mjs";
import { WORLD_SYSTEM_OPENING } from "./simWorld.mjs";

export { blockText, hasMedia, messageText, promptBlocks, promptFor, systemText, toolsText } from "./socketPrompt.mjs";

/** The CLI's model alias for a request's model id: the family it names, else the call's own id. */
export function modelAlias(model) {
  const id = String(model ?? "").toLowerCase();
  for (const family of ["haiku", "sonnet", "opus"]) if (id.includes(family)) return family;
  return String(model ?? "") || "sonnet";
}

const toolName = (tool) => String(typeof tool === "string" ? tool : tool?.name ?? "");

/** The names of the tools a call offers, once each. */
export function offeredTools(request) {
  return [...new Set((request?.tools ?? []).map(toolName).filter(Boolean))];
}

/**
 * The JSON schema a tool-offering call is answered in: the shape `claudeAnswer` keeps, with the tool's name limited to
 * the tools this call offers. One fixed schema let the model name any tool (2026-11-18: Lab run 44313860768 died on
 * "the call offers no tool \"draw_visual\"" three times over).
 */
export function toolAnswerSchema(request) {
  return {
    type: "object",
    properties: {
      text: { type: "string" },
      toolCalls: {
        type: "array",
        items: { type: "object", properties: { name: { type: "string", enum: offeredTools(request) }, input: { type: "object" } }, required: ["name", "input"] },
      },
    },
    required: ["text", "toolCalls"],
  };
}

/**
 * The tool calls of an answer the call can take, and the ones it cannot: a tool it never offered, or an input that is
 * not an object. A dropped call is the model's mistake, so the answer stands without it and the row counts as Tex's
 * miss; it never stops the run.
 */
export function keepOffered(request, toolCalls) {
  const offered = new Set(offeredTools(request));
  const kept = [];
  const dropped = [];
  for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
    const name = String(call?.name ?? "");
    const input = call?.input ?? call?.args ?? {};
    if (offered.has(name) && input && typeof input === "object" && !Array.isArray(input)) kept.push({ name, input });
    else dropped.push(name || "(no name)");
  }
  return { kept, dropped };
}

/**
 * Raised when a tool-offering call's answer text is not the `{ text, toolCalls }` object the prompt asked for. The
 * retry is then answered through the JSON schema (`answerOne`).
 */
export class ToolAnswerFormatError extends Error {
  constructor() {
    super('the answer is not the JSON object { text, toolCalls }');
    this.name = "ToolAnswerFormatError";
  }
}

const isAnswerObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value) && typeof value.text === "string" && Array.isArray(value.toolCalls);

function answerObjectIn(candidate) {
  try {
    const value = JSON.parse(candidate);
    return isAnswerObject(value) ? value : null;
  } catch {
    return null;
  }
}

/** The index of the brace closing the one opened at `start` (string-aware), or -1. */
function closingBrace(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}" && (depth -= 1) === 0) return i;
  }
  return -1;
}

/**
 * The `{ text, toolCalls }` object in the CLI's text: the whole text, one inside a ```json fence, or the first `{...}`
 * block that parses to one. Anything else throws `ToolAnswerFormatError`.
 */
export function parseToolAnswer(raw) {
  const text = String(raw ?? "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  for (const candidate of [text, ...(fenced ? [fenced[1].trim()] : [])]) {
    const found = answerObjectIn(candidate);
    if (found) return found;
  }
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    const end = closingBrace(text, start);
    const found = end === -1 ? null : answerObjectIn(text.slice(start, end + 1));
    if (found) return found;
  }
  throw new ToolAnswerFormatError();
}

/**
 * The CLI's result object from its stdout. Plain `--output-format json` prints the result as one JSON value; stream-json
 * prints many lines and the result is the last line with `"type":"result"`. Throws when there is none.
 */
export function resultOf(stdout) {
  const text = String(stdout ?? "");
  try {
    const whole = JSON.parse(text);
    if (whole && typeof whole === "object" && (whole.type === undefined || whole.type === "result")) return whole;
  } catch {}
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const line = JSON.parse(lines[i]);
      if (line?.type === "result") return line;
    } catch {}
  }
  throw new Error("the CLI printed no result");
}

/** The CLI's own timings for a result: model time (`duration_api_ms`) and turns (`num_turns`), null when absent. */
export function resultTiming(stdout) {
  try {
    const result = resultOf(stdout);
    const number = (value) => (Number.isFinite(value) ? value : null);
    return { modelMs: number(result.duration_api_ms), turns: number(result.num_turns) };
  } catch {
    return { modelMs: null, turns: null };
  }
}

/**
 * The CLI's arguments for one call. The system prompt goes in a file and the message on stdin, never in an argument:
 * one argument is capped at 128 KB, and a front door's prompt with its history can pass that. `--json-schema` (the
 * structured-output round, three turns) is passed only with `schema: true`, for a tool call whose text did not parse.
 */
export function cliArgs(request, systemFile, { schema = false, media = false } = {}) {
  const args = ["-p", "--model", modelAlias(request?.model), "--system-prompt-file", systemFile, "--tools", "", "--output-format", "json", "--strict-mcp-config", "--no-session-persistence"];
  // A call with pictures or PDFs is sent as stream-json input (one user message of content blocks); the CLI then
  // needs stream-json output too, and stream-json output needs --verbose. The result is the last line (`resultOf`).
  if (media) args.splice(args.indexOf("--output-format"), 2, "--input-format", "stream-json", "--output-format", "stream-json", "--verbose");
  if (schema && request?.tools?.length) args.push("--json-schema", JSON.stringify(toolAnswerSchema(request)));
  // The bench world's calls (`simWorld.mjs`): the CLI has no per-call thinking switch or temperature, so `--effort low` is
  // the nearest setting it reaches, and `--json-schema` enforces the world's answer shape. Only those calls get it, so
  // Tex's own cc calls are unchanged.
  if (isWorldCall(request)) args.push("--json-schema", JSON.stringify(request.output_config.format.schema), "--effort", "low");
  return args;
}

/** A no-tools call the bench's simulated world made, asking for a JSON schema (`simWorld.mjs` ask). */
const isWorldCall = (request) =>
  !request?.tools?.length && String(systemText(request?.system)).startsWith(WORLD_SYSTEM_OPENING) && request?.output_config?.format?.type === "json_schema";

/**
 * The environment the CLI runs with: the caller's, with its non-essential network traffic, updater, telemetry and error
 * reports switched off (see the header: ~2 s of startup per call). CLAUDE_CODE_OAUTH_TOKEN passes through untouched.
 */
export function cliEnv(env = process.env) {
  return { ...env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" };
}

/**
 * The answer kept for a call, from the CLI's `--output-format json` result. A tool-offering call takes the schema's
 * `structured_output` when the CLI gave one, else the `{ text, toolCalls }` object in its text (`parseToolAnswer`).
 * Tool calls the call cannot take are left out and named to `onDropped` (`keepOffered`).
 */
export function answerFrom(request, stdout, onDropped = () => {}) {
  const result = resultOf(stdout);
  if (result.is_error) throw new Error(`the CLI answered with an error: ${String(result.result ?? result.subtype ?? "").slice(0, 200)}`);
  if (!request?.tools?.length) {
    // A world call's answer is the schema's `structured_output` when the CLI gave one (`cliArgs`), as its JSON text.
    if (result.structured_output && typeof result.structured_output === "object") return { text: JSON.stringify(result.structured_output) };
    return { text: String(result.result ?? "") };
  }
  const given = result.structured_output ?? parseToolAnswer(result.result);
  const { kept, dropped } = keepOffered(request, given.toolCalls);
  if (dropped.length) onDropped(dropped);
  return { text: String(given.text ?? ""), toolCalls: kept };
}

/**
 * Why the CLI failed, for the log: with `--output-format json` its error is the result's text on stdout and stderr is
 * often empty. Only the error's text is kept, never a prompt or an answer.
 */
export function failureText(stdout, stderr) {
  try {
    const result = resultOf(stdout);
    // An error result's text is the CLI's own message; a non-error result could be the model's words, so it is not kept.
    const text = result.is_error ? String(result.result ?? result.subtype ?? "").trim() : String(result.subtype ?? "");
    if (text) return text.slice(0, 300);
  } catch {}
  return (String(stderr ?? "").trim() || "no output").slice(0, 300);
}

/** An empty folder to run the CLI in, so no project instructions (this repository's CLAUDE.md) reach the call. */
let emptyDir = null;

/** Runs the CLI once for `request`: its system prompt written to a file, its message on stdin. Resolves with stdout. */
async function runCli(request, { schema = false, env = process.env } = {}) {
  emptyDir ??= mkdtempSync(join(tmpdir(), "socket-answerer-"));
  const systemFile = join(emptyDir, `system-${process.hrtime.bigint()}-${Math.random().toString(36).slice(2)}.txt`);
  await writeFile(systemFile, systemText(request?.system));
  const media = hasMedia(request);
  return new Promise((resolve, reject) => {
    const child = spawn("claude", cliArgs(request, systemFile, { schema, media }), { env: cliEnv(env), cwd: emptyDir, stdio: ["pipe", "pipe", "pipe"], timeout: 10 * 60 * 1000 });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`claude exited ${code}: ${failureText(out, err)}`))));
    child.stdin.end(media ? `${JSON.stringify({ type: "user", message: { role: "user", content: promptBlocks(request) } })}\n` : promptFor(request));
  });
}

/**
 * Answers one waiting call, three tries, through `cli(request, { schema })` (stdout of the CLI); throws when every try
 * failed. The first try of a tool-offering call is plain text; after a try whose answer did not parse, the tries that
 * follow ask for the JSON schema. `timing({ wallMs, modelMs })` gets the answered try's times.
 */
export async function answerOne(dir, call, { cli = (request, options) => runCli(request, options), tries = 3, log = () => {}, timing = () => {} } = {}) {
  if (call.kind !== "claude") throw new Error(`a ${call.kind} call ${call.hash.slice(0, 12)} reached the socket; only Claude calls are answered here`);
  const hash12 = call.hash.slice(0, 12);
  let last;
  let schema = false;
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    const started = Date.now();
    try {
      const stdout = await cli(call.request, { schema });
      const answer = answerFrom(call.request, stdout, (names) =>
        log(`answered ${hash12} without ${names.length} tool call(s) it does not offer: ${names.map((name) => name.slice(0, 40)).join(", ")}`),
      );
      const wallMs = Date.now() - started;
      const { modelMs, turns } = resultTiming(stdout);
      await answerCall(dir, call.hash, answer);
      log(`answered ${hash12} (${modelAlias(call.request?.model)}) in ${wallMs} ms, model ${modelMs ?? "n/a"} ms, turns ${turns ?? "n/a"}`);
      timing({ wallMs, modelMs });
      return answer;
    } catch (error) {
      last = error;
      if (error instanceof ToolAnswerFormatError) schema = true;
      log(`try ${attempt} on ${hash12} failed: ${error.message.split("\n")[0]}`);
    }
  }
  throw new Error(`call ${hash12} failed ${tries} times: ${last?.message}`);
}

/**
 * The one-line summary of a run's answered calls: the averages of wall time, model time (`duration_api_ms`) and the
 * overhead between them (wall less model, for the calls whose result had a model time).
 */
export function timingSummary(timed) {
  const average = (values) => (values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : "n/a");
  const withModel = timed.filter((call) => call.modelMs !== null && call.modelMs !== undefined);
  const wall = average(timed.map((call) => call.wallMs));
  const model = average(withModel.map((call) => call.modelMs));
  const overhead = average(withModel.map((call) => call.wallMs - call.modelMs));
  return `socketAnswerer: ${timed.length} call(s), average wall ${wall} ms, average model ${model} ms, average overhead ${overhead} ms`;
}

/** Answers waiting calls, `parallel` at a time, until `stopped()` and nothing waits. Rejects on the first call that fails every try. */
export async function answerLoop(dir, { parallel = 4, stopped, cli, log = () => {}, pollMs = 150, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const busy = new Map();
  // Calls answered this run. A listing read while a call was finishing can still hold it after it left `busy`, and it
  // would be answered twice (a second paid CLI run): CI saw 6 answers for 5 calls, 2026-11-16.
  const done = new Set();
  const timed = [];
  let failure = null;
  let answered = 0;
  for (;;) {
    if (failure) throw failure;
    const waiting = (await pendingCalls(dir)).filter((call) => !busy.has(call.hash) && !done.has(call.hash));
    if (failure) throw failure; // a call can fail while the listing is read: never hand it out again
    for (const call of waiting.slice(0, Math.max(0, parallel - busy.size))) {
      const work = answerOne(dir, call, { cli, log, timing: (times) => timed.push(times) })
        .then(() => {
          done.add(call.hash);
          answered += 1;
        })
        .catch((error) => (failure ??= error))
        .finally(() => busy.delete(call.hash));
      busy.set(call.hash, work);
    }
    if (busy.size === 0 && waiting.length === 0 && stopped()) {
      log(timingSummary(timed));
      return answered;
    }
    if (busy.size >= parallel || waiting.length === 0) await (busy.size ? Promise.race(busy.values()) : wait(pollMs));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const option = (name, fallback) => {
    const at = process.argv.indexOf(`--${name}`);
    return at > 0 ? process.argv[at + 1] : fallback;
  };
  const dir = option("dir");
  const stop = option("stop");
  if (!dir || !stop) {
    console.error("usage: node apps/mcp/bench/socketAnswerer.mjs --dir <socket dir> --stop <file> [--parallel 4]");
    process.exit(2);
  }
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    console.error("socketAnswerer: CLAUDE_CODE_OAUTH_TOKEN is not set (make one with `claude setup-token` and add it as the production secret)");
    process.exit(1);
  }
  // `claude setup-token` output is wrapped by the terminal, so a pasted copy carries line breaks, which the CLI reads
  // as "Not logged in". A token has no whitespace.
  process.env.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN.replace(/\s+/g, "");
  answerLoop(dir, { parallel: Number(option("parallel", "4")), stopped: () => existsSync(stop), log: (line) => console.log(line) })
    .then((count) => console.log(`socketAnswerer: answered ${count} call(s)`))
    .catch((error) => {
      console.error(`::error::socketAnswerer: ${error.message}`);
      process.exit(1);
    });
}
