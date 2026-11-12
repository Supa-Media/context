/**
 * `pnpm ai steps <ledgers folder> [--questions 9,10]`: where a round's time
 * went, step by step, read from the ledger files a run writes
 * (`modelLog.mjs`). Each reply in a chat ledger carries the turn's timed steps
 * (`texTiming.js`), and each turn's trace carries every model round, tool call
 * and reply review with its milliseconds. Medians and maxima, as a Markdown
 * table for the run's summary page.
 *
 * Asked for by Dev2 (2026-11-11, one-judge PR 3): "measure before changing",
 * so a speed change is argued from where the time went, not from a guess.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/** The median of the numbers; the mean of the two middle values for an even count. */
export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The ledger file's JSON block. */
const ledgerOf = (raw) => JSON.parse(raw.slice(raw.indexOf("```json") + 7, raw.lastIndexOf("```")));

/**
 * The timings of a set of ledgers: `reply` (ms per reply), `steps` (ms per
 * step name), `trace` (ms per turn for each trace kind, tools by name), and
 * `sentBack` (reviews that sent a draft back, per turn).
 */
export function stepTimings(ledgers, questions = null) {
  const out = { reply: [], steps: {}, trace: {}, sentBack: [] };
  for (const ledger of ledgers) {
    if (questions !== null && !questions.includes(ledger.question)) continue;
    for (const entry of ledger.chat ?? []) {
      if (entry.kind !== "reply" || !entry.timing) continue;
      out.reply.push(entry.timing.replyMs);
      for (const step of entry.timing.steps ?? []) (out.steps[step.name] ??= []).push(step.ms);
    }
    for (const turn of ledger.turns ?? []) {
      const sums = {};
      for (const entry of turn) {
        const kind = entry.kind === "tool" ? `tool ${entry.tool}` : entry.kind === "judge" ? "reviewer" : entry.kind;
        sums[kind] = (sums[kind] ?? 0) + (entry.ms ?? 0);
      }
      for (const [kind, ms] of Object.entries(sums)) (out.trace[kind] ??= []).push(ms);
      out.sentBack.push(turn.filter((entry) => entry.kind === "judge" && entry.acted).length);
    }
  }
  return out;
}

const secs = (ms) => (ms === null ? "n/a" : `${(ms / 1000).toFixed(2)} s`);

/** The table: the reply first, then the trace kinds, then every step that took 50 ms or more at its slowest. */
export function stepsMarkdown(timings) {
  const rows = [["Reply, whole turn", timings.reply]];
  for (const [kind, values] of Object.entries(timings.trace)) rows.push([`Per turn: ${kind}`, values]);
  for (const [name, values] of Object.entries(timings.steps)) if (Math.max(...values) >= 50) rows.push([`Step: ${name}`, values]);
  const sentBack = timings.sentBack.filter((count) => count > 0).length;
  return [
    "| What | Count | Median | Max |",
    "| --- | --- | --- | --- |",
    ...rows.map(([what, values]) => `| ${what} | ${values.length} | ${secs(median(values))} | ${secs(values.length ? Math.max(...values) : null)} |`),
    "",
    `Turns the reviewer sent back: ${sentBack} of ${timings.sentBack.length}.`,
  ].join("\n");
}

export async function stepsCommand(options) {
  const folder = options.job; // the first word after `steps` is the folder
  if (!folder) throw new Error("pnpm ai steps <ledgers folder> [--questions 9,10]");
  const ledgers = [];
  for (const name of (await readdir(folder)).filter((file) => file.endsWith(".ledger.md"))) ledgers.push(ledgerOf(await readFile(join(folder, name), "utf8")));
  const questions = options.questions ? String(options.questions).split(",").map(Number) : null;
  process.stdout.write(`${stepsMarkdown(stepTimings(ledgers, questions))}\n`);
}
