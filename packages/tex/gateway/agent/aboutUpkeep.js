/**
 * KEEPING ABOUT ME SHORT AND TRUE (Dev2, 2026-11-20).
 *
 * "We shouldn't just be adding on to it ... we should really have a budget ... and then start pruning the things that
 * aren't important ... checking the facts of like, oh, the November 11th thing is no longer a thing because there's new
 * email." About me (`tex/about.md`) is read on every turn, and before this only grew: the dream read the chat since
 * the last night, never the mail or calendar that made a line stale, so a line about an email from nine days ago read
 * as today's news.
 *
 * Two nightly steps keep it in check, both after the dream (`graph/nodes/aboutExpire.js`, `graph/nodes/aboutCheck.js`):
 *
 *  - A line that is only true until a day carries that day in its marker: `- Party Sat at 7 (Tex noticed, 2026-11-19,
 *    until 2026-11-21)`. The day after, code takes it out, by date and never by a model (`expireLines`).
 *  - Once a week a model rechecks every dated line older than a week against their mail, calendar and notes, and says
 *    for each line it doubts whether to drop it or what it should say now. It writes nothing: code applies its
 *    decisions (`applyDecisions`), which may only drop a line or rewrite one it names. It can never add a line, so
 *    nothing a stranger wrote in an email becomes a new fact about them.
 *
 * The budget (`limits.chars` on the dream step) is the size the dream keeps the note under, dropping the least
 * important lines first; the note's hard cap (`aboutMe.js`) still refuses anything past it.
 */

import { BULLET, TRAILING, bodyStart, itemOf, markerOf } from "./aboutLines.js";

/** The budget when the dream step's config names none (`limits.chars`). */
export const ABOUT_BUDGET_CHARS = 12_000;
/** How often the recheck runs, in days, when its step's config names none (`limits.everyDays`). */
export const RECHECK_EVERY_DAYS = 7;
/** A line is rechecked once it is older than this many days (`limits.olderThanDays`). */
export const RECHECK_OLDER_THAN_DAYS = 7;
/** At most this many lines go to one recheck, oldest first (`limits.lines`). */
export const RECHECK_MAX_LINES = 60;

const DAY_MS = 24 * 60 * 60 * 1000;
const UNTIL = /(?:^|[,;·|(\[]\s*)until\s+(\d{4})-(\d{2})-(\d{2})\s*(?=[,;·|)\]]|$)/i;

/** The day a line stops being true (`until YYYY-MM-DD` in its marker), as YYYY-MM-DD, or null. */
export function untilOf(line) {
  const found = UNTIL.exec(String(line ?? ""));
  return found ? `${found[1]}-${found[2]}-${found[3]}` : null;
}

/** The note's lines with their index, each an about item (a bullet with words) or null. */
function items(text) {
  const lines = String(text ?? "").split("\n");
  const start = bodyStart(lines);
  return lines.map((raw, i) => ({ i, raw, item: i >= start ? itemOf(raw) : null }));
}

/**
 * The note without the lines whose `until` day is before `today` (YYYY-MM-DD, in their time zone). Answers the new
 * text and the lines it took out, word for word. Headings left with no lines under them go too.
 */
export function expireLines(text, today) {
  const dropped = [];
  const kept = [];
  for (const { raw, item } of items(text)) {
    const until = item ? untilOf(raw) : null;
    if (until !== null && until < today) dropped.push(raw.trim());
    else kept.push(raw);
  }
  return { text: dropped.length === 0 ? String(text ?? "") : withoutEmptyHeadings(kept).join("\n"), dropped };
}

/** Lines with any heading that has no item left under it (before the next heading of its level or higher) removed. */
function withoutEmptyHeadings(lines) {
  const level = (line) => /^(#{1,6})\s/.exec(line.trim())?.[1].length ?? 0;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const own = level(lines[i]);
    if (own > 1) {
      let has = false;
      for (let j = i + 1; j < lines.length; j++) {
        const next = level(lines[j]);
        if (next > 0 && next <= own) break;
        if (next === 0 && itemOf(lines[j]) !== null) {
          has = true;
          break;
        }
      }
      if (!has) {
        // drop the heading and the blank line after it
        if (lines[i + 1]?.trim() === "") i += 1;
        continue;
      }
    }
    out.push(lines[i]);
  }
  return out;
}

/**
 * The lines a recheck looks at: every dated item written before `now - olderThanDays`, oldest first, at most `max`.
 * Each is `{ n, line }`, `n` its line number in the note (from 1), which is how the model names it back.
 */
export function linesToRecheck(text, now, { olderThanDays = RECHECK_OLDER_THAN_DAYS, max = RECHECK_MAX_LINES } = {}) {
  const cutoff = now - olderThanDays * DAY_MS;
  return items(text)
    .filter(({ item }) => item !== null && item.at !== undefined && item.at < cutoff)
    .sort((a, b) => a.item.at - b.item.at || a.i - b.i)
    .slice(0, max)
    .map(({ i, raw }) => ({ n: i + 1, line: raw.trim() }));
}

/**
 * A recheck's decisions applied to the note it was shown. `decisions` is the model's list of
 * `{ n, action: "drop" | "update", text?, why }`; only lines in `allowed` (the line numbers it was shown) may be
 * touched, an update replaces the line's words and keeps its bullet, and gets the marker `(Tex rechecked, <today>)`.
 * Anything else (a line it wasn't shown, an unknown action, an update with no words or one many times longer than
 * the line) is ignored and listed in `ignored`. Nothing is ever added.
 */
export function applyDecisions(text, decisions, allowed, today) {
  const lines = String(text ?? "").split("\n");
  const shown = new Set(allowed);
  const dropped = [];
  const updated = [];
  const ignored = [];
  const drop = new Set();
  const seen = new Set();
  for (const d of Array.isArray(decisions) ? decisions : []) {
    const n = Number(d?.n);
    const why = typeof d?.why === "string" ? d.why.trim().slice(0, 300) : "";
    if (!Number.isInteger(n) || !shown.has(n) || seen.has(n)) {
      ignored.push({ n: d?.n ?? null, why: "not a line it was shown" });
      continue;
    }
    seen.add(n);
    const raw = lines[n - 1];
    const item = itemOf(raw ?? "");
    if (item === null) {
      ignored.push({ n, why: "not an about line" });
      continue;
    }
    if (d.action === "drop") {
      drop.add(n - 1);
      dropped.push({ line: raw.trim(), why });
    } else if (d.action === "update") {
      const words = typeof d.text === "string" ? d.text.replace(/\s+/g, " ").trim() : "";
      if (words === "" || words.length > Math.max(400, raw.length * 2)) {
        ignored.push({ n, why: "an update with no words, or far longer than the line" });
        continue;
      }
      const unbulleted = words.replace(BULLET, "");
      const marker = TRAILING.exec(unbulleted);
      const bare = marker && markerOf(marker[1]) ? unbulleted.slice(0, marker.index).trim() : unbulleted;
      const next = `${item.bullet || "- "}${bare} (Tex rechecked, ${today})`;
      lines[n - 1] = next;
      updated.push({ from: raw.trim(), to: next.trim(), why });
    } else if (d.action !== "keep") {
      ignored.push({ n, why: `no action "${String(d.action).slice(0, 20)}"` });
    }
  }
  const kept = lines.filter((_, i) => !drop.has(i));
  return { text: dropped.length === 0 && updated.length === 0 ? String(text ?? "") : withoutEmptyHeadings(kept).join("\n"), dropped, updated, ignored };
}

/** The model's decisions out of its answer: the first JSON array in it, or [] when there is none. */
export function decisionsOf(answer) {
  const text = String(answer ?? "");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Whether a recheck is due: never run, or run at least `everyDays` before `now`. */
export function recheckDue(lastAt, now, everyDays = RECHECK_EVERY_DAYS) {
  return !Number.isFinite(lastAt) || now - lastAt >= everyDays * DAY_MS - 60 * 60 * 1000;
}

/** The dream's words about the budget and `until` days, added after its instructions (`dream.js`). */
export function budgetWords(chars = ABOUT_BUDGET_CHARS) {
  return [
    `## Budget\n\nKeep ${"tex/about.md"} under ${chars.toLocaleString("en-US")} characters. It is read on every text, so every line must earn its place. ` +
      "When it would go over, drop the least important lines first: one-off events and plans that are over, then details nobody will ask about again, " +
      "and only last who they are, the people in their life, their goals and how they want you to answer. Merge lines that say the same thing.",
    "A line that is only true until a day (an event, a trip, a reply they are waiting on, a membership that ends) ends its marker with that day: " +
      "`(Tex noticed, 2026-11-19, until 2026-11-21)`. It is taken out the day after, by itself. A line a newer text contradicts is fixed or dropped, never kept beside the new one.",
  ].join("\n\n");
}
