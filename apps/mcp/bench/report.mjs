// Turns recorded texting-assistant runs into one Markdown result note.
// The note never carries scores: a person or another AI judges it later,
// in a "## Judged by <model>, <date>" section added by hand.

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
  const lines = [`#### ${run.setup}, run ${run.run}`, ""];
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

export function resultMarkdown(result) {
  const setups = result.setups ?? [];
  const runs = result.runs ?? [];
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
    "status: not judged",
    "---",
  ];

  const out = [
    ...frontMatter,
    "",
    `# ${result.job} run, ${result.date}`,
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
    for (const setup of setups) {
      const mine = qRuns
        .filter((r) => r.setup === setup.name)
        .sort((a, b) => a.run - b.run);
      for (const run of mine) out.push(...runBlock(run, byName.get(run.setup)));
    }
  }

  out.push("## Judging", "", "Not judged yet. Add a `## Judged by <model>, <date>` section; never edit an earlier one.", "");
  return out.join("\n");
}
