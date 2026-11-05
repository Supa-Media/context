/**
 * `search_notes` with `from` and `to`: what the notes say is on each day of a
 * range, across every workspace the person reaches (asked for by the owner,
 * 2026-11-05).
 *
 * A word search ranks words; it cannot sweep dates. "What's due in the last
 * week of October?" was searched as "due October 25 26 27 28 29 30 31
 * deadline", and the note that said "Slides due October 28" never made the
 * twelve shown (core benchmark q17, gh-178). Here each day of the range is its
 * own search, written the two ways notes write a day ("October 28", "Oct 28"),
 * in this workspace and every other one the search everywhere reaches, each
 * through the same `searchVisibleNotes` and privacy as an ordinary search. A
 * hit is kept only for a line that names a day inside the range, and the
 * answer is those lines, day by day.
 *
 * Words only: search by meaning has nothing to say about which day a line names.
 */

import { loadPrivacyState } from "../privacy/state.js";
import { searchVisibleNotes } from "../search/visibleNotes.js";
import { searchSettingsOf } from "../search/settings.js";
import { PINNED_CONTEXT_NAME } from "../orient/globalNote.js";
import { toolError, toolText } from "./results.js";

/** The longest range one call sweeps, in days. */
export const MAX_RANGE_DAYS = 14;
/** Searches running at once, across days and workspaces. */
const CONCURRENCY = 6;
/** Lines kept for one day. */
const LINES_PER_DAY = 12;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SHORT = MONTHS.map((month) => month.slice(0, 3));
const MONTH_WORD = new Map([...MONTHS.map((m, i) => [m.toLowerCase(), i]), ...SHORT.map((m, i) => [m.toLowerCase(), i]), ["sept", 8]]);
const DAY = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` as a UTC day number, or null. */
function dayOf(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text ?? "").trim());
  if (!match) return null;
  const at = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const date = new Date(at);
  return date.getUTCMonth() === Number(match[2]) - 1 ? at / DAY : null;
}

const iso = (day) => new Date(day * DAY).toISOString().slice(0, 10);
const label = (day) => new Date(day * DAY).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

/**
 * The days a line names, as UTC day numbers: "October 28", "Oct 28th", "28 October", "2026-10-28".
 * A day with no year is read in `year`.
 */
export function daysNamed(line, year) {
  const found = new Set();
  const text = String(line ?? "");
  for (const match of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const day = dayOf(match[0]);
    if (day !== null) found.add(day);
  }
  const named = (monthWord, dayText, yearText) => {
    const month = MONTH_WORD.get(monthWord.toLowerCase().replace(/\.$/, ""));
    const date = Number(dayText);
    if (month === undefined || !(date >= 1 && date <= 31)) return;
    const at = Date.UTC(yearText ? Number(yearText) : year, month, date);
    if (new Date(at).getUTCMonth() === month) found.add(at / DAY);
  };
  for (const match of text.matchAll(/\b([A-Za-z]{3,9}\.?)\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4}))?/g)) named(match[1], match[2], match[3]);
  for (const match of text.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([A-Za-z]{3,9})\b(?:,?\s+(\d{4}))?/g)) named(match[2], match[1], match[3]);
  return [...found];
}

/** Run `work` over `items`, `limit` at a time, answers in order. */
async function inTurns(items, limit, work) {
  const out = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const at = next++;
      out[at] = await work(items[at]);
    }
  });
  await Promise.all(runners);
  return out;
}

/** The workspaces a dated search covers: this one, and the others a search everywhere reaches (`findNotes`). */
function workspacesOf(store) {
  const others =
    typeof store.openContext === "function" && searchSettingsOf(store).everywhere
      ? (store.contexts ?? [])
          .filter((entry) => !entry.current && typeof entry.name === "string")
          .filter((entry) => entry.name !== PINNED_CONTEXT_NAME || entry.role === "owner" || entry.role === "editor")
          .map((entry) => entry.name)
      : [];
  return [null, ...others];
}

export async function toolSearchDated(store, scope, rules, overrides, { from, to, query = "" } = {}) {
  const first = dayOf(from);
  const last = dayOf(to ?? from);
  if (first === null || last === null) return toolError("from and to are days written YYYY-MM-DD");
  if (last < first) return toolError("to is before from");
  if (last - first + 1 > MAX_RANGE_DAYS) return toolError(`one search sweeps at most ${MAX_RANGE_DAYS} days: split the range`);
  const words = typeof query === "string" ? query.trim() : "";
  const days = Array.from({ length: last - first + 1 }, (_, i) => first + i);

  const places = await Promise.all(
    workspacesOf(store).map(async (name) => {
      if (name === null) return { name, store, scope, rules, overrides };
      try {
        const { session: target, store: targetStore } = await store.openContext(name);
        const privacy = await loadPrivacyState(targetStore);
        return privacy.error ? null : { name, store: targetStore, scope: target.scope, rules: privacy.rules, overrides: privacy.overrides };
      } catch {
        return null;
      }
    })
  );
  const asks = [];
  for (const place of places.filter(Boolean)) {
    for (const day of days) {
      const date = new Date(day * DAY);
      for (const month of new Set([MONTHS[date.getUTCMonth()], SHORT[date.getUTCMonth()]])) {
        asks.push({ place, query: `${words ? `${words} ` : ""}${month} ${date.getUTCDate()}` });
      }
    }
  }
  let incomplete = false;
  const answers = await inTurns(asks, CONCURRENCY, async ({ place, query: asked }) => {
    try {
      const found = await searchVisibleNotes(place.store, place.scope, place.rules, place.overrides, asked, "");
      if (found.indexIncomplete || found.degraded) incomplete = true;
      return { place, hits: found.hits ?? [] };
    } catch {
      incomplete = true;
      return { place, hits: [] };
    }
  });

  const year = new Date(first * DAY).getUTCFullYear();
  const byDay = new Map(days.map((day) => [day, new Map()]));
  for (const { place, hits } of answers) {
    for (const hit of hits) {
      const key = place.name ? `${place.name}/${hit.key}` : hit.key;
      for (const snippet of hit.snippets ?? []) {
        for (const line of String(snippet).split("\n").map((l) => l.trim()).filter(Boolean)) {
          for (const day of daysNamed(line, year)) {
            const lines = byDay.get(day);
            if (!lines) continue;
            const seen = lines.get(key) ?? new Set();
            seen.add(line.replace(/^…|…$/g, ""));
            lines.set(key, seen);
          }
        }
      }
    }
  }

  const blocks = [];
  for (const [day, notes] of byDay) {
    if (notes.size === 0) continue;
    const entries = [...notes].slice(0, LINES_PER_DAY).map(([key, lines]) => `  ${key}\n${[...lines].map((line) => `    ${line}`).join("\n")}`);
    blocks.push(`${label(day)} (${iso(day)})\n${entries.join("\n")}`);
  }
  const range = first === last ? iso(first) : `${iso(first)} to ${iso(last)}`;
  const head = blocks.length
    ? `What the notes say is on each day, ${range}${words ? `, with "${words}"` : ""}, across every workspace searched. A day missing here has no line naming it. Read a note before relying on a line.`
    : `No note names a day from ${range}${words ? ` with "${words}"` : ""}. A note may still write the date another way (next Tuesday, the 28th): search its words too.`;
  const tail = incomplete ? "\n\n[note: some workspaces' search was not complete, so a dated line may be missing.]" : "";
  return toolText(`${head}${blocks.length ? `\n\n${blocks.join("\n\n")}` : ""}${tail}`);
}
