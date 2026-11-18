/**
 * The bench's day summaries: one `day` ledger entry for each day of an earlier chat that is older than the Front door's
 * word-for-word window.
 *
 * Production sums each finished day up the night after (`daySummaries.js`), and the Front door reads each older day's
 * summary in place of its texts (`weekHistory.js`). The bench has no nights, so a chat that spans weeks would have its
 * days past the window vanish from the turn, or, before this module, be squeezed into six days. This writes the same
 * entry shape with a deterministic stand-in for the model: each line in order, quoted, with no model call, so a run
 * stays offline and the same on every run. The text is the day's own words, clipped to the production cap, newest
 * lines kept.
 */

import { MAX_SUMMARY_CHARS } from "../src/agent/daySummaries.js";
import { dayOf } from "../src/agent/jobLog.js";
import { DEFAULT_READS, historyReadsOf, weekStart } from "../src/agent/weekHistory.js";

/** The model name a bench day summary is kept under, so a run's entries read as the bench's own. */
export const BENCH_MODEL = "bench";

/**
 * The days of the word-for-word window the Front door reads for this config: the chat module's days, `null` for the
 * whole chat (no day is older than the window then), or the default 7 when the config names none.
 */
export function chatWindowDays(env) {
  const reads = historyReadsOf(env) ?? DEFAULT_READS;
  return reads.chat === null ? 0 : reads.chat.days;
}

/** One line in a day summary: the person's text, or Tex's answer, named as production's summary names them. */
function sentence(line, group, words) {
  if (line.from === "tex") return `You answered: "${words}".`;
  const who = group && line.who ? `@${line.who}` : "They";
  return `${who} texted: "${words}".`;
}

/** A line's words, one line of spaces, a picture-only text named as one. */
const wordsOf = (line) => String(line.text ?? "").replace(/\s+/g, " ").trim() || "(a picture)";

/**
 * One day's summary: its lines in order, each as one sentence, newest kept when they will not all fit in the cap. A
 * newest line that alone is longer than the cap keeps its end, as the cut is at the front.
 */
export function summaryOf(lines, group = false) {
  const kept = [];
  let size = 0;
  for (const line of [...lines].reverse()) {
    const one = sentence(line, group, wordsOf(line));
    const next = size === 0 ? one.length : size + 1 + one.length;
    if (next > MAX_SUMMARY_CHARS) break;
    kept.unshift(one);
    size = next;
  }
  if (kept.length > 0) return kept.join(" ");
  const newest = lines.at(-1);
  const base = sentence(newest, group, "").length;
  const room = MAX_SUMMARY_CHARS - base;
  return sentence(newest, group, `…${wordsOf(newest).slice(-(room - 1))}`);
}

/**
 * The `day` entries for `lines` (`{ at, from, who?, text }`, each at its own time in ms) that fall before the window
 * of `days` days (`weekStart`, in `timeZone`, as the Front door measures it) and before today. One entry per day,
 * shaped as `daySummaries.js` writes it; `days` of `null` (the whole chat is word for word) writes none.
 */
export function benchDaySummaries({ lines, now, timeZone, days, group = false }) {
  if (days === null) return [];
  const start = weekStart(now, timeZone, days);
  const today = dayOf(now, timeZone);
  const byDay = new Map();
  for (const line of lines) {
    if (!Number.isSafeInteger(line.at) || line.at >= start) continue;
    const day = dayOf(line.at, timeZone);
    if (day >= today) continue;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(line);
  }
  return [...byDay.keys()].sort().map((day) => {
    const dayLines = byDay.get(day).sort((a, b) => a.at - b.at);
    return { v: 1, id: `day-${day}`, at: dayLines.at(-1).at, kind: "day", day, text: summaryOf(dayLines, group), model: BENCH_MODEL };
  });
}
