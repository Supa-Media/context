/**
 * QUIET HOURS (Dev2, 2026-11-08: the Tex page showed them, nothing kept them).
 *
 * A `quiet-hours:` line in `tex/heartbeat.md`'s front matter, such as
 * `quiet-hours: 11 pm to 7 am` or `22:00-07:00`, holds Tex's own texts that
 * nobody asked for at that moment: a check-in waits for the first slot after
 * the window, and a ping one of their agents asked for waits until it ends,
 * unless it is an emergency. A routine or a reminder they set for a time
 * still goes at that time: they chose it.
 *
 * Read here and in the Tex page (`http/texPage/notes.js`), the same words.
 */

import { wallClock } from "../../../../packages/shared/src/routines.cjs";

const MINUTE_MS = 60 * 1000;
const DAY_MINUTES = 24 * 60;

/** One time of day, `11 pm`, `7am`, `22:00`, `7:30 am`, as minutes after midnight, or null. */
function minutesOf(words) {
  const match = /^\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\s*$/i.exec(words);
  if (match === null) return null;
  let hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  if (minute > 59) return null;
  const half = match[3]?.toLowerCase().replace(/\./g, "");
  if (half !== undefined) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (half === "pm" ? 12 : 0);
  } else if (match[2] === undefined || hour > 23) {
    // A bare number is too unsure to keep anyone from being texted.
    return null;
  }
  return hour * 60 + minute;
}

/** The window a `quiet-hours:` value names, `{ from, until }` in minutes after midnight, or null when it names none. */
export function readQuietHours(value) {
  if (typeof value !== "string") return null;
  const parts = value.replace(/^["']|["']$/g, "").split(/\s*(?:\bto\b|–|—|-|until)\s*/i);
  if (parts.length !== 2) return null;
  const from = minutesOf(parts[0]);
  const until = minutesOf(parts[1]);
  if (from === null || until === null || from === until) return null;
  return { from, until };
}

/** The `quiet-hours:` value of a note's front matter, or null. */
export function quietHoursLine(text) {
  const lines = String(text ?? "").replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  for (const line of lines.slice(1)) {
    if (line.trim() === "---" || line.trim() === "...") return null;
    const match = /^\s*quiet[-_ ]?hours\s*:\s*(.+?)\s*$/i.exec(line);
    if (match) return match[1];
  }
  return null;
}

/**
 * When the quiet window `now` falls in ends, in ms, or null when `now` is not
 * in one. A window may run past midnight (`11 pm to 7 am`).
 */
export function quietUntil(window, now, timeZone) {
  if (window === null || window === undefined) return null;
  const w = wallClock(now, timeZone);
  const at = w.hour * 60 + w.minute;
  const inside = window.from < window.until ? at >= window.from && at < window.until : at >= window.from || at < window.until;
  if (!inside) return null;
  const left = (window.until - at + DAY_MINUTES) % DAY_MINUTES;
  return now - (now % MINUTE_MS) + left * MINUTE_MS;
}
