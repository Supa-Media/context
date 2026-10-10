/**
 * `pnpm ai calibrate <judged result file> [--decision <model>] [--sample <n>] [--concurrency <n>] [--fake]`
 *
 * Could a decision model be the judge? Clef (Cloudflare's, Jev-compatible)
 * never writes text: it answers yes or no with a probability, in tens of
 * milliseconds, so a verdict from it is typed by construction and cheap.
 * What it cannot do is explain itself, and whether it reads a texting
 * transcript well enough to grade "reads like a capable friend" is the
 * question this answers with numbers rather than a guess (the owner,
 * 2026-10-10: "just to see the effect and the cost").
 *
 * It takes a result note Haiku has already judged, puts every judged answer
 * to the decision model with one yes-or-no question per check, and counts
 * how often the two agree: overall, by kind (must, must not, judge) and by
 * line, with what it read and what that cost. The judging of record does
 * not change; nothing is written to the note.
 */

import { readFile } from "node:fs/promises";

import {
  DECISION_MODEL,
  decisionEngine,
  decisionTokens,
} from "../src/agent/decide.js";
import { workersAi } from "./models.mjs";
import { priceUsd } from "./report.mjs";
import { parseJudgedSections, parseResult } from "./resultNote.mjs";

const DEFAULT_CONCURRENCY = 8;

/** The state the decision model reads: what the judge saw for one answer, and nothing a judge may not see. */
export function stateFor(answer) {
  return [
    `The person's question: ${answer.questionText}`,
    `Asked by: ${answer.as ?? "unknown"}`,
    "",
    "The conversation:",
    ...answer.conversation.map(
      (turn) =>
        `${turn.from === "person" ? "Person" : "Assistant"}: ${turn.text}`,
    ),
    "",
    `Tools the assistant used: ${answer.toolsLine || "none"}`,
    `Changes the assistant recorded: ${answer.changes.length ? answer.changes.join(" | ") : "none"}`,
  ].join("\n");
}

/** One yes-or-no question per check, keyed c0, c1, … in the judge's order. */
export function questionsFor(verdicts) {
  const questions = {};
  verdicts.forEach((verdict, i) => {
    const wording =
      verdict.kind === "must"
        ? `Does the assistant's answer do this: ${verdict.line}?`
        : verdict.kind === "must not"
          ? `Does the assistant's answer avoid this: ${verdict.line}?`
          : `Is this true of the assistant's answer: ${verdict.line}?`;
    questions[`c${i}`] = {
      type: "noul",
      instructions: wording,
      criteria: {
        true: "Yes, the answer passes this check.",
        false: "No, the answer fails this check.",
      },
    };
  });
  return questions;
}

/** Agreement counts folded into a table: overall, by kind, and the lines that disagree most. */
export function agreementMarkdown({
  model,
  judge,
  rows,
  tokens,
  ms,
  calls,
  failed,
}) {
  const by = (keyOf) => {
    const groups = new Map();
    for (const row of rows) {
      const key = keyOf(row);
      const group = groups.get(key) ?? {
        n: 0,
        agree: 0,
        judgePass: 0,
        decisionPass: 0,
      };
      group.n += 1;
      if (row.agree) group.agree += 1;
      if (row.judgePass) group.judgePass += 1;
      if (row.decisionPass) group.decisionPass += 1;
      groups.set(key, group);
    }
    return groups;
  };
  const pct = (a, n) => (n ? `${((100 * a) / n).toFixed(1)}%` : "n/a");
  const all = by(() => "all").get("all") ?? {
    n: 0,
    agree: 0,
    judgePass: 0,
    decisionPass: 0,
  };
  const usd = priceUsd(model, { input: tokens, output: 0 });
  const out = [
    `## Calibration: ${model} against ${judge}`,
    "",
    `${calls} decision calls, ${failed} failed, ${tokens.toLocaleString()} tokens read, ${usd === null ? "no known price" : `about $${usd.toFixed(2)}`}, ${(ms / 1000).toFixed(0)} s.`,
    "",
    "| checks | verdicts | agree | judge passes | decision passes |",
    "| --- | --- | --- | --- | --- |",
    `| all | ${all.n} | ${pct(all.agree, all.n)} | ${pct(all.judgePass, all.n)} | ${pct(all.decisionPass, all.n)} |`,
  ];
  for (const [kind, g] of [...by((row) => row.kind)].sort())
    out.push(
      `| ${kind} | ${g.n} | ${pct(g.agree, g.n)} | ${pct(g.judgePass, g.n)} | ${pct(g.decisionPass, g.n)} |`,
    );
  out.push(
    "",
    "Lines the two read most differently:",
    "",
    "| kind | line | verdicts | agree |",
    "| --- | --- | --- | --- |",
  );
  const lines = [...by((row) => `${row.kind}\u0000${row.line}`)]
    .map(([key, g]) => ({
      kind: key.split("\u0000")[0],
      line: key.split("\u0000")[1],
      ...g,
    }))
    .filter((g) => g.n >= 3)
    .sort((a, b) => a.agree / a.n - b.agree / b.n)
    .slice(0, 10);
  for (const g of lines)
    out.push(
      `| ${g.kind} | ${g.line.slice(0, 90)} | ${g.n} | ${pct(g.agree, g.n)} |`,
    );
  return out.join("\n") + "\n";
}

/** Runs `work` over `items` with at most `limit` in flight. */
async function inFlight(items, limit, work) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.max(1, limit) }, async () => {
      while (queue.length) await work(queue.shift());
    }),
  );
}

/**
 * Every judged answer put to the decision model; returns the rows (one per
 * verdict) and the totals. `decide(state, questions)` is `decisionEngine`'s
 * shape, so a scripted one tests the plumbing.
 */
export async function calibrateFile({
  path,
  decide,
  model,
  sample = null,
  concurrency = DEFAULT_CONCURRENCY,
  log = () => {},
}) {
  const raw = await readFile(path, "utf8");
  const judged = parseJudgedSections(raw).at(-1);
  if (!judged)
    throw new Error(`${path} has no "## Judged by" section; judge it first`);
  const byId = new Map(
    parseResult(raw).answers.map((answer) => [answer.id, answer]),
  );
  let items = [...judged.blocks]
    .filter(([, block]) => !block.skipped && block.verdicts.length > 0)
    .map(([id, block]) => ({ answer: byId.get(id), block }))
    .filter((item) => item.answer);
  if (sample !== null)
    items = items
      .filter((_, i) => i % Math.max(1, Math.ceil(items.length / sample)) === 0)
      .slice(0, sample);
  const rows = [];
  let tokens = 0;
  let failed = 0;
  let done = 0;
  const started = Date.now();
  await inFlight(items, concurrency, async ({ answer, block }) => {
    const state = stateFor(answer);
    const questions = questionsFor(block.verdicts);
    tokens += decisionTokens(state, questions);
    const answers = await decide(state, questions);
    done += 1;
    if (!answers) {
      failed += 1;
      log(`${answer.id}: no decision (${done}/${items.length})`);
      return;
    }
    block.verdicts.forEach((verdict, i) => {
      const p = answers[`c${i}`]?.noul;
      if (typeof p !== "number") return;
      const decisionPass = p >= 0.5;
      rows.push({
        id: answer.id,
        question: answer.question,
        kind: verdict.kind,
        line: verdict.line,
        judgePass: verdict.pass,
        decisionPass,
        agree: decisionPass === verdict.pass,
        p,
      });
    });
    if (done % 50 === 0 || done === items.length)
      log(`${done}/${items.length} answers compared`);
  });
  return {
    model,
    judge: judged.model,
    rows,
    tokens,
    ms: Date.now() - started,
    calls: items.length,
    failed,
  };
}

/** A scripted decision model: passes a check when the answer holds one of its long words. Plumbing only. */
export function fakeDecide() {
  return async (state, questions) => {
    const said = state.toLowerCase();
    return Object.fromEntries(
      Object.entries(questions).map(([key, q]) => {
        const hit = q.instructions
          .split(/[^A-Za-z]+/)
          .some((word) => word.length > 5 && said.includes(word.toLowerCase()));
        return [key, { noul: hit ? 0.9 : 0.1 }];
      }),
    );
  };
}

/** The `calibrate` command: options come from run.mjs's argument parser. */
export async function calibrateCommand(options) {
  if (!options.job)
    throw new Error(
      "usage: pnpm ai calibrate <judged result file> [--decision <model>] [--sample <n>] [--concurrency <n>] [--fake]",
    );
  const model = options.decision ?? DECISION_MODEL;
  let decide;
  if (options.fake) decide = fakeDecide();
  else {
    const ai = workersAi(
      process.env.CLOUDFLARE_ACCOUNT_ID,
      process.env.CLOUDFLARE_AI_TOKEN,
    );
    // decisionEngine names Clef itself; another decision model on Workers AI is the same call with its own id.
    decide =
      model === DECISION_MODEL
        ? decisionEngine(ai)
        : async (state, questions) => {
            try {
              const raw = await ai.run(model, {
                model: model.split("/").pop(),
                state: state.slice(0, 24_000),
                questions,
              });
              return raw?.answers && typeof raw.answers === "object"
                ? raw.answers
                : null;
            } catch {
              return null;
            }
          };
    if (!decide)
      throw new Error(
        "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_TOKEN are not set",
      );
  }
  const sample = options.sample === undefined ? null : Number(options.sample);
  const concurrency =
    options.concurrency === undefined
      ? DEFAULT_CONCURRENCY
      : Number(options.concurrency);
  const result = await calibrateFile({
    path: options.job,
    decide,
    model: options.fake ? "fake-decision" : model,
    sample,
    concurrency,
    log: (line) => process.stderr.write(`${line}\n`),
  });
  process.stdout.write(agreementMarkdown(result));
}
