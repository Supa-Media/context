// Tests for bench/report.mjs. All names and values are invented fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { priceUsd, resultMarkdown } from "../report.mjs";

const fixture = {
  job: "texting-assistant",
  test: "texting-assistant",
  testVersion: "a1b2c3d4e5f6",
  date: "2026-10-08",
  commit: "55db45c",
  playedBy: "claude-sonnet-5-5",
  setups: [
    { name: "production", version: "de6c72003282", model: "anthropic/claude-haiku-5-5" },
    { name: "glm-trial", version: "0123456789ab", model: "@cf/zai-org/glm-4.7-flash" },
  ],
  runs: [
    {
      setup: "production", question: 1, questionText: "When's my dentist appointment?", as: "Maya", kind: "lookup", gate: false,
      run: 1,
      conversation: [
        { from: "person", text: "when's my dentist appointment?" },
        { from: "assistant", text: "Sure.\n# Injected heading\nIt is Tuesday at 9am." },
      ],
      tools: ["search_notes", "read_note"],
      changes: [{ workspace: "maya", path: "todo.md", kind: "proposed", detail: "add dentist reminder" }],
      ms: 4210, usage: { input: 1200, output: 80, cacheRead: 0, cacheWrite: 0 }, model: "anthropic/claude-haiku-5-5",
      texts: 1, error: null,
    },
    {
      setup: "production", question: 1, questionText: "When's my dentist appointment?", as: "Maya", kind: "lookup", gate: false,
      run: 2,
      conversation: [
        { from: "person", text: "when's my dentist appointment?" },
        { from: "assistant", text: "Tuesday at 9am." },
      ],
      tools: ["search_notes"],
      changes: [],
      ms: 2900, usage: { input: 900, output: 30 }, model: "anthropic/claude-haiku-5-5",
      texts: 1, error: null,
    },
    {
      setup: "production", question: 2, questionText: "Delete my old grocery list", as: "Sam", kind: "edit", gate: true,
      run: 1,
      conversation: [
        { from: "person", text: "delete the old grocery list" },
        { from: "assistant", text: "Done, I removed it." },
      ],
      tools: ["delete_note"],
      changes: [{ workspace: "sam", path: "groceries.md", kind: "deleted", detail: "old list" }],
      ms: 1500, usage: { input: 700, output: 40, cacheRead: 200 }, model: "anthropic/claude-haiku-5-5",
      texts: 1, error: null,
    },
    {
      setup: "production", question: 2, questionText: "Delete my old grocery list", as: "Sam", kind: "edit", gate: true,
      run: 2,
      conversation: [{ from: "person", text: "delete the old grocery list" }],
      tools: [],
      changes: [],
      ms: 900, usage: { input: 300 }, model: "anthropic/claude-haiku-5-5",
      texts: 0, error: "tool timeout",
    },
    {
      setup: "glm-trial", question: 1, questionText: "When's my dentist appointment?", as: "Maya", kind: "lookup", gate: false,
      run: 1,
      conversation: [
        { from: "person", text: "when's my dentist appointment?" },
        { from: "assistant", text: "Tuesday at 9am." },
      ],
      tools: ["search_notes"],
      changes: [],
      ms: 3100, usage: { input: 1000, output: 20 }, model: "@cf/zai-org/glm-4.7-flash",
      texts: 1, error: null,
    },
    {
      setup: "glm-trial", question: 1, questionText: "When's my dentist appointment?", as: "Maya", kind: "lookup", gate: false,
      run: 2,
      conversation: [
        { from: "person", text: "when's my dentist appointment?" },
        { from: "assistant", text: "Your dentist is on Tuesday." },
      ],
      tools: ["search_notes", "read_note"],
      changes: [],
      ms: 5300, usage: { input: 1100, output: 25, cacheRead: 500 }, model: "@cf/zai-org/glm-4.7-flash",
      texts: 1, error: null,
    },
    {
      setup: "glm-trial", question: 2, questionText: "Delete my old grocery list", as: "Sam", kind: "edit", gate: true,
      run: 1,
      conversation: [
        { from: "person", text: "delete the old grocery list" },
        { from: "assistant", text: "I can't see that list." },
      ],
      tools: ["search_notes"],
      changes: [],
      ms: 2000, usage: { input: 500, output: 10 }, model: "vendor/mystery-1",
      texts: 1, error: null,
    },
    {
      setup: "glm-trial", question: 2, questionText: "Delete my old grocery list", as: "Sam", kind: "edit", gate: true,
      run: 2,
      conversation: [
        { from: "person", text: "delete the old grocery list" },
        { from: "assistant", text: "Which list do you mean?" },
      ],
      tools: [],
      changes: [],
      ms: 2600, usage: { input: 600, output: 12 }, model: "@cf/zai-org/glm-4.7-flash",
      texts: 1, error: null,
    },
  ],
};

// Expected output for the fixture above, reviewed by hand.
const SNAPSHOT = [
  "---",
  "job: texting-assistant",
  "test: texting-assistant",
  "test_version: a1b2c3d4e5f6",
  "date: 2026-10-08",
  "code_commit: 55db45c",
  "played_by: claude-sonnet-5-5",
  "setups: [production@de6c72003282, glm-trial@0123456789ab]",
  "runs_per_question: 2",
  "status: not judged",
  "---",
  "",
  "# texting-assistant run, 2026-10-08",
  "",
  "This run asked 2 questions, 2 runs each, against 2 setups.",
  "",
  "Moves, edits and texts below were recorded, never carried out.",
  "",
  "## Summary",
  "",
  "| Setup | Model | Answers | Errors | Median time | Price per question | Texts per question |",
  "| --- | --- | --- | --- | --- | --- | --- |",
  "| production | anthropic/claude-haiku-5-5 | 3 | 1 | 2.2 s | $0.0001 | 0.8 |",
  "| glm-trial | @cf/zai-org/glm-4.7-flash | 4 | 0 | 2.9 s | unknown | 1.0 |",
  "",
  "## Answers",
  "",
  "### 1. When's my dentist appointment?",
  "",
  "as Maya, lookup",
  "",
  "#### production, run 1",
  "",
  "**Person:** when's my dentist appointment?",
  "",
  "**Assistant:** Sure.",
  "\\# Injected heading",
  "It is Tuesday at 9am.",
  "",
  "Tools: search_notes, read_note",
  "",
  "Changes recorded:",
  "",
  "- proposed maya/todo.md: add dentist reminder",
  "",
  "Time 4.2 s, $0.0002, 1 text",
  "",
  "#### production, run 2",
  "",
  "**Person:** when's my dentist appointment?",
  "",
  "**Assistant:** Tuesday at 9am.",
  "",
  "Tools: search_notes",
  "",
  "Time 2.9 s, $0.0001, 1 text",
  "",
  "#### glm-trial, run 1",
  "",
  "**Person:** when's my dentist appointment?",
  "",
  "**Assistant:** Tuesday at 9am.",
  "",
  "Tools: search_notes",
  "",
  "Time 3.1 s, $0.0001, 1 text",
  "",
  "#### glm-trial, run 2",
  "",
  "**Person:** when's my dentist appointment?",
  "",
  "**Assistant:** Your dentist is on Tuesday.",
  "",
  "Tools: search_notes, read_note",
  "",
  "Time 5.3 s, $0.0001, 1 text",
  "",
  "### 2. Delete my old grocery list",
  "",
  "as Sam, edit, gate",
  "",
  "#### production, run 1",
  "",
  "**Person:** delete the old grocery list",
  "",
  "**Assistant:** Done, I removed it.",
  "",
  "Tools: delete_note",
  "",
  "Changes recorded:",
  "",
  "- deleted sam/groceries.md: old list",
  "",
  "Time 1.5 s, $0.0001, 1 text",
  "",
  "#### production, run 2",
  "",
  "**Person:** delete the old grocery list",
  "",
  "Tools: none",
  "",
  "Error: tool timeout",
  "",
  "#### glm-trial, run 1",
  "",
  "**Person:** delete the old grocery list",
  "",
  "**Assistant:** I can't see that list.",
  "",
  "Tools: search_notes",
  "",
  "Time 2.0 s, unknown, 1 text",
  "",
  "#### glm-trial, run 2",
  "",
  "**Person:** delete the old grocery list",
  "",
  "**Assistant:** Which list do you mean?",
  "",
  "Tools: none",
  "",
  "Time 2.6 s, $0.0000, 1 text",
  "",
  "## Judging",
  "",
  "Not judged yet. Add a `## Judged by <model>, <date>` section; never edit an earlier one.",
  "",
].join("\n");

test("priceUsd prices haiku under both names", () => {
  const usage = { input: 1000000, output: 1000000, cacheRead: 1000000, cacheWrite: 1000000 };
  // 0.10 + 0.50 + 0.01 + 0.125
  assert.equal(priceUsd("anthropic/claude-haiku-5-5", usage), 0.735);
  assert.equal(priceUsd("claude-haiku-5-5", usage), 0.735);
});

test("priceUsd prices sonnet under both names", () => {
  const usage = { input: 1000000, output: 1000000, cacheRead: 1000000, cacheWrite: 1000000 };
  // 3 + 15 + 0.30 + 3.75
  assert.equal(priceUsd("anthropic/claude-sonnet-5-5", usage), 22.05);
  assert.equal(priceUsd("claude-sonnet-5-5", usage), 22.05);
});

test("priceUsd bills glm cache tokens at the input rate", () => {
  const usage = { input: 1000000, output: 1000000, cacheRead: 1000000, cacheWrite: 1000000 };
  // 0.06 + 0.40 + 0.06 + 0.06
  assert.equal(priceUsd("@cf/zai-org/glm-4.7-flash", usage), 0.58);
});

test("priceUsd returns null for an unknown model", () => {
  assert.equal(priceUsd("vendor/mystery-1", { input: 1 }), null);
  assert.equal(priceUsd("constructor", { input: 1 }), null);
});

test("priceUsd counts missing usage fields as zero", () => {
  assert.equal(priceUsd("claude-haiku-5-5", { input: 1000000 }), 0.1);
  assert.equal(priceUsd("claude-haiku-5-5", {}), 0);
  assert.equal(priceUsd("claude-haiku-5-5", undefined), 0);
});

test("full result matches the reviewed snapshot", () => {
  assert.equal(resultMarkdown(fixture), SNAPSHOT);
});

test("front matter carries the run values", () => {
  const head = resultMarkdown(fixture).split("\n---\n")[0].split("\n");
  assert.equal(head[0], "---");
  assert.ok(head.includes("job: texting-assistant"));
  assert.ok(head.includes("test_version: a1b2c3d4e5f6"));
  assert.ok(head.includes("code_commit: 55db45c"));
  assert.ok(head.includes("played_by: claude-sonnet-5-5"));
  assert.ok(head.includes("setups: [production@de6c72003282, glm-trial@0123456789ab]"));
  assert.ok(head.includes("runs_per_question: 2"));
  assert.ok(head.includes("status: not judged"));
});

test("played_by is omitted when null", () => {
  const md = resultMarkdown({ ...fixture, playedBy: null });
  assert.ok(!md.includes("played_by"));
});

test("assistant lines that start with # cannot create headings", () => {
  const md = resultMarkdown(fixture);
  const headings = md.split("\n").filter((line) => /^#/.test(line));
  assert.ok(!headings.includes("# Injected heading"));
  assert.ok(md.includes("\\# Injected heading"));
});

test("median of an even count averages the two middle values", () => {
  const times = [1000, 2000, 3000, 10000];
  const runs = times.map((ms, i) => ({
    ...fixture.runs[0], run: i + 1, ms, error: null, texts: 1, changes: [],
  }));
  const md = resultMarkdown({ ...fixture, setups: [fixture.setups[0]], runs });
  // (2000 + 3000) / 2 = 2500 ms
  assert.match(md, /\| production \| anthropic\/claude-haiku-5-5 \| 4 \| 0 \| 2\.5 s \|/);
});

test("median of an odd count is the middle value", () => {
  const runs = [1000, 5000, 2000].map((ms, i) => ({
    ...fixture.runs[0], run: i + 1, ms, error: null, texts: 1, changes: [],
  }));
  const md = resultMarkdown({ ...fixture, setups: [fixture.setups[0]], runs });
  assert.match(md, /\| 2\.0 s \|/);
});

test("a null price shows as unknown per run and per setup", () => {
  const md = resultMarkdown(fixture);
  assert.ok(md.includes("Time 2.0 s, unknown, 1 text"));
  assert.ok(md.includes("| glm-trial | @cf/zai-org/glm-4.7-flash | 4 | 0 | 2.9 s | unknown | 1.0 |"));
});

test("an errored run shows its error instead of a time line", () => {
  const md = resultMarkdown(fixture);
  assert.ok(md.includes("Error: tool timeout"));
  assert.ok(!/Time [^\n]*\n\n#### glm-trial/.test(md.split("#### production, run 2")[1].split("#### glm-trial")[0]));
});

test("the judging section is present and the note says it is not judged", () => {
  const md = resultMarkdown(fixture);
  assert.ok(md.endsWith("## Judging\n\nNot judged yet. Add a `## Judged by <model>, <date>` section; never edit an earlier one.\n"));
});
