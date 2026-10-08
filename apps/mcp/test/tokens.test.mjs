/**
 * Counting tokens in what crosses the MCP boundary (`src/mcp/tokens.js`).
 *
 * Bytes, characters and tokens are three different numbers, and these checks
 * keep them apart: a multi-byte string is measured in bytes for the size limit
 * and in tokens for the count, and never as `.length`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { countTokens, estimateTokens, requestText, responseParts } from "../src/mcp/tokens.js";

test("ASCII is counted exactly", async () => {
  assert.deepEqual(await countTokens("hello world"), { count: 2, method: "exact" });
});

test("empty and non-string input count zero", async () => {
  assert.deepEqual(await countTokens(""), { count: 0, method: "exact" });
  assert.deepEqual(await countTokens(undefined), { count: 0, method: "exact" });
});

test("multi-byte text is tokenized, not measured by length", async () => {
  const text = "日本語のノート 🎉 ünïcödé";
  const { count, method } = await countTokens(text);
  assert.equal(method, "exact");
  assert.ok(count > 0);
  assert.notEqual(count, text.length);
});

test("over 64 KB is estimated from UTF-8 bytes, not characters", async () => {
  const text = "é".repeat(40 * 1024); // 40 Ki characters, 80 KiB
  const { count, method } = await countTokens(text);
  assert.equal(method, "estimated");
  assert.equal(count, estimateTokens(80 * 1024));
});

test("exactly at the limit is still exact", async () => {
  const { method } = await countTokens("a".repeat(64 * 1024));
  assert.equal(method, "exact");
});

test("the request is the tool name and arguments", () => {
  assert.equal(
    requestText({ name: "read_note", arguments: { path: "a.md" } }),
    '{"name":"read_note","arguments":{"path":"a.md"}}',
  );
  assert.equal(requestText(undefined), '{"name":"","arguments":{}}');
});

test("the response is text and structured content; images are counted, not read", () => {
  const parts = responseParts({
    content: [
      { type: "text", text: "one" },
      { type: "image", data: "iVBORw0KGgo".repeat(1000), mimeType: "image/png" },
      { type: "resource", resource: { uri: "x", text: "two" } },
    ],
    structuredContent: { ok: true },
  });
  assert.equal(parts.text, 'one\ntwo\n{"ok":true}');
  assert.equal(parts.images, 1);
});

test("a thrown dispatch (null result) has nothing to read", () => {
  assert.deepEqual(responseParts(null), { text: "", images: 0 });
});

test("a long run with no whitespace cannot burn minutes of CPU", async () => {
  // Uncut, this took 263 s: BPE merging is quadratic in one word's length.
  const started = performance.now();
  const { method } = await countTokens("a".repeat(64 * 1024));
  assert.equal(method, "exact");
  assert.ok(performance.now() - started < 5_000);
});

test("chunking loses no text and barely moves an ordinary count", async () => {
  const { chunksOf } = await import("../src/mcp/tokens.js");
  const { Tiktoken } = await import("js-tiktoken/lite");
  const { default: ranks } = await import("js-tiktoken/ranks/o200k_base");
  const md = "# Note\n\nSome **markdown**, ünïcode 日本語 🎉.\n  - item\n\t- two\n{\"json\": [1, 2]}\n";
  const text = md.repeat(400);
  assert.equal([...chunksOf(text)].join(""), text);
  const whole = new Tiktoken(ranks).encode(text).length;
  const { count } = await countTokens(text);
  assert.ok(Math.abs(count - whole) / whole < 0.01, `${count} vs ${whole}`);
});
