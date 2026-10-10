/**
 * The search settings a deployment or a setup chooses (`src/search/settings.js`):
 * read from the Worker's var, read from a setup's `search:` section, bounded,
 * and laid one over the other.
 *
 * Sabotage record (temporary local edits, reverted):
 *   `readSearchSettings` not checking bounds        → "a value out of bounds refuses the whole section" fails
 *   `searchSettingsFor` throwing on bad JSON         → "a var that does not parse is the defaults" fails
 *   `parseSetup` ignoring an invalid `search:`       → "a setup whose search section is wrong is refused whole" fails
 */

import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SEARCH_SETTINGS, readSearchSettings, searchSettingsFor, searchSettingsOf, wireSearchSettings } from "../src/search/settings.js";
import { parseSearchSetup, parseSetup } from "../src/agent/production.js";

test("a section's keys are read, checked and renamed; what it leaves out stays out", () => {
  assert.deepEqual(readSearchSettings({ everywhere: "true", min_score: "0.35", extra_notes: "6", snippet_chars: "600" }), {
    everywhere: true,
    minScore: 0.35,
    extraNotes: 6,
    snippetChars: 600,
  });
  assert.deepEqual(readSearchSettings({ everywhere: false }), { everywhere: false });
  assert.deepEqual(readSearchSettings({}), {});
  assert.deepEqual(readSearchSettings(undefined), {});
});

test("a value out of bounds, a key it does not know, or a shape that is not a map refuses the whole section", () => {
  for (const bad of [
    { min_score: "1.5" },
    { min_score: "-0.1" },
    { extra_notes: "11" },
    { extra_notes: "2.5" },
    { snippet_chars: "10" },
    { snippet_chars: "5000" },
    { everywhere: "yes" },
    { reads: "3" },
    ["min_score"],
    "min_score: 0.3",
  ]) {
    assert.equal(readSearchSettings(bad), null, JSON.stringify(bad));
  }
});

test("the deployment's var lays over the defaults; a var that does not parse is the defaults", () => {
  assert.deepEqual(searchSettingsFor({}), DEFAULT_SEARCH_SETTINGS);
  assert.deepEqual(searchSettingsFor({ SEARCH_SETTINGS: '{"everywhere": true, "min_score": 0.3}' }), { ...DEFAULT_SEARCH_SETTINGS, everywhere: true, minScore: 0.3 });
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(searchSettingsFor({ SEARCH_SETTINGS: "not json" }), DEFAULT_SEARCH_SETTINGS);
    assert.deepEqual(searchSettingsFor({ SEARCH_SETTINGS: '{"min_score": 7}' }), DEFAULT_SEARCH_SETTINGS);
  } finally {
    console.error = quiet;
  }
});

test("a setup's section lays over the store's, which lays over the defaults", () => {
  const store = { searchSettings: { ...DEFAULT_SEARCH_SETTINGS, minScore: 0.3 } };
  assert.deepEqual(searchSettingsOf(store), { ...DEFAULT_SEARCH_SETTINGS, minScore: 0.3 });
  assert.deepEqual(searchSettingsOf(store, { everywhere: true }), { ...DEFAULT_SEARCH_SETTINGS, minScore: 0.3, everywhere: true });
  assert.deepEqual(searchSettingsOf({}), DEFAULT_SEARCH_SETTINGS);
});

const file = (front) => `---\njob: texting-assistant\n${front}\n---\n\nYou are a test assistant.\n`;

test("a texting setup may carry a search section, and one whose section is wrong is refused whole", async () => {
  const setup = await parseSetup(file("models:\n  main: anthropic/claude-haiku-5-5\nsearch:\n  everywhere: true\n  extra_notes: 6"));
  assert.deepEqual(setup?.search, { everywhere: true, extraNotes: 6 });
  assert.equal((await parseSetup(file("models:\n  main: anthropic/claude-haiku-5-5")))?.search, null, "none named is none");
  assert.equal(await parseSetup(file("models:\n  main: anthropic/claude-haiku-5-5\nsearch:\n  min_score: 3")), null);
  assert.equal(await parseSetup(file("models:\n  main: anthropic/claude-haiku-5-5\nsearch: wide")), null);
});

test("a search setup names the job and its settings, and nothing else is one", async () => {
  const setup = await parseSearchSetup("---\njob: search\nsearch:\n  everywhere: true\n  min_score: 0.35\n---\n\nWhy this setting.\n");
  assert.deepEqual(setup?.search, { everywhere: true, minScore: 0.35 });
  assert.match(setup.version, /^[0-9a-f]{12}$/);
  assert.equal(await parseSearchSetup("---\njob: texting-assistant\nsearch:\n  everywhere: true\n---\n\nx\n"), null, "another job's file");
  assert.equal(await parseSearchSetup("---\njob: search\n---\n\nx\n"), null, "no section");
  assert.equal(await parseSearchSetup("---\njob: search\nsearch:\n  extra_notes: 40\n---\n\nx\n"), null, "out of bounds");
});

test("settings go back to the var's names and read again as themselves", () => {
  const settings = { everywhere: true, minScore: 0.3, extraNotes: 6, snippetChars: 600 };
  const wire = wireSearchSettings(settings);
  assert.deepEqual(wire, { everywhere: true, min_score: 0.3, extra_notes: 6, snippet_chars: 600 });
  assert.deepEqual(searchSettingsFor({ SEARCH_SETTINGS: JSON.stringify(wire) }), { ...DEFAULT_SEARCH_SETTINGS, ...settings });
});
