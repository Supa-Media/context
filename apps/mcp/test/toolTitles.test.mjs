/**
 * Every tool carries a `title`: the human-readable name MCP added in the
 * 2025-06-18 revision, which clients show instead of the programmatic `name`.
 *
 * Claude's Connectors Directory requires one on every tool and its submission
 * portal flags any tool without one, so a tool added without a title blocks
 * the listing. Older clients ignore the field.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { toolDefinitions } from "../src/tools/registry.js";

const tools = toolDefinitions();

test("every advertised tool has a title", () => {
  const missing = tools.filter((tool) => typeof tool.title !== "string" || tool.title.trim() === "").map((tool) => tool.name);
  assert.deepEqual(missing, []);
});

test("titles are short, human names rather than the programmatic name", () => {
  for (const tool of tools) {
    assert.ok(tool.title.length <= 40, `${tool.name}: title longer than 40 characters`);
    assert.notEqual(tool.title, tool.name, `${tool.name}: title repeats the name`);
    assert.ok(!/_/.test(tool.title), `${tool.name}: title contains an underscore`);
  }
});

test("no two tools share a title", () => {
  const seen = new Map();
  for (const tool of tools) {
    assert.ok(!seen.has(tool.title), `${tool.name} and ${seen.get(tool.title)} share the title "${tool.title}"`);
    seen.set(tool.title, tool.name);
  }
});

/*
 * Both directories read the behaviour hints as well as the title: Claude's
 * wants readOnlyHint or destructiveHint on every tool, and ChatGPT's also
 * checks openWorldHint and rejects a listing whose hints misstate what a tool
 * does. So every tool states all three explicitly, and the tools that can
 * publish past the workspace say so.
 */
test("every advertised tool states readOnlyHint, destructiveHint and openWorldHint", () => {
  const missing = [];
  for (const tool of tools) {
    const hints = tool.annotations ?? {};
    for (const hint of ["readOnlyHint", "destructiveHint", "openWorldHint"]) {
      if (typeof hints[hint] !== "boolean") missing.push(`${tool.name}.${hint}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("tools that can publish to people with no account are marked open world", () => {
  for (const name of ["write_note", "create_link"]) {
    const tool = tools.find((candidate) => candidate.name === name);
    assert.equal(tool?.annotations?.openWorldHint, true, `${name}: can publish outside the workspace`);
  }
});
