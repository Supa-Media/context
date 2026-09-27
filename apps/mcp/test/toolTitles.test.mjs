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
