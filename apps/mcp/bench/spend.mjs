/**
 * `pnpm ai spend check <test> --setups <a,b>`
 * `pnpm ai spend record <result file> --run <n> [--run-url <url>]`
 *
 * The testing loop's budget, kept where a person can read and raise it: one
 * note, `@context-lc ai/results/spend.md`, with `cap_usd` in its front matter
 * and a row for every round the AI Benchmark Action ran. Dev2 set the cap on
 * 2026-10-17 ("Make sure you don't use more than like $20 of credit though to
 * run these tests") and asked for the loop to run on its own under it, so the
 * Action, not the agent dispatching it, refuses a round that would pass it.
 *
 * `check` refuses before anything is spent when the total so far plus what
 * the round is expected to cost would pass the cap. A round is expected to
 * cost, per setup, the most a setup has cost on the same test before, or $1
 * when the test has never run. `record` adds the round's row: the answers'
 * own prices (the result note's) plus a fifth for the judge and the played
 * person, which the result does not price. It is an estimate, and it leans
 * high on purpose.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { callTool, RESULTS_FOLDER, signIn, splitNote } from "./context.mjs";
import { frontMatter, parseResult } from "./resultNote.mjs";

export const SPEND_NOTE = `${RESULTS_FOLDER}/spend.md`;
/** What the judge and the played person add to the answers' own price. */
export const OVERHEAD = 1.2;
/** What a setup is expected to cost on a test that has never run. */
const UNKNOWN_SETUP_USD = 1;

/** The note's cap and rows. A note with no readable cap has a cap of 0: nothing runs. */
export function parseSpend(raw) {
  const front = frontMatter(raw);
  const cap = Number(front.cap_usd);
  const rows = [];
  for (const line of raw.split("\n")) {
    const cells = line.match(/^\| (\S+) \| (.*?) \| (\S+) \| (.*?) \| (\d+) \| \$(\d+(?:\.\d+)?) \|$/);
    if (!cells) continue;
    rows.push({ date: cells[1], run: cells[2], test: cells[3], setups: cells[4].split(",").map((s) => s.trim()).filter(Boolean), answers: Number(cells[5]), usd: Number(cells[6]) });
  }
  const total = rows.reduce((sum, row) => sum + row.usd, 0);
  return { cap: Number.isFinite(cap) ? cap : 0, rows, total };
}

/** What a round of `test` with `setups` is expected to cost. */
export function expectedUsd({ rows, test, setups }) {
  const per = rows.filter((row) => row.test === test && row.setups.length > 0).map((row) => row.usd / row.setups.length);
  return setups * (per.length ? Math.max(...per) : UNKNOWN_SETUP_USD);
}

/** Whether a round may start: `{ ok, reason }`. */
export function spendCheck({ raw, test, setups }) {
  if (raw === null) return { ok: false, reason: `${SPEND_NOTE} is not in Context: write it with a cap_usd line before running` };
  const { cap, rows, total } = parseSpend(raw);
  const expected = expectedUsd({ rows, test, setups });
  if (total + expected > cap) return { ok: false, reason: `spent $${total.toFixed(2)} of the $${cap.toFixed(2)} cap, and this round is expected to cost $${expected.toFixed(2)}: raise cap_usd in ${SPEND_NOTE} to run it` };
  return { ok: true, reason: `spent $${total.toFixed(2)} of $${cap.toFixed(2)}; this round is expected to cost $${expected.toFixed(2)}` };
}

/** One round's row, from its result note. */
export function roundRow(resultRaw, run) {
  const front = frontMatter(resultRaw);
  const answers = parseResult(resultRaw).answers;
  const price = answers.reduce((sum, answer) => sum + (answer.time?.price ?? 0), 0);
  const setups = String(front.setups ?? "").replace(/^\[|\]$/g, "").split(",").map((item) => item.trim().split("@")[0]).filter(Boolean);
  return { date: front.date, run, test: front.test || front.job, setups, answers: answers.length, usd: Math.round(price * OVERHEAD * 100) / 100 };
}

/** The note with `row` added, and its total line brought up to date. */
export function withRow(raw, row) {
  const line = `| ${row.date} | ${row.run} | ${row.test} | ${row.setups.join(", ")} | ${row.answers} | $${row.usd.toFixed(2)} |`;
  const lines = raw.replace(/\n*$/, "").split("\n");
  const last = lines.findLastIndex((l) => /^\| /.test(l));
  lines.splice(last + 1, 0, line);
  const { cap, total } = parseSpend(lines.join("\n"));
  const totalLine = `Total: $${total.toFixed(2)} of the $${cap.toFixed(2)} cap.`;
  const at = lines.findIndex((l) => l.startsWith("Total: "));
  if (at === -1) lines.push("", totalLine);
  else lines[at] = totalLine;
  return `${lines.join("\n")}\n`;
}

async function readSpend(connection) {
  const read = await callTool(connection, "read_note", { path: SPEND_NOTE });
  if (read.isError) return null;
  return splitNote(read.text);
}

/** The `spend` command: options come from run.mjs's argument parser. */
export async function spendCommand(options, args = process.argv.slice(2)) {
  const [, action, subject] = args;
  const connection = await signIn({ env: process.env });
  if (action === "check") {
    const setups = String(options.setups ?? "").split(",").filter(Boolean).length || 1;
    const note = await readSpend(connection);
    const verdict = spendCheck({ raw: note?.content ?? null, test: subject, setups });
    process.stdout.write(`${verdict.reason}\n`);
    if (!verdict.ok) process.exitCode = 4;
    return;
  }
  if (action === "record") {
    const row = roundRow(await readFile(subject, "utf8"), options["run-url"] ? `[${options.run ?? basename(subject)}](${options["run-url"]})` : String(options.run ?? basename(subject, ".md")));
    // Two tries: the note is shared, and a write that lost a race is read again.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const note = await readSpend(connection);
      if (!note) throw new Error(`${SPEND_NOTE} is not in Context`);
      const written = await callTool(connection, "write_note", { path: SPEND_NOTE, content: withRow(note.content, row), expected_etag: note.header.etag, summary: `spend for ${row.test} ${row.run}` });
      if (!written.isError) {
        process.stdout.write(`recorded $${row.usd.toFixed(2)} for ${row.test}\n`);
        return;
      }
    }
    throw new Error(`could not record the round's spend in ${SPEND_NOTE}`);
  }
  throw new Error("usage: pnpm ai spend check <test> --setups <a,b> | pnpm ai spend record <result file> --run <n> [--run-url <url>]");
}
