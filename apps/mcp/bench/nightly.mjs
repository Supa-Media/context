/**
 * TEX'S NIGHTLY SCOREBOARD (Dev2, 2026-11-13: "I want to wake up to some failed benchmarks, I guess, or passing
 * benchmarks if it's truly passing ... That could be what we work towards fixing rather than vibes").
 *
 *   pnpm ai nightly [--held-out <dir>] [--out <file>] [--run-url <url>] [--fake] [--areas core,tasks]
 *
 * Every area, three runs each, as the live setup: the core set and the simple asks, the golden tasks, the web facts,
 * the one judge's reply-or-quiet cases and the reply reviewer's, and (once, a whole job each) the background job tasks. Each area is checked against the spend cap in
 * `@context-lc ai/results/spend.md` before it starts, refused when it would pass it, and its cost recorded there after.
 * One note, `ai/results/nightly/<date>.md`, says pass or fail by each area's own bar, the cases that fell short, the
 * target cases (known bugs) apart, the live drift from people's conversations, and what changed in the live prompt
 * since the night before. A pull request's gate runs only the area it touches; this runs them all.
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { callTool, notePaths, RESULTS_FOLDER, signIn, splitNote } from "./context.mjs";
import { CORE_TESTS, runTests } from "./coreArea.mjs";
import { driftLines, driftOf, readDays, yesterday } from "./drift.mjs";
import { REPO_BENCH_FOLDER } from "./folder.mjs";
import { parseTest } from "./load.mjs";
import { changesSince, fingerprint, productionLines, readFingerprint, readProduction } from "./productionWatch.mjs";
import { AREA_LIMITS, mergeRuns, readHeldOut } from "./replayGate.mjs";
import { loadCases, passes as respondPasses, respondCommand } from "./respond.mjs";
import { loadSets, passes as reviewPasses, reviewCommand } from "./review.mjs";
import { addSpendRow, expectedUsd, parseSpend, readSpend } from "./spend.mjs";

export const NIGHTLY_RUNS = 3;
export const SCOREBOARD_FOLDER = `${RESULTS_FOLDER}/nightly`;

/** The areas, in the scoreboard's order. A test area runs bench tests; a scorer area runs its labelled cases. */
export const NIGHTLY_AREAS = [
  { area: "core", tests: CORE_TESTS },
  { area: "tasks", tests: ["tasks"] },
  { area: "web-facts", tests: ["web-facts"] },
  { area: "respond", scorer: { command: respondCommand, passes: respondPasses, count: async () => (await loadCases()).length } },
  { area: "review", scorer: { command: reviewCommand, passes: reviewPasses, count: async () => Object.values(await loadSets()).flat().length } },
  // A job task is a whole background job (about $0.35), so the jobs area runs once a night, not three times.
  // Loaded when it runs: jobTasks.mjs reads run.mjs, which reads this file.
  {
    area: "jobs",
    runs: 1,
    scorer: {
      command: async (...args) => (await import("./jobTasks.mjs")).jobTasksCommand(...args),
      passes: (records) => records.filter((record) => !record.target).every((record) => record.right),
      count: async () => (await (await import("./jobTasks.mjs")).loadCases()).length,
    },
  },
];

/** How many times an area runs tonight. */
export const runsOf = (spec) => spec.runs ?? NIGHTLY_RUNS;

/** What an area is expected to cost tonight: a test's dearest earlier round, scaled to three runs; a scorer's cases at their price. */
export async function expectedFor(spec, { rows, dir, heldOut = null }) {
  if (spec.scorer) {
    const held = (await readHeldOut(heldOut, spec.area)).length;
    return AREA_LIMITS[spec.area].usdPerCase * ((await spec.scorer.count()) + held) * runsOf(spec);
  }
  let usd = 0;
  for (const test of spec.tests) {
    const raw = await readFile(join(dir, "tests", `${test}.md`), "utf8").catch(() => null);
    if (raw === null) continue;
    const runs = Number(parseTest(raw).front.runs) || 1;
    usd += (expectedUsd({ rows, test, setups: 1 }) * NIGHTLY_RUNS) / runs;
  }
  return usd;
}

/** One area tonight: `{ area, status, rows, usd, bars, runsPassed, missing, error }`. */
export async function runArea(spec, { tree, dir, scratch, fake = false, heldOut = null }) {
  if (spec.scorer) {
    const files = [];
    let runsPassed = 0;
    for (let i = 1; i <= runsOf(spec); i += 1) {
      const json = join(scratch, `${spec.area}-nightly-${i}.json`);
      const rates = await spec.scorer.command({ json, "held-out": heldOut, fake }, { write: () => {} });
      if (spec.scorer.passes(rates)) runsPassed += 1;
      files.push(JSON.parse(await readFile(json, "utf8")));
    }
    const rows = mergeRuns(files);
    // A fake run spends nothing; a scorer that prices its rows (`usd`) is taken at its word, the rest at the estimate.
    const priced = files.flat();
    const usd = fake ? 0 : priced.every((row) => typeof row.usd === "number") ? priced.reduce((sum, row) => sum + row.usd, 0) : AREA_LIMITS[spec.area].usdPerCase * rows.length * runsOf(spec);
    return { area: spec.area, status: runsPassed * 2 > runsOf(spec) ? "pass" : "fail", rows, usd, runsPassed, runs: runsOf(spec), bars: {}, missing: [] };
  }
  const result = await runTests(tree, spec.tests, { dir, runs: NIGHTLY_RUNS, fake, scratch, tag: "nightly" });
  if (result.missing.length === spec.tests.length) return { area: spec.area, status: "missing", rows: [], usd: 0, bars: {}, missing: result.missing };
  const pass = Object.values(result.bars).every((bar) => bar?.goodEnough === true);
  return { area: spec.area, status: pass ? "pass" : "fail", ...result };
}

const money = (usd) => `$${Number(usd ?? 0).toFixed(2)}`;
const pct = (value) => (value === null || value === undefined ? "n/a" : `${Math.round(value)}%`);
const RESULT = { pass: "✅ pass", fail: "❌ fail", refused: "⏸ not run", missing: "— not on main yet", error: "⚠️ error" };

/** The scoreboard note. Held-out cases are named by their cause alone, as the gate names them. */
export function scoreboardNote({ date, runUrl = null, areas, drift = null, production = null, spend }) {
  const ran = areas.filter((a) => a.status === "pass" || a.status === "fail");
  const spent = areas.reduce((sum, a) => sum + (a.usd ?? 0), 0);
  const lines = [
    "---",
    "role: nightly-scoreboard",
    `date: ${date}`,
    ...(runUrl ? [`run: ${runUrl}`] : []),
    `spent_usd: ${spent.toFixed(2)}`,
    "---",
    "",
    `# Tex nightly, ${date}`,
    "",
    `Written by the Tex nightly run${runUrl ? ` ([the run](${runUrl}))` : ""}: every area, ${NIGHTLY_RUNS} runs each (the job tasks once: each is a whole job), as the live setup. ${ran.filter((a) => a.status === "pass").length} of ${areas.length} areas pass their bar; tonight spent ${money(spent)}, and the testing budget stands at ${money(spend.total)} of its ${money(spend.cap)} cap (ai/results/spend.md).`,
    "",
    `| area | result | cases right in most runs | right in every run | spent |`,
    "| --- | --- | --- | --- | --- |",
  ];
  for (const a of areas) {
    const held = a.rows.filter((row) => !row.target);
    const most = held.filter((row) => row.right).length;
    const every = held.filter((row) => row.results?.length && row.results.every(Boolean)).length;
    const counts = a.status === "pass" || a.status === "fail" ? [`${most}/${held.length}`, `${every}/${held.length}`] : ["", ""];
    const result = a.status === "refused" ? `${RESULT.refused}: ${a.reason}` : a.status === "error" ? `${RESULT.error}: ${a.reason}` : RESULT[a.status];
    lines.push(`| ${a.area} | ${result} | ${counts[0]} | ${counts[1]} | ${a.status === "refused" || a.status === "missing" ? "" : money(a.usd)} |`);
  }
  lines.push("");

  const short = areas.filter((a) => a.status === "fail");
  if (short.length) {
    lines.push("## What fell short", "");
    for (const a of short) {
      for (const [test, bar] of Object.entries(a.bars ?? {})) {
        if (!bar || bar.goodEnough) continue;
        lines.push(`- **${a.area}, ${test}:** score ${pct(bar.score)} of the test's bar${bar.gateFailed?.length ? `; gates failed: ${bar.gateFailed.map((n) => `q${n}`).join(", ")}` : ""}${bar.speed ? `; median ${bar.speed.toFixed(1)} s` : ""}.`);
      }
      if (a.runsPassed !== undefined) lines.push(`- **${a.area}:** passed its bar in ${a.runsPassed} of ${a.runs ?? NIGHTLY_RUNS} run(s).`);
      const wrong = a.rows.filter((row) => !row.target && row.results?.some((r) => !r));
      for (const row of wrong.filter((r) => !r.heldOut)) lines.push(`  - \`${row.id}\` right in ${row.results.filter(Boolean).length} of ${row.results.length} runs; expected to ${row.expected}.`);
      const byCause = new Map();
      for (const row of wrong.filter((r) => r.heldOut)) byCause.set(row.cause, (byCause.get(row.cause) ?? 0) + 1);
      for (const [cause, n] of byCause) lines.push(`  - held-out: ${n} about ${cause}`);
    }
    lines.push("");
  }

  const targets = areas.flatMap((a) => a.rows.filter((row) => row.target).map((row) => ({ ...row, area: a.area })));
  lines.push("## Target cases (known bugs, never block a merge)", "");
  if (targets.length === 0) lines.push("None yet. A case marked `target:` (a bench question's `- target: <cause>`, a respond or review case's `\"target\"`) lands here until its bug is fixed.", "");
  else {
    lines.push("| area | case | right in |", "| --- | --- | --- |");
    for (const row of targets) lines.push(`| ${row.area} | ${row.heldOut ? `held-out: ${row.cause}` : `\`${row.id}\`${typeof row.target === "string" ? ` (${row.target})` : ""}`} | ${row.results.filter(Boolean).length} of ${row.results.length} |`);
    lines.push("");
  }

  lines.push("## Live drift", "", ...(drift ? driftLines(drift) : ["Not read tonight."]), "");
  if (production) lines.push(...productionLines(production));
  return `${lines.join("\n")}\n`;
}

/** The latest scoreboard before `date`, or null. */
async function lastScoreboard(connection, date) {
  const listed = await callTool(connection, "list_notes", { prefix: SCOREBOARD_FOLDER });
  if (listed.isError) return null;
  const dates = notePaths(listed.text).map((path) => /\/(\d{4}-\d{2}-\d{2})\.md$/.exec(path)?.[1]).filter((d) => d && d < date).sort();
  const since = dates.at(-1);
  if (!since) return null;
  const read = await callTool(connection, "read_note", { path: `${SCOREBOARD_FOLDER}/${since}.md` });
  return read.isError ? null : { since, content: splitNote(read.text).content };
}

async function writeNote(connection, path, content, summary) {
  const existing = await callTool(connection, "read_note", { path });
  const etag = existing.isError ? null : (splitNote(existing.text).header.etag ?? null);
  const written = await callTool(connection, "write_note", { path, content, summary, ...(etag ? { expected_etag: etag } : {}) });
  if (written.isError) throw new Error(`write_note ${path}: ${written.text}`);
}

export async function nightlyCommand(options, { write = (text) => process.stdout.write(text) } = {}) {
  const date = new Date().toISOString().slice(0, 10);
  const tree = options.tree ?? join(REPO_BENCH_FOLDER, "..", "..", "..", "..");
  const dir = options.dir ?? REPO_BENCH_FOLDER;
  const scratch = options.scratch ?? (await mkdtemp(join(tmpdir(), "tex-nightly-")));
  await mkdir(scratch, { recursive: true });
  const heldOut = options["held-out"] ?? null;
  const only = options.areas ? String(options.areas).split(",") : null;
  const connection = await signIn({ env: process.env });
  const spendNote = await readSpend(connection);
  if (!spendNote) throw new Error("ai/results/spend.md is not in Context: write it with a cap_usd line before running");
  const spend = parseSpend(spendNote.content);
  const run = options["run-url"] ? `[nightly](${options["run-url"]})` : "nightly";

  const areas = [];
  for (const spec of NIGHTLY_AREAS.filter((s) => !only || only.includes(s.area))) {
    const expected = options.fake ? 0 : await expectedFor(spec, { rows: spend.rows, dir, heldOut });
    if (spend.total + expected > spend.cap) {
      areas.push({ area: spec.area, status: "refused", rows: [], usd: 0, reason: `over the spend cap (needs about ${money(expected)}, ${money(spend.cap - spend.total)} left; raise cap_usd in ai/results/spend.md)` });
      continue;
    }
    let result;
    try {
      result = await runArea(spec, { tree, dir, scratch, fake: options.fake === true, heldOut });
    } catch (error) {
      // What failed, never a case's words: the message is the command's, which names files and models.
      result = { area: spec.area, status: "error", rows: [], usd: 0, reason: String(error.message ?? error).split("\n")[0].slice(0, 160) };
    }
    areas.push(result);
    if (!options.fake && result.usd >= 0.005) {
      const row = { date, run, test: `nightly-${spec.area}`, setups: ["production"], answers: result.rows.length * runsOf(spec), usd: Math.round(result.usd * 100) / 100 };
      await addSpendRow(connection, row);
      spend.total += row.usd;
    }
  }

  const drift = driftOf(await readDays(connection, yesterday()), yesterday());
  const notes = await readProduction(connection);
  const now = fingerprint(notes);
  const last = await lastScoreboard(connection, date);
  const production = { now, since: last?.since ?? null, changes: last ? changesSince(now, readFingerprint(last.content), last.since) : [] };

  const note = scoreboardNote({ date, runUrl: options["run-url"] ?? null, areas, drift, production, spend });
  if (options.out) await writeFile(options.out, note);
  if (!options.fake) await writeNote(connection, `${SCOREBOARD_FOLDER}/${date}.md`, note, `Tex nightly scoreboard ${date}`);
  write(note.replace(/^---\n[\s\S]*?\n---\n\n/, ""));
  if (areas.some((a) => a.status !== "pass" && a.status !== "missing")) process.exitCode = 1;
  return { areas, drift, production };
}
