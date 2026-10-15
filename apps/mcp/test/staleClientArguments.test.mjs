/**
 * Arguments from a client whose copy of a tool predates them.
 *
 * Measured on production, 2026-10-15: Claude Code, holding an `orient` schema
 * with no `tools` property, sent `tools: true` as the string "true", and the
 * gateway refused it. A client that does not know a property's type sends
 * what the model wrote as text, so every non-string argument added after a
 * client connected arrived as a string and was refused, which defeats the
 * live tool list's "pass it even where your copy does not show it".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { coercedArguments, toolArgumentRefusal } from "../src/tools/advertised.js";

test("a boolean sent as text is read as the boolean", () => {
  assert.deepEqual(coercedArguments("orient", { tools: "true" }), { tools: true });
  assert.deepEqual(coercedArguments("orient", { tools: "false" }), { tools: false });
  assert.equal(toolArgumentRefusal("orient", coercedArguments("orient", { tools: "true" }), "team"), null);
});

test("an integer sent as text is read as the integer, and only a whole one", () => {
  assert.deepEqual(coercedArguments("list_meetings", { limit: "5" }), { limit: 5 });
  assert.deepEqual(coercedArguments("list_meetings", { limit: "5.5" }), { limit: "5.5" });
  assert.deepEqual(coercedArguments("list_meetings", { limit: "5 " }), { limit: "5 " });
});

test("an object or array sent as JSON text is read as that object or array", () => {
  const moves = [{ source: "a.md", destination: "b.md" }];
  assert.deepEqual(coercedArguments("move_notes", { moves: JSON.stringify(moves) }), { moves });
  const comment = { action: "add", quote: "x", text: "y" };
  assert.deepEqual(coercedArguments("write_note", { path: "a.md", comment: JSON.stringify(comment) }), {
    path: "a.md",
    comment,
  });
  // JSON of the wrong shape is left alone, so validation refuses it as before.
  assert.deepEqual(coercedArguments("move_notes", { moves: '{"a":1}' }), { moves: '{"a":1}' });
  assert.deepEqual(coercedArguments("move_notes", { moves: "not json" }), { moves: "not json" });
});

test("a property that takes text is never reinterpreted", () => {
  assert.deepEqual(coercedArguments("read_note", { path: "true" }), { path: "true" });
  assert.deepEqual(coercedArguments("write_note", { path: "a.md", content: '{"a":1}' }), {
    path: "a.md",
    content: '{"a":1}',
  });
  assert.deepEqual(coercedArguments("orient", { context: "@x", tools: "yes" }), { context: "@x", tools: "yes" });
});

test("an unknown tool, an unknown property and a non-object pass through untouched", () => {
  const args = { tools: "true" };
  assert.equal(coercedArguments("no_such_tool", args), args);
  assert.deepEqual(coercedArguments("orient", { other: "true" }), { other: "true" });
  assert.equal(coercedArguments("orient", undefined), undefined);
  assert.deepEqual(coercedArguments("orient", ["true"]), ["true"]);
});

test("what is still wrong after reading is still refused", () => {
  assert.match(toolArgumentRefusal("orient", coercedArguments("orient", { tools: "yes" }), "team"), /boolean/);
});
