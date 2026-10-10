// Tests for bench/report.mjs. All names and values are invented fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assignIds, keyMarkdown, priceUsd, resultMarkdown } from "../report.mjs";
import { WORDS } from "../words.mjs";

const fixture = {
  job: "texting-assistant",
  test: "texting-assistant",
  testVersion: "a1b2c3d4e5f6",
  date: "2026-10-08",
  today: "2026-10-08",
  commit: "55db45c",
  resultFile: "2026-10-08 texting-assistant.md",
  keyFile: "2026-10-08 texting-assistant key.md",
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
  "today: 2026-10-08",
  "code_commit: 55db45c",
  "played_by: claude-sonnet-5-5",
  "setups: [production@de6c72003282, glm-trial@0123456789ab]",
  "runs_per_question: 2",
  "key: 2026-10-08 texting-assistant key.md",
  "status: not judged",
  "---",
  "",
  "# texting-assistant run, 2026-10-08",
  "",
  "Answers are named by id. The key file maps ids to setups; a judge never opens it.",
  "",
  "This run asked 2 questions, 2 runs each, against 2 setups.",
  "",
  "Moves, edits and texts below were recorded, never carried out.",
  "",
  "## Summary",
  "",
  "| Setup | Model | Answers | Errors | Median time | Price per question | Texts per question | Failed tool calls |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
  "| production | anthropic/claude-haiku-5-5 | 3 | 1 | 2.2 s | $0.0001 | 0.8 | 0 |",
  "| glm-trial | @cf/zai-org/glm-4.7-flash | 4 | 0 | 2.9 s | unknown | 1.0 | 0 |",
  "",
  "## Answers",
  "",
  "### 1. When's my dentist appointment?",
  "",
  "as Maya, lookup",
  "",
  "#### bucket-koala-brush-dew",
  "",
  "**Person:** when's my dentist appointment?",
  "",
  "**Assistant:** Your dentist is on Tuesday.",
  "",
  "Tools: search_notes, read_note",
  "",
  "Time 5.3 s, $0.0001, 1 text",
  "",
  "#### cargo-ruby-drift-paper",
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
  "#### coral-cotton-quartz-pine",
  "",
  "**Person:** when's my dentist appointment?",
  "",
  "**Assistant:** Tuesday at 9am.",
  "",
  "Tools: search_notes",
  "",
  "Time 2.9 s, $0.0001, 1 text",
  "",
  "#### shore-paper-oyster-tide",
  "",
  "**Person:** when's my dentist appointment?",
  "",
  "**Assistant:** Tuesday at 9am.",
  "",
  "Tools: search_notes",
  "",
  "Time 3.1 s, $0.0001, 1 text",
  "",
  "### 2. Delete my old grocery list",
  "",
  "as Sam, edit, gate",
  "",
  "#### bamboo-cloak-shade-air",
  "",
  "**Person:** delete the old grocery list",
  "",
  "**Assistant:** I can't see that list.",
  "",
  "Tools: search_notes",
  "",
  "Time 2.0 s, unknown, 1 text",
  "",
  "#### earth-pocket-torch-arrow",
  "",
  "**Person:** delete the old grocery list",
  "",
  "Tools: none",
  "",
  "Error: tool timeout",
  "",
  "#### sparrow-mist-bell-thyme",
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
  "#### sparrow-pigeon-almond-puffin",
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
  "Judgments are added below as `## Judged by <model>, <date>` sections; never edit an earlier one.",
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
  // 2 + 10 + 0.20 + 2.50
  assert.equal(priceUsd("anthropic/claude-sonnet-5-5", usage), 14.7);
  assert.equal(priceUsd("claude-sonnet-5-5", usage), 14.7);
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

test("front matter records the pinned day, or says the run used the real one", () => {
  assert.ok(resultMarkdown(fixture).includes("\ntoday: 2026-10-08\n"));
  const real = resultMarkdown({ ...fixture, today: undefined });
  assert.ok(real.includes("\ntoday: real\n"));
  assert.ok(!real.includes("today: 2026-10-08"));
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
  // fixture.runs[3] is the errored run; its block is headed by its id.
  const errored = assignIds(fixture)[3].id;
  const block = md.split(`#### ${errored}\n`)[1].split("\n#### ")[0];
  assert.ok(block.includes("Error: tool timeout"));
  assert.ok(!/^Time /m.test(block));
});

test("the judging section says judgments are appended below", () => {
  const md = resultMarkdown(fixture);
  assert.ok(md.endsWith("## Judging\n\nJudgments are added below as `## Judged by <model>, <date>` sections; never edit an earlier one.\n"));
});

// ---- answer ids and the key file ----

const ID = /^[a-z]+-[a-z]+-[a-z]+-[a-z]+$/;
const idRows = (result) => assignIds(result).map((r) => [r.setup, r.question, r.run, r.id]);

test("the word list has at least 200 distinct words", () => {
  assert.ok(WORDS.length >= 200);
  assert.equal(new Set(WORDS).size, WORDS.length);
});

test("every run gets four words from the list, joined by hyphens", () => {
  for (const run of assignIds(fixture)) {
    assert.match(run.id, ID);
    for (const word of run.id.split("-")) assert.ok(WORDS.includes(word), `${word} is not in the list`);
  }
});

test("ids are deterministic: the same run gets the same id in any order", () => {
  assert.deepEqual(idRows(fixture), idRows(fixture));
  const reversed = { ...fixture, runs: [...fixture.runs].reverse() };
  const byKey = (rows) => Object.fromEntries(rows.map(([s, q, n, id]) => [`${s}/${q}/${n}`, id]));
  assert.deepEqual(byKey(idRows(reversed)), byKey(idRows(fixture)));
});

test("an id depends on the test version and on the setup version", () => {
  const base = assignIds(fixture)[0].id;
  assert.notEqual(assignIds({ ...fixture, testVersion: "ffffffffffff" })[0].id, base);
  const bumped = { ...fixture, setups: fixture.setups.map((s) => (s.name === "production" ? { ...s, version: "111111111111" } : s)) };
  assert.notEqual(assignIds(bumped)[0].id, base);
});

test("ids are unique within a run, even when two runs share an identity", () => {
  const dup = { ...fixture, runs: [fixture.runs[0], fixture.runs[0], fixture.runs[1]] };
  const ids = assignIds(dup).map((r) => r.id);
  assert.equal(new Set(ids).size, 3);
  assert.deepEqual(assignIds(dup).map((r) => r.id), ids);
});

test("the Answers section names no setup, and heads each block with its id", () => {
  const md = resultMarkdown(fixture);
  const answers = md.slice(md.indexOf("## Answers"), md.indexOf("## Judging"));
  for (const setup of fixture.setups) assert.ok(!answers.includes(setup.name), `${setup.name} appears in Answers`);
  const heads = answers.split("\n").filter((line) => line.startsWith("#### "));
  assert.equal(heads.length, fixture.runs.length);
  const ids = new Set(assignIds(fixture).map((r) => r.id));
  for (const head of heads) assert.ok(ids.has(head.slice(5)), `${head} is not an id`);
});

test("the result note names its key file and says answers are named by id", () => {
  const md = resultMarkdown(fixture);
  assert.ok(md.split("\n").includes("key: 2026-10-08 texting-assistant key.md"));
  const lines = md.split("\n");
  const title = lines.indexOf("# texting-assistant run, 2026-10-08");
  assert.ok(lines.slice(title, title + 3).includes("Answers are named by id. The key file maps ids to setups; a judge never opens it."));
});

test("the key file names its result, and lists every id once with setup, question and run", () => {
  const key = keyMarkdown(fixture);
  const head = key.split("\n").slice(0, 4);
  assert.deepEqual(head, ["---", "result: 2026-10-08 texting-assistant.md", "---", ""]);
  const rows = key
    .split("\n")
    .filter((line) => line.startsWith("| ") && !line.startsWith("| id ") && !line.startsWith("| --- "))
    .map((line) => line.slice(2, -2).split(" | "));
  assert.equal(rows.length, fixture.runs.length);
  assert.equal(new Set(rows.map((row) => row[0])).size, rows.length);
  const expected = idRows(fixture).map(([setup, question, run, id]) => [id, setup, String(question), String(run)]);
  const sorted = (xs) => [...xs].sort((a, b) => a[0].localeCompare(b[0]));
  assert.deepEqual(sorted(rows), sorted(expected));
});

test("the key file and the result note agree on every id", () => {
  const md = resultMarkdown(fixture);
  const key = keyMarkdown(fixture);
  const headIds = md.split("\n").filter((line) => line.startsWith("#### ")).map((line) => line.slice(5)).sort();
  const keyIds = key.split("\n").filter((line) => line.startsWith("| ") && !line.startsWith("| id ") && !line.startsWith("| --- ")).map((line) => line.slice(2).split(" | ")[0]).sort();
  assert.deepEqual(headIds, keyIds);
});

test("a failed tool call is named as failed and counted per setup", () => {
  const run = {
    ...fixture.runs[0],
    tools: [{ tool: "search_notes", ok: true }, { tool: "read_note", ok: false }, "orient"],
  };
  const md = resultMarkdown({ ...fixture, runs: [run] });
  assert.ok(md.includes("Tools: search_notes, read_note (failed), orient"));
  assert.ok(md.includes("| production | anthropic/claude-haiku-5-5 | 1 | 0 | 4.2 s | $0.0002 | 1.0 | 1 |"));
});

test("priceUsd prices the catalog models the setups name", () => {
  assert.equal(priceUsd("google/gemini-2.5-flash", { input: 1000000, output: 0 }), 0.3);
  assert.equal(priceUsd("openai/gpt-5-mini", { input: 0, output: 1000000 }), 2);
});

test("front matter records whether fluff was on and how many notes it wrote", () => {
  const on = resultMarkdown({ ...fixture, fluff: { on: true, notes: 41 } }).split("\n---\n")[0].split("\n");
  assert.ok(on.includes("fluff: on"));
  assert.ok(on.includes("fluff_notes: 41"));
  const off = resultMarkdown({ ...fixture, fluff: { on: false, notes: 0 } }).split("\n---\n")[0].split("\n");
  assert.ok(off.includes("fluff: off"));
  assert.ok(off.includes("fluff_notes: 0"));
});

test("fluff lines are omitted when the run did not say", () => {
  const md = resultMarkdown(fixture);
  assert.ok(!md.includes("fluff"));
});

test("front matter says whether the world was warm or cold, when the run said", () => {
  const warm = resultMarkdown({ ...fixture, world: "warm" }).split("\n---\n")[0].split("\n");
  assert.ok(warm.includes("world: warm"));
  assert.ok(!resultMarkdown(fixture).includes("world:"));
});

test("priceUsd prices opus under both names", () => {
  const usage = { input: 1000000, output: 1000000, cacheRead: 1000000, cacheWrite: 1000000 };
  // 4 + 20 + 0.20 + 5
  assert.equal(priceUsd("anthropic/claude-opus-5-5", usage), 29.2);
  assert.equal(priceUsd("claude-opus-5-5", usage), 29.2);
});

test("a routed setup gets a line saying how many answers went to the thinking model", () => {
  const routed = {
    ...fixture,
    setups: [{ name: "router-opus", version: "abc123abc123", model: "anthropic/claude-haiku-5-5", router: { model: "@cf/cloudflare/clef", think: "anthropic/claude-opus-5-5" } }],
    runs: [
      { setup: "router-opus", question: 1, run: 1, model: "anthropic/claude-opus-5-5", tools: [{ tool: "router: think", ok: true }], usage: { input: 1000000, output: 0 }, ms: 1000, texts: 1, conversation: [] },
      { setup: "router-opus", question: 2, run: 1, model: "anthropic/claude-haiku-5-5", tools: [{ tool: "router: main", ok: true }], usage: { input: 1000000, output: 0 }, ms: 1000, texts: 1, conversation: [] },
    ],
  };
  const md = resultMarkdown(routed);
  assert.ok(md.includes("Routed: router-opus sent 1 of 2 answers to anthropic/claude-opus-5-5 ($4.0000 each): questions 1; the rest ran on anthropic/claude-haiku-5-5."), md);
  assert.ok(md.includes("Tools: router: think"), "the pick is on the answer's tools line");
  assert.ok(!md.includes("Said think but stayed"), "no near misses, no line about them");
});

test("the routed line names every routed question, and the think picks under the cutoff with their confidence", () => {
  const run = (question, runN, tool, model = "anthropic/claude-haiku-5-5") => ({ setup: "wide", question, run: runN, model, tools: [{ tool, ok: true }], usage: { input: 1000, output: 0 }, ms: 1000, texts: 1, conversation: [] });
  const routed = {
    ...fixture,
    setups: [{ name: "wide", version: "abc123abc123", model: "anthropic/claude-haiku-5-5", router: { model: "@cf/cloudflare/clef", think: "anthropic/claude-opus-5-5", routeAt: 0.3 } }],
    runs: [
      run(16, 1, "router: think (0.80)", "anthropic/claude-opus-5-5"),
      run(27, 1, "router: think (0.35)", "anthropic/claude-opus-5-5"),
      run(5, 1, "router: think (0.90)", "anthropic/claude-opus-5-5"),
      run(11, 1, "router: main (think 0.20)"),
      run(11, 2, "router: main (think 0.25)"),
      run(19, 1, "router: main (think 0.10)"),
      run(2, 1, "router: main"),
    ],
  };
  const md = resultMarkdown(routed);
  assert.ok(md.includes("sent 3 of 7 answers to anthropic/claude-opus-5-5 ($0.0040 each): questions 5, 16 and 27; the rest ran on"), md);
  assert.ok(md.includes("Said think but stayed on anthropic/claude-haiku-5-5, under the cutoff 0.3: questions 11 (0.20, 0.25), 19 (0.10)."), md);
});

test("a setup with a fallback gets a line saying how often it was used, and a retried round is counted", () => {
  const spare = {
    ...fixture,
    setups: [{ name: "haiku-spare", version: "abc123abc123", model: "anthropic/claude-haiku-5-5", fallback: "@cf/zai-org/glm-4.7-flash" }],
    runs: [
      { setup: "haiku-spare", question: 1, run: 1, model: "@cf/zai-org/glm-4.7-flash", tools: [{ tool: "fallback: @cf/zai-org/glm-4.7-flash after 529", ok: true }, { tool: "search_notes", ok: true }], usage: { input: 1000, output: 10 }, ms: 1000, texts: 1, conversation: [] },
      { setup: "haiku-spare", question: 2, run: 1, model: "anthropic/claude-haiku-5-5", tools: [{ tool: "retried after 503", ok: true }], usage: { input: 1000, output: 10 }, ms: 1000, texts: 1, conversation: [] },
      { setup: "haiku-spare", question: 3, run: 1, model: "anthropic/claude-haiku-5-5", tools: [{ tool: "search_notes", ok: true }], usage: { input: 1000, output: 10 }, ms: 1000, texts: 1, conversation: [] },
    ],
  };
  const md = resultMarkdown(spare);
  assert.ok(md.includes("Fell back: haiku-spare went on to @cf/zai-org/glm-4.7-flash in 1 of 3 answers after anthropic/claude-haiku-5-5 failed."), md);
  assert.ok(md.includes("Retried: haiku-spare had the gateway retry a round in 1 of 3 answers."), md);
  assert.ok(md.includes("Tools: fallback: @cf/zai-org/glm-4.7-flash after 529, search_notes"), "the fallback is on the answer's tools line");
});

test("an answer run again after an error says so on its block, and the summary counts the reruns", () => {
  const reran = {
    ...fixture,
    setups: [{ name: "haiku", version: "abc123abc123", model: "anthropic/claude-haiku-5-5" }],
    runs: [
      { setup: "haiku", question: 1, run: 1, model: "anthropic/claude-haiku-5-5", reran: "model_unavailable (status 529)", tools: [], usage: { input: 1000, output: 10 }, ms: 1000, texts: 1, conversation: [{ from: "person", text: "hi" }, { from: "assistant", text: "Hey." }] },
      { setup: "haiku", question: 2, run: 1, model: "anthropic/claude-haiku-5-5", reran: "model_unavailable (status 503)", error: "model_unavailable (status 503)", tools: [], usage: { input: 0, output: 0 }, ms: 1000, texts: 0, conversation: [] },
      { setup: "haiku", question: 3, run: 1, model: "anthropic/claude-haiku-5-5", tools: [], usage: { input: 1000, output: 10 }, ms: 1000, texts: 1, conversation: [] },
    ],
  };
  const md = resultMarkdown(reran);
  assert.ok(md.includes("Reran after: model_unavailable (status 529)"), md);
  assert.ok(md.includes("Reran: haiku had 2 of 3 answers run again after an error; 1 still failed."), md);
});

test("a setup without a fallback and no retries gets neither line", () => {
  const md = resultMarkdown(fixture);
  assert.ok(!md.includes("Fell back:"));
  assert.ok(!md.includes("Retried:"));
});

test("the summary says where each setup's conversation time went", () => {
  const timed = {
    ...fixture,
    setups: [{ name: "haiku", version: "abc123abc123", model: "anthropic/claude-haiku-5-5" }],
    runs: [
      { setup: "haiku", question: 1, run: 1, model: "anthropic/claude-haiku-5-5", tools: [], usage: { input: 1000, output: 10 }, ms: 300000, personMs: 60000, wallMs: 420000, texts: 1, conversation: [] },
      { setup: "haiku", question: 2, run: 1, model: "anthropic/claude-haiku-5-5", tools: [], usage: { input: 1000, output: 10 }, ms: 300000, personMs: 0, wallMs: 360000, texts: 1, conversation: [] },
    ],
  };
  const md = resultMarkdown(timed);
  assert.ok(md.includes("Time: haiku spent 13 min across its conversations: 10 min answering, 1 min playing the person, 2 min on worlds and reruns."), md);
  assert.ok(!resultMarkdown(fixture).includes("Time: "), "a result without wall times says nothing");
});
