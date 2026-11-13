/**
 * TEX'S LIVE DRIFT SCORE (Dev2, 2026-11-13): the benchmarks say how Tex does on invented chats; this says how it is
 * doing with people, from the scores Tex's self-review already writes for every finished conversation
 * (`@context-lc areas/tex-reviews/scores/<day>.md`: numbers only, nobody named). One day is held against the seven
 * before it, weighted by conversations, and a drop past the bar is an alert.
 *
 *   pnpm ai drift [--day YYYY-MM-DD]     prints the drift lines; exits 3 when it alerts
 *
 * The report is numbers and measure names only, so it may go to a public issue.
 */
import { callTool, signIn, splitNote } from "./context.mjs";
import { frontMatter } from "./resultNote.mjs";

export const SCORES_FOLDER = "areas/tex-reviews/scores";
/** Days held up against the one measured. */
export const BASELINE_DAYS = 7;
/** A drop of this much in the mean of every measure is an alert, on a 1 to 10 scale. */
export const OVERALL_DROP = 1;
/** A drop of this much in any one measure is an alert. */
export const MEASURE_DROP = 1.5;
/** Fewer conversations than this on the day, or in the baseline, is too few to tell. */
export const MIN_DAY = 5;
export const MIN_BASELINE = 10;

/** One day's note: its conversations and each measure's average, or null when it is not a scores note. */
export function parseDayScores(raw) {
  const front = frontMatter(raw);
  const conversations = Number(front.conversations);
  if (!front.day || !Number.isFinite(conversations)) return null;
  const measures = {};
  let inTable = false;
  for (const line of raw.split("\n")) {
    if (/^\| Measure \| Average \|/.test(line)) inTable = true;
    else if (inTable && /^\| ---/.test(line)) continue;
    else if (inTable) {
      const m = /^\| (.+?) \| (\d+(?:\.\d+)?) \|$/.exec(line);
      if (!m) break;
      measures[m[1]] = Number(m[2]);
    }
  }
  return { day: String(front.day), conversations, measures };
}

/** The conversation-weighted mean of each measure over some days. */
function weighted(days) {
  const total = days.reduce((sum, day) => sum + day.conversations, 0);
  const names = [...new Set(days.flatMap((day) => Object.keys(day.measures)))];
  const means = {};
  for (const name of names) {
    const counted = days.filter((day) => Number.isFinite(day.measures[name]));
    const weight = counted.reduce((sum, day) => sum + day.conversations, 0);
    if (weight > 0) means[name] = counted.reduce((sum, day) => sum + day.measures[name] * day.conversations, 0) / weight;
  }
  return { total, means };
}

const overall = (means) => {
  const values = Object.values(means);
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
};

/**
 * The drift of `day` against the `BASELINE_DAYS` before it: `{ day, status: "alert" | "steady" | "too few", overall,
 * baseline, drops: [{ measure, now, before }] }`. `days` is every parsed day available, in any order.
 */
export function driftOf(days, day) {
  const today = days.find((d) => d.day === day) ?? null;
  const before = days.filter((d) => d.day < day).sort((a, b) => (a.day < b.day ? 1 : -1)).slice(0, BASELINE_DAYS);
  const base = weighted(before);
  if (!today || today.conversations < MIN_DAY || base.total < MIN_BASELINE) {
    return { day, status: "too few", conversations: today?.conversations ?? 0, baselineConversations: base.total, overall: today ? overall(today.measures) : null, baseline: overall(base.means), drops: [] };
  }
  const now = overall(today.measures);
  const was = overall(base.means);
  const drops = Object.keys(today.measures)
    .filter((name) => Number.isFinite(base.means[name]) && base.means[name] - today.measures[name] >= MEASURE_DROP)
    .map((name) => ({ measure: name, now: today.measures[name], before: base.means[name] }));
  const alert = drops.length > 0 || (now !== null && was !== null && was - now >= OVERALL_DROP);
  return { day, status: alert ? "alert" : "steady", conversations: today.conversations, baselineConversations: base.total, overall: now, baseline: was, drops };
}

const n1 = (value) => (value === null || value === undefined ? "n/a" : value.toFixed(1));

/** The drift as Markdown lines: numbers and measure names only. */
export function driftLines(drift) {
  const head = {
    alert: `**Live drift ⚠️ dropped** on ${drift.day}`,
    steady: `**Live drift ✅ steady** on ${drift.day}`,
    "too few": `**Live drift: too few conversations to tell** on ${drift.day}`,
  }[drift.status];
  const lines = [
    `${head}: ${n1(drift.overall)} across ${drift.conversations} conversation(s), against ${n1(drift.baseline)} across ${drift.baselineConversations} in the ${BASELINE_DAYS} days before (1 to 10, higher is better).`,
  ];
  if (drift.status === "too few") lines.push(`It takes ${MIN_DAY} conversations on the day and ${MIN_BASELINE} in the days before.`);
  for (const drop of drift.drops) lines.push(`- ${drop.measure}: ${n1(drop.now)}, down from ${n1(drop.before)}.`);
  if (drift.status === "alert") lines.push(`An alert is a drop of ${OVERALL_DROP} in the mean of every measure, or ${MEASURE_DROP} in one. Read that day's reviews in areas/tex-reviews/ for the conversations behind it.`);
  return lines;
}

/** The day before `now`'s, as YYYY-MM-DD: the last whole day of conversations when the nightly runs. */
export const yesterday = (now = new Date()) => new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);

/** Every day's scores note from `day` back past the baseline, from Context. */
export async function readDays(connection, day, fetchImpl = fetch) {
  const days = [];
  for (let back = 0; back <= BASELINE_DAYS + 3; back += 1) {
    const date = new Date(Date.parse(`${day}T12:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);
    const read = await callTool(connection, "read_note", { path: `${SCORES_FOLDER}/${date}.md` }, fetchImpl);
    if (read.isError) continue;
    const parsed = parseDayScores(splitNote(read.text).content);
    if (parsed) days.push(parsed);
  }
  return days;
}

export async function driftCommand(options, { connection = null, write = (text) => process.stdout.write(text) } = {}) {
  const day = options.day ?? yesterday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("--day takes YYYY-MM-DD");
  const days = await readDays(connection ?? (await signIn({ env: process.env })), day);
  const drift = driftOf(days, day);
  write(`${driftLines(drift).join("\n")}\n`);
  if (drift.status === "alert") process.exitCode = 3;
  return drift;
}
