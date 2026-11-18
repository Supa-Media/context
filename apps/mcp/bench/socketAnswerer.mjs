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
 * leaving the call unanswered, so the gate's run fails rather than scoring a path the model never chose. A tool call
 * the model makes to a tool the call does not offer is not a CLI failure: the schema names only the offered tools,
 * and one that still gets through is dropped from that answer, so the row scores as Tex's miss.
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

/**
 * One message's words. A call comes in the Messages API's shape (`content` blocks) or in Tex's own (`aiGateway.js`):
 * `text`, an assistant's `toolCalls`, and a `tool` message's result with `name` and `isError`. Reading only
 * `content` sent the CLI an empty conversation for every call in Tex's shape (2026-11-18: the job check's brief,
 * finish line and tool results never reached it, and it answered "this check received nothing").
 */
export function messageText(message) {
  if (message?.content !== undefined) return contentText(message.content);
  const calls = (message?.toolCalls ?? []).map((call) => `[called tool ${call.name} with ${JSON.stringify(call.args ?? call.input ?? {})}]`);
  const words = String(message?.text ?? "");
  if (message?.role === "tool") return `[result of tool call ${message.name ?? ""}${message.isError ? " (error)" : ""}]\n${words}`;
  return [words, ...calls].filter(Boolean).join("\n");
}

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

/** The one message the CLI is sent for a call: the conversation so far, the tools on offer, and what to write. */
export function promptFor(request) {
  const turns = (request?.messages ?? []).map((message) => `<${message.role}>\n${messageText(message)}\n</${message.role}>`).join("\n\n");
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
  if (request?.tools?.length) args.push("--json-schema", JSON.stringify(toolAnswerSchema(request)));
  return args;
}

/**
 * The answer kept for a call, from the CLI's `--output-format json` result. Tool calls the call cannot take are left
 * out and named to `onDropped` (`keepOffered`).
 */
export function answerFrom(request, stdout, onDropped = () => {}) {
  const result = JSON.parse(stdout);
  if (result.is_error) throw new Error(`the CLI answered with an error: ${String(result.result ?? result.subtype ?? "").slice(0, 200)}`);
  if (!request?.tools?.length) return { text: String(result.result ?? "") };
  const given = result.structured_output ?? JSON.parse(String(result.result ?? "{}"));
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
    const result = JSON.parse(stdout);
    // An error result's text is the CLI's own message; a non-error result could be the model's words, so it is not kept.
    const text = result.is_error ? String(result.result ?? result.subtype ?? "").trim() : String(result.subtype ?? "");
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
      const answer = answerFrom(call.request, await cli(call.request), (names) =>
        log(`answered ${call.hash.slice(0, 12)} without ${names.length} tool call(s) it does not offer: ${names.map((name) => name.slice(0, 40)).join(", ")}`),
      );
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
  // Calls answered this run. A listing read while a call was finishing can still hold it after it left `busy`, and it
  // would be answered twice (a second paid CLI run): CI saw 6 answers for 5 calls, 2026-11-16.
  const done = new Set();
  let failure = null;
  let answered = 0;
  for (;;) {
    if (failure) throw failure;
    const waiting = (await pendingCalls(dir)).filter((call) => !busy.has(call.hash) && !done.has(call.hash));
    if (failure) throw failure; // a call can fail while the listing is read: never hand it out again
    for (const call of waiting.slice(0, Math.max(0, parallel - busy.size))) {
      const work = answerOne(dir, call, { cli, log })
        .then(() => {
          done.add(call.hash);
          answered += 1;
        })
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
