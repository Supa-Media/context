// Turns recorded texting-assistant runs into one Markdown result note, and a
// key file that maps each answer's id back to its setup. The note never names
// a setup in its answers, so whoever judges it cannot tell which setup wrote
// what. Judging appends a "## Judged by <model>, <date>" section to the note.
import { createHash } from "node:crypto";

import { WORDS } from "./words.mjs";

// Where the four words of an id are read from the 32-byte SHA-256 digest.
const WORD_OFFSETS = [0, 4, 8, 12];

// The id for one run identity at one attempt. Attempt 0 is the identity's own
// digest; later attempts only happen to resolve a collision.
function idFor(identity, attempt) {
  const digest = createHash("sha256")
    .update(attempt === 0 ? identity : `${identity}#${attempt}`)
    .digest();
  return WORD_OFFSETS.map((at) => WORDS[digest.readUInt32BE(at) % WORDS.length]).join("-");
}

/**
 * Each run's answer id, as a copy of the run with an `id` field. The same run
 * always gets the same id. Runs are resolved in identity order, not array
 * order, so a collision is settled the same way however the runs were listed.
 */
export function assignIds(result) {
  const runs = result.runs ?? [];
  const versions = new Map((result.setups ?? []).map((setup) => [setup.name, setup.version]));
  const identity = (run) =>
    `${result.testVersion}:${run.setup}@${versions.get(run.setup)}:${run.question}:${run.run}`;
  const order = runs
    .map((run, index) => ({ index, key: identity(run) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.index - b.index));
  const taken = new Set();
  const ids = new Array(runs.length);
  for (const { index, key } of order) {
    let attempt = 0;
    let id = idFor(key, attempt);
    while (taken.has(id)) {
      attempt += 1;
      id = idFor(key, attempt);
    }
    taken.add(id);
    ids[index] = id;
  }
  return runs.map((run, index) => ({ ...run, id: ids[index] }));
}

// Prices in USD per million tokens. Models without cache prices bill
// cache tokens at the input rate.
const PRICES = {
  "@cf/zai-org/glm-4.7-flash": { input: 0.06, output: 0.4 },
  "anthropic/claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "anthropic/claude-sonnet-5-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-5-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};

// Cost in USD of one run. Null when the model has no known price.
export function priceUsd(model, usage) {
  if (!Object.hasOwn(PRICES, model)) return null;
  const p = PRICES[model];
  const u = usage ?? {};
  // Missing or non-numeric token counts count as zero.
  const n = (v) => (Number.isFinite(v) ? v : 0);
  const cacheRead = p.cacheRead ?? p.input;
  const cacheWrite = p.cacheWrite ?? p.input;
  return (
    (n(u.input) * p.input +
      n(u.output) * p.output +
      n(u.cacheRead) * cacheRead +
      n(u.cacheWrite) * cacheWrite) /
    1e6
  );
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const fmtUsd = (v) => (v === null ? "unknown" : `$${v.toFixed(4)}`);
const fmtSecs = (ms) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} s` : "n/a");

// Median of the finite values; the mean of the two middle values for even counts.
function median(values) {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// Recorded text may not start a heading: escape lines beginning with "#".
function safeText(text) {
  return String(text ?? "")
    .split("\n")
    .map((line) => line.replace(/^(\s{0,3})#/, "$1\\#"))
    .join("\n");
}

// Price of one run, using the model that actually answered it.
const runPrice = (run, setup) => priceUsd(run.model ?? setup?.model, run.usage);

function summaryRow(setup, runs) {
  const mine = runs.filter((r) => r.setup === setup.name);
  const errors = mine.filter((r) => r.error).length;
  const prices = mine.map((r) => runPrice(r, setup));
  let price = "n/a";
  if (prices.length && prices.some((p) => p === null)) price = "unknown";
  else if (prices.length) price = fmtUsd(mean(prices));
  const med = median(mine.map((r) => r.ms));
  const texts = mean(mine.map((r) => r.texts ?? 0));
  return [
    setup.name,
    setup.model,
    String(mine.length - errors),
    String(errors),
    med === null ? "n/a" : fmtSecs(med),
    price,
    texts === null ? "n/a" : texts.toFixed(1),
  ];
}

function runBlock(run, setup) {
  const lines = [`#### ${run.id}`, ""];
  for (const m of run.conversation ?? []) {
    const who = m.from === "person" ? "Person" : "Assistant";
    lines.push(`**${who}:** ${safeText(m.text)}`, "");
  }
  const tools = run.tools?.length ? run.tools.join(", ") : "none";
  lines.push(`Tools: ${tools}`, "");
  if (run.changes?.length) {
    lines.push("Changes recorded:", "");
    for (const c of run.changes) {
      lines.push(`- ${c.kind} ${c.workspace}/${c.path}: ${c.detail}`);
    }
    lines.push("");
  }
  if (run.error) {
    lines.push(`Error: ${run.error}`, "");
  } else {
    const price = fmtUsd(runPrice(run, setup));
    lines.push(`Time ${fmtSecs(run.ms)}, ${price}, ${plural(run.texts ?? 0, "text")}`, "");
  }
  return lines;
}

// Ids sort by their text, so a question's answers come out in a fixed order
// that does not follow the setups.
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function resultMarkdown(result) {
  const setups = result.setups ?? [];
  const runs = assignIds(result);
  const byName = new Map(setups.map((s) => [s.name, s]));
  const questionNums = [...new Set(runs.map((r) => r.question))].sort((a, b) => a - b);
  const maxRun = runs.reduce((m, r) => Math.max(m, r.run), 0);

  const frontMatter = [
    "---",
    `job: ${result.job}`,
    `test: ${result.test}`,
    `test_version: ${result.testVersion}`,
    `date: ${result.date}`,
    `code_commit: ${result.commit}`,
    ...(result.playedBy ? [`played_by: ${result.playedBy}`] : []),
    `setups: [${setups.map((s) => `${s.name}@${s.version}`).join(", ")}]`,
    `runs_per_question: ${maxRun}`,
    ...(result.keyFile ? [`key: ${result.keyFile}`] : []),
    "status: not judged",
    "---",
  ];

  const out = [
    ...frontMatter,
    "",
    `# ${result.job} run, ${result.date}`,
    "",
    "Answers are named by id. The key file maps ids to setups; a judge never opens it.",
    "",
    `This run asked ${plural(questionNums.length, "question")}, ${plural(maxRun, "run")} each, against ${plural(setups.length, "setup")}.`,
    "",
    "Moves, edits and texts below were recorded, never carried out.",
    "",
    "## Summary",
    "",
    "| Setup | Model | Answers | Errors | Median time | Price per question | Texts per question |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...setups.map((s) => `| ${summaryRow(s, runs).join(" | ")} |`),
    "",
    "## Answers",
    "",
  ];

  for (const num of questionNums) {
    const qRuns = runs.filter((r) => r.question === num);
    const first = qRuns[0];
    const questionText = String(first.questionText ?? "").replace(/\s+/g, " ");
    out.push(`### ${num}. ${questionText}`, "");
    out.push(`as ${first.as}, ${first.kind}${first.gate ? ", gate" : ""}`, "");
    for (const run of [...qRuns].sort(byId)) out.push(...runBlock(run, byName.get(run.setup)));
  }

  out.push("## Judging", "", "Judgments are added below as `## Judged by <model>, <date>` sections; never edit an earlier one.", "");
  return out.join("\n");
}

/** The key sits beside its result: "<date> <test>.md" has "<date> <test> key.md". */
export const keyPathFor = (resultPath) => `${resultPath.replace(/\.md$/, "")} key.md`;

/** The key: which setup, question and run wrote each id. Never shown to a judge. */
export function keyMarkdown(result) {
  const rows = assignIds(result)
    .sort(byId)
    .map((r) => `| ${r.id} | ${r.setup} | ${r.question} | ${r.run} |`);
  return [
    "---",
    `result: ${result.resultFile ?? ""}`,
    "---",
    "",
    `# ${result.job} key, ${result.date}`,
    "",
    "Each answer id in the result note, with the setup, question and run that wrote it. A judge never opens this file.",
    "",
    "| id | setup | question | run |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}
