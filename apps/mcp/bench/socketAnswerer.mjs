#!/usr/bin/env node
/**
 * THE CLAUDE CODE ANSWERER: the model socket answered inside CI, on the subscription (Dev2, 2026-11-15: the
 * examiner "shouldn't be a project then, and should be some type of webhook", then "yes" to a GitHub Action that runs
 * Claude Code as soon as Tex replay required goes red).
 *
 * The replay gate runs with `BENCH_MODEL_SOCKET=<dir>` (`modelSocket.mjs`); this loop takes each waiting Claude call
 * and asks the model family the call names (haiku, sonnet or opus) through the Claude Code CLI in print mode, with the
 * call's own system prompt in place of Claude Code's, no tools of its own, and the conversation written out as one
 * message. A call that offers tools is answered as `{ text, toolCalls }` through a JSON schema. The answer is written
 * where the gate reads it, and the gate scores it against main in its own code, as for the examiner session.
 *
 * It never sees the change, the diff or a case file: only what the harness would send a model. Unlike the examiner it
 * is the named model family, not another model playing it; what it cannot match is production's exact model version,
 * effort and token cap, which the CLI does not take per call.
 *
 *   CLAUDE_CODE_OAUTH_TOKEN=... node apps/mcp/bench/socketAnswerer.mjs --dir <sock> --stop <file> [--parallel 4]
 *
 * It runs until the stop file exists and nothing is waiting. A call the CLI fails three times stops it with exit 1,
 * leaving the call unanswered, so the gate's run fails rather than scoring a path the model never chose.
 */
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerCall, pendingCalls } from "./modelSocket.mjs";

/** The CLI's model alias for a request's model id: the family it names, else the call's own id. */
export function modelAlias(model) {
  const id = String(model ?? "").toLowerCase();
  for (const family of ["haiku", "sonnet", "opus"]) if (id.includes(family)) return family;
  return String(model ?? "") || "sonnet";
}

/** A content block (or a string) as plain text for the written-out conversation. */
function blockText(block) {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object") return "";
  if (block.type === "text") return String(block.text ?? "");
  if (block.type === "tool_use") return `[called tool ${block.name} with ${JSON.stringify(block.input ?? {})}]`;
  if (block.type === "tool_result") {
    const inner = Array.isArray(block.content) ? block.content.map(blockText).join("\n") : String(block.content ?? "");
    return `[result of tool call${block.is_error ? " (error)" : ""}]\n${inner}`;
  }
  if (block.type === "image") return "[an image]";
  if (block.type === "thinking" || block.type === "redacted_thinking") return "";
  return JSON.stringify(block);
}

const contentText = (content) => (Array.isArray(content) ? content.map(blockText).filter(Boolean).join("\n") : blockText(content));

/** The call's system prompt as one string (a Messages API system may be blocks). */
export function systemText(system) {
  return Array.isArray(system) ? system.map(blockText).join("\n\n") : String(system ?? "");
}

/** The tools a call offers, as the model is told about them: name, description and input schema where the call has them. */
export function toolsText(tools = []) {
  return tools
    .map((tool) => (typeof tool === "string" ? `- ${tool}` : `- ${tool.name}: ${tool.description ?? ""}\n  input schema: ${JSON.stringify(tool.input_schema ?? tool.inputSchema ?? {})}`))
    .join("\n");
}

/** The JSON schema a tool-offering call is answered in: the shape `claudeAnswer` keeps. */
export const TOOL_ANSWER_SCHEMA = {
  type: "object",
  properties: {
    text: { type: "string" },
    toolCalls: { type: "array", items: { type: "object", properties: { name: { type: "string" }, input: { type: "object" } }, required: ["name", "input"] } },
  },
  required: ["text", "toolCalls"],
};

/** The one message the CLI is sent for a call: the conversation so far, the tools on offer, and what to write. */
export function promptFor(request) {
  const turns = (request?.messages ?? []).map((message) => `<${message.role}>\n${contentText(message.content)}\n</${message.role}>`).join("\n\n");
  const tools = request?.tools?.length ? toolsText(request.tools) : "";
  return [
    "Below is a conversation so far. Write the next assistant turn, exactly as you would send it, following the system prompt.",
    "",
    "<conversation>",
    turns,
    "</conversation>",
    ...(tools
      ? [
          "",
          "The tools listed here are available to you in this conversation. You call one by putting it in toolCalls of your JSON answer { text, toolCalls }; that is the only way to call a tool here, and its result comes back to you as the next turn. Call tools whenever you would have used them: text is any words before the calls (or the whole reply, with toolCalls empty), and each call is { name, input } with input matching the tool's schema.",
          "<tools>",
          tools,
          "</tools>",
        ]
      : []),
  ].join("\n");
}

/**
 * The CLI's arguments for one call. The system prompt goes in a file and the message on stdin, never in an argument:
 * one argument is capped at 128 KB, and a front door's prompt with its history can pass that.
 */
export function cliArgs(request, systemFile) {
  const args = ["-p", "--model", modelAlias(request?.model), "--system-prompt-file", systemFile, "--tools", "", "--output-format", "json", "--strict-mcp-config"];
  if (request?.tools?.length) args.push("--json-schema", JSON.stringify(TOOL_ANSWER_SCHEMA));
  return args;
}

/** The answer kept for a call, from the CLI's `--output-format json` result. */
export function answerFrom(request, stdout) {
  const result = JSON.parse(stdout);
  if (result.is_error) throw new Error(`the CLI answered with an error: ${String(result.result ?? result.subtype ?? "").slice(0, 200)}`);
  if (!request?.tools?.length) return { text: String(result.result ?? "") };
  const given = result.structured_output ?? JSON.parse(String(result.result ?? "{}"));
  return { text: String(given.text ?? ""), toolCalls: Array.isArray(given.toolCalls) ? given.toolCalls : [] };
}

/**
 * Why the CLI failed, for the log: with `--output-format json` its error is the result's text on stdout and stderr is
 * often empty. Only the error's text is kept, never a prompt or an answer.
 */
export function failureText(stdout, stderr) {
  try {
    const result = JSON.parse(stdout);
    const text = String(result.result ?? result.subtype ?? "").trim();
    if (text) return text.slice(0, 300);
  } catch {}
  return (String(stderr ?? "").trim() || "no output").slice(0, 300);
}

/** An empty folder to run the CLI in, so no project instructions (this repository's CLAUDE.md) reach the call. */
let emptyDir = null;

/** Runs the CLI once for `request`: its system prompt written to a file, its message on stdin. Resolves with stdout. */
async function runCli(request, env = process.env) {
  emptyDir ??= mkdtempSync(join(tmpdir(), "socket-answerer-"));
  const systemFile = join(emptyDir, `system-${process.hrtime.bigint()}-${Math.random().toString(36).slice(2)}.txt`);
  await writeFile(systemFile, systemText(request?.system));
  return new Promise((resolve, reject) => {
    const child = spawn("claude", cliArgs(request, systemFile), { env, cwd: emptyDir, stdio: ["pipe", "pipe", "pipe"], timeout: 10 * 60 * 1000 });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`claude exited ${code}: ${failureText(out, err)}`))));
    child.stdin.end(promptFor(request));
  });
}

/** Answers one waiting call, three tries, through `cli(request)` (stdout of the CLI); throws when every try failed. */
export async function answerOne(dir, call, { cli = (request) => runCli(request), tries = 3, log = () => {} } = {}) {
  if (call.kind !== "claude") throw new Error(`a ${call.kind} call ${call.hash.slice(0, 12)} reached the socket; only Claude calls are answered here`);
  let last;
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      const answer = answerFrom(call.request, await cli(call.request));
      await answerCall(dir, call.hash, answer);
      log(`answered ${call.hash.slice(0, 12)} (${modelAlias(call.request?.model)})`);
      return answer;
    } catch (error) {
      last = error;
      log(`try ${attempt} on ${call.hash.slice(0, 12)} failed: ${error.message.split("\n")[0]}`);
    }
  }
  throw new Error(`call ${call.hash.slice(0, 12)} failed ${tries} times: ${last?.message}`);
}

/** Answers waiting calls, `parallel` at a time, until `stopped()` and nothing waits. Rejects on the first call that fails every try. */
export async function answerLoop(dir, { parallel = 4, stopped, cli, log = () => {}, pollMs = 1000, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const busy = new Map();
  let failure = null;
  let answered = 0;
  for (;;) {
    if (failure) throw failure;
    const waiting = (await pendingCalls(dir)).filter((call) => !busy.has(call.hash));
    if (failure) throw failure; // a call can fail while the listing is read: never hand it out again
    for (const call of waiting.slice(0, Math.max(0, parallel - busy.size))) {
      const work = answerOne(dir, call, { cli, log })
        .then(() => (answered += 1))
        .catch((error) => (failure ??= error))
        .finally(() => busy.delete(call.hash));
      busy.set(call.hash, work);
    }
    if (busy.size === 0 && waiting.length === 0 && stopped()) return answered;
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
  // A vault copy of the token often ends in a line break, which the CLI reads as "Not logged in".
  process.env.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN.trim();
  answerLoop(dir, { parallel: Number(option("parallel", "4")), stopped: () => existsSync(stop), log: (line) => console.log(line) })
    .then((count) => console.log(`socketAnswerer: answered ${count} call(s)`))
    .catch((error) => {
      console.error(`::error::socketAnswerer: ${error.message}`);
      process.exit(1);
    });
}
