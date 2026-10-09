/**
 * `pnpm ai score <result file> --dir <folder>`
 *
 * Scores each setup from the latest "## Judged by" section, joined to the key
 * file, and appends a "## Scored by <judge model>, <date>" section with one row
 * per setup. The bars come from the test's good_enough lines.
 *
 * A question passes a setup when every run of it passed every must and must
 * not line. A run the model never answered (an error the retry and the rerun
 * did not clear) is not a run: the question is judged on its answered runs and
 * the error is counted beside the score, so a flaky evening reads as errors and
 * not as a bad prompt; a question with no answered run fails. A privacy
 * question (or any question with a mirror) counts only when its mirror question
 * passed for the same setup; otherwise it is untested and is left out of the
 * score, and its gate does not count either. A gate question fails its gate
 * when any of its must-not lines fails on any run, which is why those lines are
 * kept for the dire things; a gate failure anywhere fails the setup. Judge lines never pass or fail a question; the
 * share of them that pass is the setup's voice, held to the `voice:` bar when
 * the test sets one (the `every_answer` lines are judge lines on every answer).
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { isGateQuestion, parseTest } from "./load.mjs";
import { frontMatter, parseJudgedSections, parseKey, parseResult, setFrontStatus } from "./resultNote.mjs";

const today = () => new Date().toISOString().slice(0, 10);

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function median(xs) {
  const sorted = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The bars from good_enough, read leniently: "80%" is 80, "under $0.005 a
 * question" is 0.005, "under 8 s" is 8, "4 or fewer" is 4. A bar that cannot be
 * read is null, and a null bar is never met.
 */
export function parseBars(good = {}) {
  const number = (text, pattern) => {
    const m = String(text ?? "").match(pattern);
    return m ? Number(m[1]) : null;
  };
  return {
    score: number(good.score, /(\d+(?:\.\d+)?)\s*%/),
    price: number(good.price, /under\s*\$?\s*(\d+(?:\.\d+)?)/i),
    speed: number(good.speed, /under\s*(\d+(?:\.\d+)?)\s*s/i),
    texts: number(good.texts, /(\d+(?:\.\d+)?)\s*or\s*fewer/i),
    // "80%" of the judge lines passing. A test that sets no voice bar has no
    // `voice` key at all: voice is then reported, never required.
    ...(good.voice === undefined ? {} : { voice: number(good.voice, /(\d+(?:\.\d+)?)\s*%/) }),
  };
}

/**
 * The scores, from the key's rows, the judged verdicts by answer id, the
 * parsed answers and the test's questions. Each row is one setup.
 */
export function scoreSetups({ key, judged, answers, questions, bars }) {
  for (const row of key) {
    if (!judged.has(row.id)) throw new Error(`no judged verdict for answer ${row.id}`);
    if (!answers.has(row.id)) throw new Error(`no answer block for answer ${row.id}`);
  }
  const numbers = [...new Set(key.map((row) => row.question))].sort((a, b) => a - b);
  for (const n of numbers) {
    const q = questions.get(n);
    if (!q) throw new Error(`question ${n} is in the result but not in the test`);
    if (q.mirror !== null && !questions.has(q.mirror)) throw new Error(`question ${n} mirrors question ${q.mirror}, which the test does not have`);
  }

  const runsOf = (setup, n) => key.filter((row) => row.setup === setup && row.question === n);
  // A run passes when its must and must not lines pass; judge lines are never
  // graded. A run the model never answered (skipped by the judge) is not a run.
  const answered = (setup, n) => runsOf(setup, n).filter((row) => !judged.get(row.id).skipped);
  const runPassed = (id) => judged.get(id).verdicts.every((v) => v.kind === "judge" || v.pass);
  const questionPassed = (setup, n) => {
    const runs = answered(setup, n);
    return runs.length > 0 && runs.every((row) => runPassed(row.id));
  };
  const gateBroken = (id) => judged.get(id).verdicts.some((v) => v.kind === "must not" && !v.pass);

  const setups = [...new Set(key.map((row) => row.setup))];
  const rows = setups.map((setup) => {
    let passed = 0;
    let counted = 0;
    const untested = [];
    const gateFailed = [];
    for (const n of numbers) {
      const q = questions.get(n);
      if (q.mirror !== null && !questionPassed(setup, q.mirror)) {
        untested.push(n);
        continue;
      }
      counted += 1;
      if (questionPassed(setup, n)) passed += 1;
      if (isGateQuestion(q) && answered(setup, n).some((row) => gateBroken(row.id))) gateFailed.push(n);
    }

    const mine = key.filter((row) => row.setup === setup);
    const errors = mine.filter((row) => judged.get(row.id).skipped).length;
    const judgeVerdicts = mine.flatMap((row) => judged.get(row.id).verdicts.filter((v) => v.kind === "judge"));
    const timed = mine.map((row) => answers.get(row.id).time).filter(Boolean);
    const prices = timed.map((t) => t.price);
    // Any unpriced run makes the setup's price unknown, which is never under a bar.
    const price = timed.length === 0 ? null : prices.some((p) => p === null) ? "unknown" : mean(prices);
    const speed = median(timed.map((t) => t.seconds).filter((s) => s !== null));
    const texts = mean(mine.map((row) => answers.get(row.id).conversation.filter((turn) => turn.from === "assistant").length));
    const score = counted === 0 ? null : (passed / counted) * 100;
    const voice = judgeVerdicts.length === 0 ? null : (judgeVerdicts.filter((v) => v.pass).length / judgeVerdicts.length) * 100;
    const met = {
      score: score !== null && bars.score !== null && score >= bars.score,
      price: typeof price === "number" && bars.price !== null && price < bars.price,
      speed: speed !== null && bars.speed !== null && speed < bars.speed,
      texts: texts !== null && bars.texts !== null && texts <= bars.texts,
      gates: gateFailed.length === 0,
      // Only a test that sets a voice bar is held to one.
      ...(bars.voice === undefined ? {} : { voice: voice !== null && bars.voice !== null && voice >= bars.voice }),
    };
    return {
      setup,
      score,
      gateFailed,
      untested,
      judgeLines: { passed: judgeVerdicts.filter((v) => v.pass).length, total: judgeVerdicts.length },
      voice,
      errors,
      price,
      speed,
      texts,
      goodEnough: Object.values(met).every(Boolean),
    };
  });

  // The best good-enough setup: highest score, then cheapest, then fastest.
  const good = rows.filter((row) => row.goodEnough).sort((a, b) => b.score - a.score || a.price - b.price || a.speed - b.speed);
  return { rows, best: good[0]?.setup ?? null };
}

const pct = (score) => (score === null ? "n/a" : `${Number(score.toFixed(1))}%`);
const priceText = (price) => (price === null ? "n/a" : price === "unknown" ? "unknown" : `$${price.toFixed(4)}`);
const speedText = (speed) => (speed === null ? "n/a" : `${speed.toFixed(1)} s`);
const textsText = (texts) => (texts === null ? "n/a" : texts.toFixed(1));
const gatesText = (failed) => (failed.length ? `failed (${failed.map((n) => `q${n}`).join(", ")})` : "passed");

/** The "## Scored by" section. `goodEnough` is the test's good_enough lines as written. */
export function scoreSection({ judgeModel, date, rows, best, goodEnough = {} }) {
  const out = [
    `## Scored by ${judgeModel}, ${date}`,
    "",
    "| setup | score | gates | judge lines | price | speed | texts | errors | good enough |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const r of rows) {
    const cells = [
      r.setup,
      pct(r.score),
      gatesText(r.gateFailed),
      r.judgeLines.total === 0 ? "0 of 0" : `${r.judgeLines.passed} of ${r.judgeLines.total} (${pct(r.voice)})`,
      priceText(r.price),
      speedText(r.speed),
      textsText(r.texts),
      String(r.errors ?? 0),
      r.goodEnough ? "yes" : "no",
    ];
    out.push(`| ${cells.join(" | ")} |`);
  }
  out.push("");
  const bars = ["score", "voice", "price", "speed", "texts"].filter((name) => goodEnough[name] !== undefined).map((name) => `${name} ${goodEnough[name]}`);
  out.push(`Bars: ${bars.length ? bars.join(", ") : "none set"}.`, "");
  const untested = rows.filter((r) => r.untested.length).map((r) => `${r.setup} ${r.untested.map((n) => `q${n}`).join(", ")}`);
  if (untested.length) out.push(`Untested, because their mirror question did not pass: ${untested.join("; ")}.`, "");
  out.push(`Best setup that passes every bar: ${best ?? "none"}.`, "");
  return out.join("\n");
}

/** Scores one result note and appends its section. Returns the setups' rows. */
export async function scoreFile({ path, dir, date = today() }) {
  const raw = await readFile(path, "utf8");
  const front = frontMatter(raw);
  if (!front.test) throw new Error(`${path} has no test: line in its front matter`);
  if (!front.key) throw new Error(`${path} has no key: line, so its answers cannot be joined to setups`);
  const sections = parseJudgedSections(raw);
  if (sections.length === 0) throw new Error(`${path} has no "## Judged by" section; run pnpm ai judge first`);
  const latest = sections.at(-1);
  const key = parseKey(await readFile(join(dirname(path), front.key), "utf8"));
  const answers = new Map(parseResult(raw).answers.map((answer) => [answer.id, answer]));
  const test = parseTest(await readFile(join(dir, "tests", `${front.test}.md`), "utf8"));
  const bars = parseBars(test.front.good_enough);
  const { rows, best } = scoreSetups({
    key,
    judged: latest.blocks,
    answers,
    questions: new Map(test.questions.map((q) => [q.n, q])),
    bars,
  });
  const section = scoreSection({ judgeModel: latest.model, date, rows, best, goodEnough: test.front.good_enough ?? {} });
  await writeFile(path, `${setFrontStatus(raw, "scored").replace(/\n*$/, "\n")}\n${section}`);
  return { rows, best, judgeModel: latest.model };
}

/** The `score` command: options come from run.mjs's argument parser. */
export async function scoreCommand(options) {
  const dir = options.dir ?? process.env.AI_BENCH_DIR;
  if (!options.job || !dir) throw new Error("usage: pnpm ai score <result file> --dir <benchmarks folder>");
  const { rows, best } = await scoreFile({ path: options.job, dir, date: today() });
  process.stderr.write(`scored ${rows.length} setups; best that passes every bar: ${best ?? "none"}; appended to ${options.job}\n`);
}
