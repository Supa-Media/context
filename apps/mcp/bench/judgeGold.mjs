/**
 * HOW FAR THE JUDGE CAN BE TRUSTED (Dev2, 2026-11-26: "lets figure out how to make sure the judge is actually reliable").
 *
 * Dev2 labelled twenty judge-graded lines from the everyday rounds and agreed with the judge on about half. A score
 * is only as good as the judge behind it, so the judge gets a score of its own: `judgeGold/` keeps real bench answers
 * (invented people, as every bench world is) beside a person's pass/fail for one line of each, and
 * `pnpm ai judge-gold` judges those answers again, `--times` rounds, and reports
 *
 *   - agreement: the share of labelled lines whose majority verdict across the rounds matches the person's;
 *   - flips: lines the judge called both ways across the rounds (noise, whatever the label says);
 *   - each line's kind, so a kind the judge can't be trusted on shows up as its own number.
 *
 * Only `labels.json`'s lines count; the judge's other verdicts on the same answers are ignored. A label whose line no
 * longer reaches the judge (it was moved to a code check, or the test reworded it) is reported as stale, never scored.
 * Nothing is written back: each round judges a copy in a temporary folder.
 */
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { benchFolder } from "./folder.mjs";
import { DEFAULT_VOTES, fakeJudge, judgeFile } from "./judge.mjs";
import { claudeTransport } from "./models.mjs";
import { parseJudgedSections } from "./resultNote.mjs";

export const GOLD_DIR = fileURLToPath(new URL("./judgeGold/", import.meta.url));
const DEFAULT_TIMES = 2;
const MAX_TIMES = 5;

/** What kind of line a label grades, for the per-kind numbers. */
export function lineKind(line) {
  if (/reads like texts/i.test(line)) return "style";
  if (/never says it sent|claim/i.test(line)) return "truthfulness";
  return "case line";
}

/**
 * Compare the judge's rounds with the labels. `rounds` is one Map per round, `test/id` → that answer's verdicts
 * (`{ line, pass }`). Returns the report's numbers and its rows.
 */
export function compareWithLabels(labels, rounds) {
  const rows = labels.map((label) => {
    const calls = rounds.map((round) => round.get(`${label.test}/${label.id}`)?.find((verdict) => verdict.line === label.line)).filter(Boolean);
    if (calls.length === 0) return { ...label, kind: lineKind(label.line), stale: true };
    const passes = calls.filter((call) => call.pass).length;
    const judge = passes * 2 > calls.length ? "pass" : passes * 2 < calls.length ? "fail" : "split";
    return { ...label, kind: lineKind(label.line), judge, flipped: passes > 0 && passes < calls.length, agrees: judge === label.label, reason: calls.at(-1).reason };
  });
  const scored = rows.filter((row) => !row.stale);
  const share = (list) => (list.length ? list.filter((row) => row.agrees).length / list.length : null);
  const kinds = [...new Set(scored.map((row) => row.kind))].map((kind) => {
    const of = scored.filter((row) => row.kind === kind);
    return { kind, lines: of.length, agreement: share(of), flips: of.filter((row) => row.flipped).length };
  });
  return { rows, lines: scored.length, stale: rows.length - scored.length, agreement: share(scored), flips: scored.filter((row) => row.flipped).length, kinds };
}

const percent = (share) => (share === null ? "none" : `${Math.round(share * 100)}%`);

/** The report as Markdown, for a run's summary page. */
export function goldReport(result, { model, times }) {
  const lines = [
    `## Judge against the gold labels (${model}, ${times} round${times === 1 ? "" : "s"})`,
    "",
    `Agreement: **${percent(result.agreement)}** of ${result.lines} labelled lines; ${result.flips} flipped between rounds${result.stale ? `; ${result.stale} stale (the line no longer reaches the judge)` : ""}.`,
    "",
    "| kind | lines | agreement | flips |",
    "| --- | --- | --- | --- |",
    ...result.kinds.map((kind) => `| ${kind.kind} | ${kind.lines} | ${percent(kind.agreement)} | ${kind.flips} |`),
    "",
    "Disagreements:",
    "",
    ...result.rows.filter((row) => !row.stale && !row.agrees).map((row) => `- ${row.test} ${row.id}: "${row.line}". Label ${row.label}, judge ${row.judge}${row.flipped ? " (flipped)" : ""}. Judge said: ${row.reason}`),
  ];
  return `${lines.join("\n")}\n`;
}

/** One round: every gold file judged once in a temporary copy, as a Map of `test/id` → verdicts. */
async function judgeRound({ files, dir, send, model, votes, salt }) {
  const out = new Map();
  const tmp = await mkdtemp(join(tmpdir(), "judge-gold-"));
  try {
    for (const file of files) {
      const copy = join(tmp, file);
      await copyFile(join(GOLD_DIR, file), copy);
      await judgeFile({ path: copy, dir, send, model, votes, salt, log: (line) => process.stderr.write(`${line}\n`) });
      const test = file.replace(/\.md$/, "");
      const section = parseJudgedSections(await readFile(copy, "utf8")).at(-1);
      for (const [id, block] of section?.blocks ?? []) out.set(`${test}/${id}`, block.verdicts);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return out;
}

export async function judgeGoldCommand(options) {
  const times = options.times === undefined ? DEFAULT_TIMES : Number(options.times);
  if (!Number.isInteger(times) || times < 1 || times > MAX_TIMES) throw new Error(`--times must be a whole number from 1 to ${MAX_TIMES}, got "${options.times}"`);
  const labels = JSON.parse(await readFile(join(GOLD_DIR, "labels.json"), "utf8"));
  const files = [...new Set(labels.map((label) => `${label.test}.md`))];
  const send = options.fake ? fakeJudge() : claudeTransport(process.env);
  const model = options.fake ? "fake-judge" : options.judge;
  const votes = options.votes === undefined ? DEFAULT_VOTES : Number(options.votes);
  const rounds = [];
  for (let k = 1; k <= times; k += 1) rounds.push(await judgeRound({ files, dir: benchFolder(options), send, model, votes, salt: `gold-${k}` }));
  process.stdout.write(goldReport(compareWithLabels(labels, rounds), { model: model ?? "the test's judge", times }));
}
