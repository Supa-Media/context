/**
 * `pnpm ai spend check <test> --setups <a,b>`
 * `pnpm ai spend record <result file> --run <n> [--run-url <url>]`
 * `pnpm ai spend add <test> --usd <n> --run <n> [--run-url <url>] [--answers <n>]`
 *
 * The testing loop's budget, kept where a person can read and raise it: one
 * note, `@context-lc ai/results/spend.md`. Dev2 set an all-time cap on
 * 2026-10-17 and replaced it on 2026-11-17 with a rolling month
 * (docs/decisions/texting-assistant/auto-promotion.md). The Action refuses a
 * round before anything is spent. A person changes the numbers by editing
 * the note.
 *
 * A note with `monthly_cap_usd` uses the month. One with only `cap_usd` keeps
 * the old all-time check, so an un-migrated note does not change meaning.
 * Once `monthly_cap_usd` is set, `cap_usd` is ignored.
 *
 * Months and days are America/New_York civil dates. A row's date is that
 * civil date. "Now" for a check is the runner's clock converted to that
 * zone, so the month opens at 00:00 on the 1st and the day opens at 00:00,
 * including across the daylight-saving change. New rows are dated with that
 * civil date at record time. Compared in cents: a round that lands exactly
 * on a cap is allowed, and one cent over is refused.
 *
 * This month's limit walks forward from the earliest row. The first month
 * has no previous month, so its limit is `monthly_cap_usd`. Each later month,
 * including a month with no rows, is
 * `monthly_cap_usd + min(rollover_max_usd, max(0, last month's limit - last month's spend))`.
 * Unused budget carries once, capped, and does not stack: two quiet months
 * still leave at most `monthly_cap_usd + rollover_max_usd` (the approved
 * numbers make that $60, and that sum is the ceiling, not a third setting).
 * Spend above a limit does not borrow from the next month. An unreadable
 * `rollover_max_usd` carries nothing, so a typo cannot raise the budget.
 * An unreadable monthly or daily cap refuses every round.
 *
 * `replay-gate` rows are a line inside that same month, capped by
 * `replay_gate_monthly_cap_usd` (default $10 when the key is absent). The
 * line does not roll over and does not shrink the month's limit. A
 * replay-gate round is refused when it would pass that line, or the month's
 * limit, or the day's cap. Any other test is refused only by the month and
 * the day, so it can spend the part of the replay-gate line this month has
 * not used. The line's only job is to stop replay-gate from taking the
 * night's room: at the approved numbers it can take at most $10 of a $40
 * month. Rows already written still count; the line does not rewrite them.
 * An unreadable replay sub-cap refuses replay-gate and leaves other tests
 * alone.
 *
 * A round is expected to cost, per setup, the most a setup has cost on the
 * same test before, or $1 when the test has never run. `record` adds the
 * round's row: the answers' own prices plus a fifth for the judge and the
 * played person, which the result does not price. The estimate leans high.
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
/** Civil dates for the month and the day. */
export const BUDGET_ZONE = "America/New_York";
/** The test name whose rows are the replay-gate line. */
export const REPLAY_GATE_TEST = "replay-gate";
/** The replay-gate line when the note does not name one. */
export const DEFAULT_REPLAY_GATE_MONTHLY_CAP = 10;

const cents = (usd) => Math.round(Number(usd) * 100);
const fromCents = (c) => c / 100;
const exceeds = (spent, extra, cap) => cents(spent) + cents(extra) > cents(cap);
const money = (usd) => `$${Number(usd).toFixed(2)}`;

/** `YYYY-MM-DD` as a civil date, or null. */
export function civilDate(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ""));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day, iso: `${match[1]}-${match[2]}-${match[3]}` };
}

/** The America/New_York civil day of an instant. */
export function calendarDay(date, timeZone = BUDGET_ZONE) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return civilDate(`${get("year")}-${get("month")}-${get("day")}`);
}

function monthName(day) {
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(day.year, day.month - 1, 1)));
}

function readMoney(front, key) {
  if (!Object.hasOwn(front, key)) return { present: false, value: null };
  const value = Number(front[key]);
  return { present: true, value: Number.isFinite(value) && value >= 0 ? value : null };
}

function asDay(asOf) {
  const day = typeof asOf === "string" ? civilDate(asOf) : calendarDay(asOf instanceof Date ? asOf : new Date(asOf));
  if (!day) throw new Error(`not a calendar day: ${asOf}`);
  return day;
}

/** The note's caps and rows. A legacy note with no readable cap has a cap of 0: nothing runs. */
export function parseSpend(raw) {
  const front = frontMatter(raw);
  const monthly = readMoney(front, "monthly_cap_usd");
  const rollover = readMoney(front, "rollover_max_usd");
  const daily = readMoney(front, "daily_cap_usd");
  const replay = readMoney(front, "replay_gate_monthly_cap_usd");
  const legacy = Number(front.cap_usd);
  const rows = [];
  for (const line of raw.split("\n")) {
    const cells = line.match(/^\| (\S+) \| (.*?) \| (\S+) \| (.*?) \| (\d+) \| \$(\d+(?:\.\d+)?) \|$/);
    if (!cells) continue;
    rows.push({ date: cells[1], run: cells[2], test: cells[3], setups: cells[4].split(",").map((s) => s.trim()).filter(Boolean), answers: Number(cells[5]), usd: Number(cells[6]) });
  }
  const total = fromCents(rows.reduce((sum, row) => sum + cents(row.usd), 0));
  return {
    mode: monthly.present ? "monthly" : "legacy",
    cap: Number.isFinite(legacy) && legacy >= 0 ? legacy : 0,
    monthlyCap: monthly.present ? monthly.value : null,
    rolloverMax: !monthly.present ? 0 : rollover.value ?? 0,
    dailyCap: monthly.present ? daily.value : null,
    replayCap: !monthly.present ? null : replay.present ? replay.value : DEFAULT_REPLAY_GATE_MONTHLY_CAP,
    rows,
    total,
  };
}

/**
 * One month's limit, spend and carry. `carry` is what this month received
 * from the month before. The limit is `monthlyCap + carry`.
 */
export function monthBudget(rows, year, month, monthlyCap, rolloverMax) {
  const monthly = cents(monthlyCap);
  const rollover = cents(rolloverMax);
  const spend = new Map();
  let earliest = null;
  for (const row of rows) {
    const day = civilDate(row.date);
    if (!day || !Number.isFinite(row.usd)) continue;
    const key = day.year * 12 + (day.month - 1);
    spend.set(key, (spend.get(key) ?? 0) + cents(row.usd));
    if (earliest === null || key < earliest) earliest = key;
  }
  const target = year * 12 + (month - 1);
  const spentTarget = spend.get(target) ?? 0;
  if (earliest === null || target < earliest) return { limit: fromCents(monthly), spend: fromCents(spentTarget), carry: 0 };
  let prevLimit = monthly;
  let prevSpend = monthly;
  let limit = monthly;
  let carry = 0;
  for (let key = earliest; key <= target; key += 1) {
    carry = Math.min(rollover, Math.max(0, prevLimit - prevSpend));
    limit = monthly + carry;
    const spent = spend.get(key) ?? 0;
    if (key === target) return { limit: fromCents(limit), spend: fromCents(spent), carry: fromCents(carry) };
    prevLimit = limit;
    prevSpend = spent;
  }
  throw new Error("month walk missed its target");
}

function spentCents(rows, accept) {
  let sum = 0;
  for (const row of rows) if (accept(row) && Number.isFinite(row.usd)) sum += cents(row.usd);
  return sum;
}

/** The budget as of a civil day: month, day, and the replay-gate line. */
export function budgetAt(parsed, asOf = new Date()) {
  const day = asDay(asOf);
  const replaySpend = fromCents(spentCents(parsed.rows, (row) => row.test === REPLAY_GATE_TEST && civilDate(row.date)?.year === day.year && civilDate(row.date)?.month === day.month));
  const daySpend = fromCents(spentCents(parsed.rows, (row) => row.date === day.iso));
  const base = {
    mode: parsed.mode,
    cap: parsed.cap,
    total: parsed.total,
    rows: parsed.rows,
    monthlyCap: parsed.monthlyCap,
    rolloverMax: parsed.rolloverMax,
    dailyCap: parsed.dailyCap,
    replayCap: parsed.replayCap,
    asOf: day,
    replaySpend,
    daySpend,
  };
  if (parsed.mode !== "monthly" || !Number.isFinite(parsed.monthlyCap)) return { ...base, monthSpend: parsed.total, monthLimit: parsed.cap, carry: 0 };
  const month = monthBudget(parsed.rows, day.year, day.month, parsed.monthlyCap, parsed.rolloverMax);
  return { ...base, monthSpend: month.spend, monthLimit: month.limit, carry: month.carry };
}

/** The budget after `row` is recorded, still as of the same civil day. */
export function noteRound(budget, row) {
  return budgetAt({ ...budget, rows: [...budget.rows, row] }, budget.asOf.iso);
}

/** What a round of `test` with `setups` is expected to cost. */
export function expectedUsd({ rows, test, setups }) {
  const per = rows.filter((row) => row.test === test && row.setups.length > 0).map((row) => row.usd / row.setups.length);
  return setups * (per.length ? Math.max(...per) : UNKNOWN_SETUP_USD);
}

/** Whether a round of `test` may start. `expected` is its expected cost. */
export function roundAllowed(budget, expected, test = "") {
  if (budget.mode !== "monthly") {
    if (exceeds(budget.total, expected, budget.cap)) return { ok: false, reason: `spent ${money(budget.total)} of the ${money(budget.cap)} cap, and this round is expected to cost ${money(expected)}: raise cap_usd in ${SPEND_NOTE} to run it` };
    return { ok: true, reason: `spent ${money(budget.total)} of ${money(budget.cap)}; this round is expected to cost ${money(expected)}` };
  }
  if (!Number.isFinite(budget.monthlyCap)) return { ok: false, reason: `an unreadable monthly_cap_usd is no cap: nothing runs until ${SPEND_NOTE} has a number` };
  if (!Number.isFinite(budget.dailyCap)) return { ok: false, reason: `an unreadable daily_cap_usd is no cap: nothing runs until ${SPEND_NOTE} has a number` };
  if (test === REPLAY_GATE_TEST && !Number.isFinite(budget.replayCap)) return { ok: false, reason: `an unreadable replay_gate_monthly_cap_usd is no cap: replay-gate runs nothing until ${SPEND_NOTE} has a number` };
  const blocks = [];
  if (test === REPLAY_GATE_TEST && exceeds(budget.replaySpend, expected, budget.replayCap)) blocks.push(`replay-gate is at ${money(budget.replaySpend)} of its ${money(budget.replayCap)} monthly sub-cap`);
  if (exceeds(budget.monthSpend, expected, budget.monthLimit)) blocks.push(`this month is at ${money(budget.monthSpend)} of its ${money(budget.monthLimit)} limit`);
  if (exceeds(budget.daySpend, expected, budget.dailyCap)) blocks.push(`today is at ${money(budget.daySpend)} of its ${money(budget.dailyCap)} daily cap`);
  if (blocks.length === 0) {
    const replay = test === REPLAY_GATE_TEST ? ` replay-gate is at ${money(budget.replaySpend)} of ${money(budget.replayCap)};` : "";
    return { ok: true, reason: `spent ${money(budget.monthSpend)} of ${monthName(budget.asOf)}'s ${money(budget.monthLimit)} limit and ${money(budget.daySpend)} of today's ${money(budget.dailyCap)} daily cap;${replay} this round is expected to cost ${money(expected)}` };
  }
  const onlyReplay = blocks.length === 1 && blocks[0].startsWith("replay-gate");
  const onlyDay = blocks.length === 1 && blocks[0].startsWith("today");
  const fix = onlyReplay ? `raise replay_gate_monthly_cap_usd in ${SPEND_NOTE} to run it` : onlyDay ? `the daily cap stops rounds until the next America/New_York day` : `raise the cap it passed in ${SPEND_NOTE}`;
  return { ok: false, reason: `${blocks.join("; ")}, and this round is expected to cost ${money(expected)}: ${fix}` };
}

/** Whether a round may start: `{ ok, reason }`. */
export function spendCheck({ raw, test, setups, now = new Date() }) {
  if (raw === null) return { ok: false, reason: `${SPEND_NOTE} is not in Context: write it with monthly_cap_usd, rollover_max_usd and daily_cap_usd (or the older cap_usd) before running` };
  const budget = budgetAt(parseSpend(raw), now);
  const expected = expectedUsd({ rows: budget.rows, test, setups });
  return { ...roundAllowed(budget, expected, test), expected };
}

/** One round's row, from its result note. */
export function roundRow(resultRaw, run) {
  const front = frontMatter(resultRaw);
  const answers = parseResult(resultRaw).answers;
  const price = answers.reduce((sum, answer) => sum + (answer.time?.price ?? 0), 0);
  const setups = String(front.setups ?? "").replace(/^\[|\]$/g, "").split(",").map((item) => item.trim().split("@")[0]).filter(Boolean);
  return { date: front.date, run, test: front.test || front.job, setups, answers: answers.length, usd: Math.round(price * OVERHEAD * 100) / 100 };
}

function renderTotal(budget) {
  if (budget.mode !== "monthly") return `Total: ${money(budget.total)} of the ${money(budget.cap)} cap.`;
  const extras = [];
  if (budget.carry > 0) extras.push(`${money(budget.carry)} carried in`);
  extras.push(`${money(budget.daySpend)} of the ${money(budget.dailyCap)} daily cap on ${budget.asOf.iso}`);
  extras.push(Number.isFinite(budget.replayCap) ? `replay-gate ${money(budget.replaySpend)} of its ${money(budget.replayCap)}` : "replay-gate sub-cap unreadable");
  return `Total: ${money(budget.monthSpend)} of ${monthName(budget.asOf)}'s ${money(budget.monthLimit)} limit (${extras.join("; ")}).`;
}

/** The note with `row` added, and its total line brought up to date for that row's day. */
export function withRow(raw, row) {
  const line = `| ${row.date} | ${row.run} | ${row.test} | ${row.setups.join(", ")} | ${row.answers} | $${row.usd.toFixed(2)} |`;
  const lines = raw.replace(/\n*$/, "").split("\n");
  const last = lines.findLastIndex((l) => /^\| /.test(l));
  lines.splice(last + 1, 0, line);
  const text = lines.join("\n");
  const totalLine = renderTotal(budgetAt(parseSpend(text), civilDate(row.date) ? row.date : calendarDay(new Date()).iso));
  const at = lines.findIndex((l) => l.startsWith("Total: "));
  if (at === -1) lines.push("", totalLine);
  else lines[at] = totalLine;
  return `${lines.join("\n")}\n`;
}

/** One row added to the spend note. Two tries: the note is shared, and a write that lost a race is read again. */
export async function addSpendRow(connection, row, fetchImpl = fetch) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const note = await readSpend(connection, fetchImpl);
    if (!note) throw new Error(`${SPEND_NOTE} is not in Context`);
    const written = await callTool(connection, "write_note", { path: SPEND_NOTE, content: withRow(note.content, row), expected_etag: note.header.etag, summary: `spend for ${row.test} ${row.run}` }, fetchImpl);
    if (!written.isError) return;
  }
  throw new Error(`could not record the round's spend in ${SPEND_NOTE}`);
}

export async function readSpend(connection, fetchImpl = fetch) {
  const read = await callTool(connection, "read_note", { path: SPEND_NOTE }, fetchImpl);
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
  if (action === "record" || action === "add") {
    const run = options["run-url"] ? `[${options.run ?? subject}](${options["run-url"]})` : String(options.run ?? subject);
    // The ledger date is the America/New_York civil date at record time, so the
    // row lands on the day and month the check uses. The result note keeps its own stamp.
    const date = calendarDay(new Date()).iso;
    const row =
      action === "add"
        ? { date, run, test: String(subject), setups: ["production"], answers: Number(options.answers ?? 0), usd: Math.round(Number(options.usd) * 100) / 100 }
        : { ...roundRow(await readFile(subject, "utf8"), options["run-url"] ? `[${options.run ?? basename(subject)}](${options["run-url"]})` : String(options.run ?? basename(subject, ".md"))), date };
    // A test name is one word in the table (`parseSpend` reads its cell as \S+).
    if (action === "add" && (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(row.test) || !Number.isFinite(row.usd) || row.usd < 0)) throw new Error("spend add needs a one-word test name and --usd <dollars>");
    await addSpendRow(connection, row);
    process.stdout.write(`recorded $${row.usd.toFixed(2)} for ${row.test}\n`);
    return;
  }
  throw new Error("usage: pnpm ai spend check <test> --setups <a,b> | spend record <result file> --run <n> [--run-url <url>] | spend add <test> --usd <n> --run <n>");
}
