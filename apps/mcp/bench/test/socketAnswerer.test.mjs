/**
 * THE CLAUDE CODE ANSWERER (`bench/socketAnswerer.mjs`; Dev2, 2026-11-15: replay examined by a GitHub Action on the
 * subscription instead of an hourly project task). The CLI itself is faked: these check what it is sent and what is
 * kept, and that a call the CLI keeps failing is left unanswered rather than filled in.
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-11-15):
 *  1. `answerOne` writing an empty answer after the last failed try -> "a call the CLI keeps failing stays unanswered" fails;
 *  2. `cliArgs` dropping `--tools ""` -> "the CLI runs with no tools of its own" fails;
 *  3. `promptFor` leaving out tool results -> "the conversation carries tool calls and their results" fails.
 *  4. `promptFor` reading only `content` -> "a call in Tex's own message shape reaches the CLI whole" fails.
 *  5. (2026-11-18) the schema's tool name back to a bare string -> "the answer schema names only the tools this call
 *     offers" fails; `answerFrom` keeping every tool call -> "a tool the call did not offer is dropped" fails.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  answerFrom,
  answerLoop,
  answerOne,
  cliArgs,
  cliEnv,
  failureText,
  keepOffered,
  modelAlias,
  hasMedia,
  parseToolAnswer,
  promptBlocks,
  promptFor,
  resultOf,
  systemText,
  timingSummary,
  toolAnswerSchema,
  ToolAnswerFormatError,
} from "../socketAnswerer.mjs";
import { requestHash } from "../modelSocket.mjs";

const TOOL = { name: "search", description: "Search the notes", input_schema: { type: "object", properties: { query: { type: "string" } } } };

async function socketWith(requests) {
  const dir = await mkdtemp(join(tmpdir(), "answerer-"));
  await mkdir(join(dir, "calls"), { recursive: true });
  const calls = [];
  for (const request of requests) {
    const hash = requestHash("claude", request);
    await writeFile(join(dir, "calls", `${hash}.json`), JSON.stringify({ hash, kind: "claude", request }));
    calls.push({ hash, kind: "claude", request });
  }
  return { dir, calls };
}

const cliResult = (fields) => JSON.stringify({ type: "result", subtype: "success", is_error: false, ...fields });

test("the model family is named from the request's model id", () => {
  assert.equal(modelAlias("claude-haiku-4-5-20251001"), "haiku");
  assert.equal(modelAlias("anthropic/claude-opus-4-1"), "opus");
  assert.equal(modelAlias("claude-sonnet-4-5"), "sonnet");
  assert.equal(modelAlias("some-new-model"), "some-new-model");
});

test("the CLI runs with no tools of its own, the call's system prompt from a file, and JSON out", () => {
  const args = cliArgs({ model: "claude-haiku-4-5", system: "be brief", messages: [] }, "/tmp/sys.txt");
  assert.deepEqual(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2), ["--tools", ""]);
  assert.equal(args[args.indexOf("--system-prompt-file") + 1], "/tmp/sys.txt");
  assert.equal(args[args.indexOf("--model") + 1], "haiku");
  assert.ok(args.includes("--output-format") && !args.includes("--json-schema"));
  assert.ok(args.includes("--no-session-persistence"), "no session file is written per call");
  assert.ok(!cliArgs({ model: "haiku", messages: [], tools: [TOOL] }, "/tmp/s").includes("--json-schema"), "a tool call is plain text unless asked for the schema");
  assert.ok(cliArgs({ model: "haiku", messages: [], tools: [TOOL] }, "/tmp/s", { schema: true }).includes("--json-schema"), "the schema path is asked for");
  assert.ok(!cliArgs({ model: "haiku", messages: [] }, "/tmp/s", { schema: true }).includes("--json-schema"), "a call with no tools has no schema");
});

test("the CLI runs with its non-essential traffic off and keeps the OAuth token", () => {
  const env = cliEnv({ CLAUDE_CODE_OAUTH_TOKEN: "tok-value", PATH: "/bin" });
  assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
  assert.equal(env.DISABLE_AUTOUPDATER, "1");
  assert.equal(env.DISABLE_TELEMETRY, "1");
  assert.equal(env.DISABLE_ERROR_REPORTING, "1");
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "tok-value");
  assert.equal(env.PATH, "/bin");
});

test("the JSON-only line is added to the prompt only when tools are offered", () => {
  const JSON_LINE = /Answer with only that JSON object, \{ "text": string, "toolCalls": \[ \{ "name": string, "input": object \} \] \}, and nothing before or after it\./;
  assert.match(promptFor({ messages: [{ role: "user", content: "hi" }], tools: [TOOL] }), JSON_LINE);
  assert.doesNotMatch(promptFor({ messages: [{ role: "user", content: "hi" }] }), JSON_LINE);
});

test("a tool answer in plain text parses: bare, fenced, or inside prose", () => {
  const object = { text: "Looking.", toolCalls: [{ name: "search", input: { query: "x" } }] };
  const json = JSON.stringify(object);
  assert.deepEqual(parseToolAnswer(json), object);
  assert.deepEqual(parseToolAnswer("```json\n" + json + "\n```"), object);
  assert.deepEqual(parseToolAnswer(`Here it is: {"note":"}{"} ${json} done`), object);
  const answer = answerFrom({ tools: [TOOL] }, cliResult({ result: "```json\n" + json + "\n```" }));
  assert.deepEqual(answer, object);
  assert.throws(() => parseToolAnswer("I would search for it."), ToolAnswerFormatError);
  assert.throws(() => parseToolAnswer('{"text": 1, "toolCalls": []}'), ToolAnswerFormatError);
});

test("a tool answer that does not parse retries through the schema on try 2, and plain on try 1", async () => {
  const { dir, calls } = await socketWith([{ model: "haiku", messages: [{ role: "user", content: "find it" }], tools: [TOOL] }]);
  const seen = [];
  const cli = async (request, options) => {
    seen.push(options.schema);
    if (!options.schema) return cliResult({ result: "I will search now." });
    return cliResult({ result: "", structured_output: { text: "", toolCalls: [{ name: "search", input: { query: "find it" } }] } });
  };
  const lines = [];
  const answer = await answerOne(dir, calls[0], { cli, log: (line) => lines.push(line) });
  assert.deepEqual(seen, [false, true]);
  assert.deepEqual(answer, { text: "", toolCalls: [{ name: "search", input: { query: "find it" } }] });
  assert.ok(lines.some((line) => /^try 1 on [0-9a-f]{12} failed: the answer is not the JSON object/.test(line)));
});

test("the answered line carries the timings and never the prompt or the answer's words", async () => {
  const { dir, calls } = await socketWith([{ model: "claude-haiku-4-5", system: "sys", messages: [{ role: "user", content: "SECRET-PROMPT-WORDS" }] }]);
  const lines = [];
  await answerOne(dir, calls[0], {
    cli: async () => cliResult({ result: "SECRET-ANSWER-WORDS", duration_api_ms: 1234, num_turns: 1 }),
    log: (line) => lines.push(line),
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], new RegExp(`^answered ${calls[0].hash.slice(0, 12)} \\(haiku\\) in \\d+ ms, model 1234 ms, turns 1$`));
  assert.ok(!lines.join("\n").includes("SECRET"), "no prompt or answer text in the log");
});

test("the run ends with a one-line average of wall, model and overhead time", async () => {
  const { dir } = await socketWith([1, 2].map((n) => ({ model: "haiku", messages: [{ role: "user", content: `q${n}` }] })));
  const lines = [];
  await answerLoop(dir, {
    cli: async () => cliResult({ result: "ok", duration_api_ms: 1000 }),
    stopped: () => true,
    pollMs: 1,
    log: (line) => lines.push(line),
  });
  assert.match(lines.at(-1), /^socketAnswerer: 2 call\(s\), average wall \d+ ms, average model 1000 ms, average overhead -?\d+ ms$/);
  assert.equal(timingSummary([]), "socketAnswerer: 0 call(s), average wall n/a ms, average model n/a ms, average overhead n/a ms");
});

test("a system prompt in blocks is joined as text", () => {
  assert.equal(systemText([{ type: "text", text: "one" }, { type: "text", text: "two" }]), "one\n\ntwo");
  assert.equal(systemText(null), "");
});

test("the conversation carries tool calls and their results, and the tools on offer", () => {
  const prompt = promptFor({
    messages: [
      { role: "user", content: "find my dentist" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "search", input: { query: "dentist" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "Dr. Ada, 555-0100" }] }] },
    ],
    tools: [TOOL],
  });
  assert.match(prompt, /find my dentist/);
  assert.match(prompt, /\[called tool search with \{"query":"dentist"\}\]/);
  assert.match(prompt, /Dr\. Ada, 555-0100/);
  assert.match(prompt, /- search: Search the notes/);
});

test("a plain call keeps the CLI's text; a tool call keeps its structured answer", () => {
  assert.deepEqual(answerFrom({ messages: [] }, cliResult({ result: "hello" })), { text: "hello" });
  const answer = answerFrom({ tools: [TOOL] }, cliResult({ result: "", structured_output: { text: "Looking.", toolCalls: [{ name: "search", input: { query: "x" } }] } }));
  assert.deepEqual(answer, { text: "Looking.", toolCalls: [{ name: "search", input: { query: "x" } }] });
  assert.throws(() => answerFrom({}, cliResult({ is_error: true, result: "rate limited" })), /rate limited/);
});

test("the answer schema names only the tools this call offers", () => {
  const request = { model: "haiku", messages: [], tools: [TOOL, "write", { name: "search" }] };
  const args = cliArgs(request, "/tmp/s", { schema: true });
  const schema = JSON.parse(args[args.indexOf("--json-schema") + 1]);
  assert.deepEqual(schema.properties.toolCalls.items.properties.name.enum, ["search", "write"]);
  assert.deepEqual(toolAnswerSchema(request), schema);
  assert.deepEqual(toolAnswerSchema({ tools: ["fetch"] }).properties.toolCalls.items.properties.name.enum, ["fetch"]);
});

test("a tool call the call cannot take is dropped from the answer, and named", () => {
  assert.deepEqual(keepOffered({ tools: [TOOL] }, [{ name: "search", input: { query: "x" } }, { name: "draw_visual", input: {} }, { name: "search", input: "x" }]), {
    kept: [{ name: "search", input: { query: "x" } }],
    dropped: ["draw_visual", "search"],
  });
  const seen = [];
  const answer = answerFrom({ tools: ["search"] }, cliResult({ structured_output: { text: "Here.", toolCalls: [{ name: "draw_visual", input: {} }] } }), (names) => seen.push(...names));
  assert.deepEqual(answer, { text: "Here.", toolCalls: [] });
  assert.deepEqual(seen, ["draw_visual"]);
});

test("answers land where the gate reads them, and a tool the call did not offer is dropped, not a dead run", async () => {
  const { dir, calls } = await socketWith([{ model: "claude-haiku-4-5", messages: [{ role: "user", content: "hi" }], tools: [TOOL] }]);
  const good = () => Promise.resolve(cliResult({ structured_output: { text: "", toolCalls: [{ name: "search", input: { query: "hi" } }] } }));
  await answerOne(dir, calls[0], { cli: good });
  assert.deepEqual(await readdir(join(dir, "answers")), [`${calls[0].hash}.json`]);

  const other = await socketWith([{ model: "haiku", messages: [{ role: "user", content: "x" }], tools: [TOOL] }]);
  let tries = 0;
  const lines = [];
  const bad = () => {
    tries += 1;
    return Promise.resolve(cliResult({ structured_output: { text: "", toolCalls: [{ name: "delete_everything", input: {} }] } }));
  };
  const answer = await answerOne(other.dir, other.calls[0], { cli: bad, tries: 3, log: (line) => lines.push(line) });
  assert.deepEqual(answer, { text: "", toolCalls: [] });
  assert.equal(tries, 1, "a model's mistake is its answer, not a CLI failure to retry");
  assert.deepEqual(JSON.parse(await readFile(join(other.dir, "answers", `${other.calls[0].hash}.json`), "utf8")), { text: "" });
  assert.ok(lines.some((line) => /without 1 tool call\(s\) it does not offer: delete_everything/.test(line)));
});

test("a call the CLI keeps failing stays unanswered and stops the loop", async () => {
  const { dir } = await socketWith([{ model: "haiku", messages: [{ role: "user", content: "x" }] }]);
  let tries = 0;
  const failing = () => {
    tries += 1;
    return Promise.reject(new Error("overloaded"));
  };
  await assert.rejects(answerLoop(dir, { cli: failing, stopped: () => true, pollMs: 1 }), /failed 3 times/);
  assert.equal(tries, 3);
  assert.deepEqual(await readdir(join(dir, "answers")).catch(() => []), []);
});

test("the loop answers every waiting call, a few at a time, and ends once stopped and idle", async () => {
  const { dir, calls } = await socketWith([1, 2, 3, 4, 5].map((n) => ({ model: "haiku", messages: [{ role: "user", content: `q${n}` }] })));
  let running = 0;
  let most = 0;
  const cli = async (request) => {
    running += 1;
    most = Math.max(most, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running -= 1;
    return cliResult({ result: `answer to ${request.messages[0].content}` });
  };
  const answered = await answerLoop(dir, { cli, parallel: 2, stopped: () => true, pollMs: 1 });
  assert.equal(answered, calls.length);
  assert.ok(most <= 2, `at most 2 at once, saw ${most}`);
  assert.equal((await readdir(join(dir, "answers"))).length, calls.length);
});

test("a failed CLI run says why: the JSON result's error first, stderr after", () => {
  assert.equal(failureText(cliResult({ is_error: true, result: "Invalid bearer token" }), ""), "Invalid bearer token");
  assert.equal(failureText(cliResult({ result: "a model's private words" }), ""), "success", "a non-error result's text is never logged");
  assert.equal(failureText("", "boom"), "boom");
  assert.equal(failureText("", ""), "no output");
});

test("a call in Tex's own message shape reaches the CLI whole: text, tool calls and tool results", () => {
  const prompt = promptFor({
    messages: [
      { role: "user", text: "<job>\nBrief: find my dentist\n</job>" },
      { role: "assistant", text: "", toolCalls: [{ name: "search", args: { query: "dentist" } }] },
      { role: "tool", name: "search", text: "Dr. Ada, 555-0100", isError: false },
      { role: "tool", name: "browse", text: "timed out", isError: true },
    ],
  });
  assert.match(prompt, /Brief: find my dentist/);
  assert.match(prompt, /\[called tool search with \{"query":"dentist"\}\]/);
  assert.match(prompt, /\[result of tool call search\]\nDr\. Ada, 555-0100/);
  assert.match(prompt, /\[result of tool call browse \(error\)\]\ntimed out/);
});

const PICTURE = "AAAA-picture-bytes";
const notice = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: PICTURE } };

test("a picture stays in place between the words around it, in the Messages API's content", () => {
  const request = {
    model: "claude-haiku-5-5",
    messages: [{ role: "user", content: [{ type: "text", text: "What building is named here?" }, notice, { type: "text", text: "Answer with the name only." }] }],
  };
  const blocks = promptBlocks(request);
  assert.deepEqual(blocks.map((block) => block.type), ["text", "image", "text"]);
  assert.match(blocks[0].text, /What building is named here\?\n$/);
  assert.match(blocks[2].text, /Answer with the name only\./);
  assert.deepEqual(blocks[1], notice);
  assert.equal(JSON.stringify(blocks).includes("[an image]"), false, "no picture is written out as words");
});

test("a picture inside a tool result is collected too, after the result's words", () => {
  const request = {
    messages: [
      { role: "user", content: "read the notice" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "view", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "Notice:" }, notice] }] },
    ],
  };
  const blocks = promptBlocks(request);
  const at = blocks.findIndex((block) => block.type === "image");
  assert.ok(at > 0, "the picture is a block of its own");
  assert.match(blocks[at - 1].text, /\[result of tool call\]\nNotice:\n$/);
  assert.equal(blocks[at].source.data, PICTURE);
  assert.ok(blocks.slice(at + 1).every((block) => block.type === "text"));
});

test("a base64 PDF is a document block, and a text document is its words", () => {
  const pdf = { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBER" }, title: "lease.pdf" };
  const text = { type: "document", source: { type: "text", media_type: "text/plain", data: "Rent is due monthly." }, title: "memo" };
  const request = { messages: [{ role: "user", content: [text, pdf] }] };
  const blocks = promptBlocks(request);
  assert.deepEqual(blocks.map((block) => block.type), ["text", "document", "text"]);
  assert.match(blocks[0].text, /\[document: memo\]\nRent is due monthly\./);
  assert.deepEqual(blocks[1], pdf);
  assert.equal(promptFor(request).includes("JVBER"), false);
  assert.match(promptFor(request), /\[a PDF\]/);
});

test("Tex's own shape: pictures inline at their marker, attachments and tool images after the words", () => {
  const request = {
    messages: [
      {
        role: "user",
        text: "Look at [pic-1] please",
        pictures: [{ marker: "[pic-1]", mediaType: "image/png", data: "PNG1" }],
        attachments: [
          { name: "photo.jpg", mediaType: "image/jpeg", data: "JPG1" },
          { name: "lease.pdf", mediaType: "application/pdf", data: "PDF1" },
          { name: "notes.txt", mediaType: "text/plain", text: "not media here" },
        ],
      },
      { role: "tool", name: "view", text: "Shown.", images: [{ mediaType: "image/webp", data: "WEBP1" }] },
    ],
  };
  const blocks = promptBlocks(request);
  const images = blocks.filter((block) => block.type === "image").map((block) => block.source.data);
  assert.deepEqual(images, ["PNG1", "JPG1", "WEBP1"]);
  const pdf = blocks.find((block) => block.type === "document");
  assert.deepEqual(pdf.source, { type: "base64", media_type: "application/pdf", data: "PDF1" });
  assert.equal(pdf.title, "lease.pdf");
  const first = blocks.findIndex((block) => block.type === "image");
  assert.match(blocks[first - 1].text, /Look at \[pic-1\]$/, "the marker stays in the words, the picture follows it");
  assert.match(blocks[first + 1].text, /^ please/);
  assert.match(blocks.map((block) => block.text ?? "").join("|"), /\[result of tool call view\]\nShown\./);
  assert.match(promptFor(request), /Look at \[pic-1\]\[an image\] please/);
  assert.equal(hasMedia(request), true);
});

test("promptFor on a call with no media is the same words as before", () => {
  const request = {
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "yo" }] },
    ],
  };
  assert.equal(
    promptFor(request),
    [
      "Below is a conversation so far. Write the next assistant turn, exactly as you would send it, following the system prompt.",
      "",
      "<conversation>",
      "<user>",
      "hi",
      "</user>",
      "",
      "<assistant>",
      "yo",
      "</assistant>",
      "</conversation>",
    ].join("\n"),
  );
  assert.deepEqual(promptBlocks(request), [{ type: "text", text: promptFor(request) }]);
});

test("hasMedia is false for text-only calls and true when a picture or PDF is in the call", () => {
  assert.equal(hasMedia({ messages: [{ role: "user", content: "just words" }], tools: [TOOL] }), false);
  assert.equal(hasMedia({ messages: [{ role: "user", content: [notice] }] }), true);
  assert.equal(hasMedia({ messages: [{ role: "user", text: "", attachments: [{ name: "a.pdf", mediaType: "application/pdf", data: "x" }] }] }), true);
  assert.equal(hasMedia({ messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://example.test/a.png" } }] }] }), false, "a URL picture is not sent, so it is not media");
});

test("cliArgs with media reads and writes stream-json, verbose, and no plain json output", () => {
  const args = cliArgs({ model: "claude-haiku-5-5", messages: [] }, "/tmp/sys.txt", { media: true });
  assert.equal(args[args.indexOf("--input-format") + 1], "stream-json");
  assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
  assert.ok(args.includes("--verbose"));
  assert.equal(args.includes("json"), false);
  assert.equal(args.filter((arg) => arg === "--output-format").length, 1);
  assert.deepEqual(cliArgs({ model: "haiku", messages: [] }, "/tmp/s"), cliArgs({ model: "haiku", messages: [] }, "/tmp/s", { media: false }));
  assert.equal(cliArgs({ model: "haiku", messages: [] }, "/tmp/s").includes("--input-format"), false, "text calls keep their args");
});

test("resultOf takes the one JSON value, or the last result line of a stream", () => {
  assert.deepEqual(resultOf(cliResult({ result: "one" })), { type: "result", subtype: "success", is_error: false, result: "one" });
  const stream = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } }),
    cliResult({ result: "the answer", duration_api_ms: 900, num_turns: 1 }),
    "",
  ].join("\n");
  assert.equal(resultOf(stream).result, "the answer");
  assert.throws(() => resultOf('{"type":"system","subtype":"init"}\n{"type":"assistant"}\n'), /no result/);
  assert.throws(() => resultOf(""), /no result/);
});

test("answerOne reads the answer from a stream-json run, not only a single JSON value", async () => {
  const { dir, calls } = await socketWith([{ model: "claude-haiku-5-5", system: "Be terse.", messages: [{ role: "user", content: [{ type: "text", text: "Name it." }, notice] }] }]);
  const stdout = [
    JSON.stringify({ type: "system", subtype: "init", model: "claude-haiku-5-5" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Ocean View Flats" }] } }),
    cliResult({ result: "Ocean View Flats", duration_api_ms: 800, num_turns: 1 }),
  ].join("\n");
  const answer = await answerOne(dir, calls[0], { cli: async () => stdout });
  assert.deepEqual(answer, { text: "Ocean View Flats" });
  assert.deepEqual(JSON.parse(await readFile(join(dir, "answers", `${calls[0].hash}.json`), "utf8")), { text: "Ocean View Flats" });
});

test("a failed stream-json run names its error from the result line, and a non-error one is never logged", () => {
  const failed = [JSON.stringify({ type: "system" }), cliResult({ is_error: true, result: "Invalid bearer token" })].join("\n");
  assert.equal(failureText(failed, ""), "Invalid bearer token");
  const passed = [JSON.stringify({ type: "system" }), cliResult({ result: "a model's private words" })].join("\n");
  assert.equal(failureText(passed, ""), "success");
});
