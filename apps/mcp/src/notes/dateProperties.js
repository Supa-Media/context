/**
 * Date properties a note asked for: `date created` and `date modified`, and their usual spellings, filled by Context
 * itself (Dev2, 2026-11-10; `docs/decisions/app-and-console/date-properties.md`). Pure text in, text out: the callers
 * (`notes/dateStamp.js`) decide when, and with which clock, zone and workspace format.
 *
 * The rules, each a promise to the person:
 *  - Only keys the note already has, in its front matter. A missing key is never added.
 *  - A `created` key is filled only while it is empty, and never overwritten.
 *  - A `modified` key is filled while empty, and moved on a content save. A save that changes nothing but date
 *    values is not content (`contentChanged`), so the stamp cannot set itself off.
 *  - A value that is not a date this file can read (a block list, "by hand") is left as it is.
 *  - The format is copied: the note's own date values first, then the workspace's (`workspaceStyle`), else ISO 8601
 *    with the zone's offset. Always the owner's zone, never UTC (a copied `Z` is written with the offset).
 *
 * Edits are line edits inside the front matter: every other byte (quotes, spacing, CRLF, a byte-order mark, the key's
 * own spelling) stays as it was, so an open editor sees one value change and nothing else.
 */

import { isEncryptedNote } from "../encryption/format.js";

/** The routines' default zone when an account has none (`agent/localNow.js` `DEFAULT_TIME_ZONE`). */
export const DEFAULT_DATE_ZONE = "America/New_York";

const CREATED_KEYS = new Set(["date created", "created", "date_created", "created_at"]);
const MODIFIED_KEYS = new Set(["date modified", "modified", "updated", "date_modified", "updated_at"]);

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** A key line, as `lists/properties.js` `noteProperties` reads one: the key, then the rest after `:`. */
const KEY_LINE = /^([^:#\s][^:]*?)(\s*:)(\s*)(.*)$/;
const FENCE = /^---\s*$/;

/** `"created" | "modified" | null` for a front matter key. */
export function roleOfKey(key) {
  const name = String(key).trim().toLowerCase();
  if (CREATED_KEYS.has(name)) return "created";
  if (MODIFIED_KEYS.has(name)) return "modified";
  return null;
}

/** The front matter's lines: `{bom, lines: [{text, end}], close}` with `close` the closing fence's index, or null. */
function frontMatter(text) {
  if (typeof text !== "string") return null;
  const bom = text.startsWith("﻿") ? "﻿" : "";
  const source = text.slice(bom.length);
  if (!/^---\r?\n/.test(source)) return null;
  const lines = [];
  const pattern = /([^\r\n]*)(\r\n|\n|$)/g;
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    lines.push({ text: match[1], end: match[2] });
    if (match[2] === "") break;
  }
  for (let index = 1; index < lines.length; index += 1) {
    if (FENCE.test(lines[index].text)) return { bom, lines, close: index };
  }
  return null;
}

/** The value as written: its quote (`"`, `'` or none) and the text inside. */
function unquoted(raw) {
  const value = raw.trimEnd();
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) return { quote: value[0], inner: value.slice(1, -1) };
  return { quote: "", inner: value };
}

/** Each top-level date key in the front matter: `{index, key, role, quote, value, empty, block}`. */
function dateLines(front) {
  const found = [];
  if (front === null) return found;
  for (let index = 1; index < front.close; index += 1) {
    const match = KEY_LINE.exec(front.lines[index].text);
    if (!match) continue;
    const role = roleOfKey(match[1]);
    if (role === null) continue;
    const { quote, inner } = unquoted(match[4]);
    const next = front.lines[index + 1]?.text ?? "";
    // `created:` with indented or `- ` lines below is a list or a map, not an empty value.
    const block = match[4].trim() === "" && index + 1 < front.close && (/^\s+\S/.test(next) || /^-\s/.test(next));
    found.push({ index, key: match[1], role, sep: `${match[2]}${match[3] === "" ? " " : match[3]}`, quote, value: inner.trim(), empty: !block && inner.trim() === "", block });
  }
  return found;
}

/** The date keys a note's front matter has, in order: `[{key, role, value, empty}]`. Encrypted notes have none. */
export function dateKeysOf(text) {
  if (typeof text !== "string" || isEncryptedNote(text)) return [];
  return dateLines(frontMatter(text)).map(({ key, role, value, empty }) => ({ key, role, value, empty }));
}

/** Whether the note asked for any date property. */
export function hasDateKeys(text) {
  return dateKeysOf(text).length > 0;
}

/** The note with every date key's value taken out: what is left is its content. */
function withoutDates(text) {
  const front = frontMatter(text);
  if (front === null) return text;
  const lines = front.lines.map((line) => ({ ...line }));
  for (const { index } of dateLines(front)) {
    const match = KEY_LINE.exec(lines[index].text);
    lines[index].text = `${match[1]}:`;
  }
  return front.bom + lines.map((line) => line.text + line.end).join("");
}

/** Whether `next` changed anything but date values since `previous`. A note with no `previous` is new: it did. */
export function contentChanged(previous, next) {
  if (typeof previous !== "string") return true;
  return withoutDates(previous) !== withoutDates(next);
}

const LINTER = /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}(st|nd|rd|th) \d{4}, \d{1,2}:\d{2}:\d{2} (am|pm|AM|PM)$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?$/;
const SPACED = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The format of a date value, or `null` for one this file cannot read. `name` is what the workspace's format is
 * kept as (`linter`, `iso`, `local`, `spaced`, `date`); the rest says how precisely to write it.
 */
export function styleOf(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (LINTER.test(text)) return { name: "linter", upper: /(AM|PM)$/.test(text) };
  const iso = ISO.exec(text);
  if (iso) {
    const precision = iso[2] ? "ms" : iso[1] ? "s" : "m";
    return iso[3] ? { name: "iso", precision } : { name: "local", precision };
  }
  const spaced = SPACED.exec(text);
  if (spaced) return { name: "spaced", precision: spaced[1] ? "s" : "m" };
  if (DAY.test(text)) return { name: "date" };
  return null;
}

/** A style kept by name (the workspace's): the precision its values most often have. */
export function styleNamed(name) {
  if (name === "linter") return { name: "linter", upper: false };
  if (name === "iso" || name === "local" || name === "spaced") return { name, precision: "s" };
  if (name === "date") return { name: "date" };
  return null;
}

/** A zone this runtime knows, else the default: never UTC by accident. */
function zoneOf(timeZone) {
  if (typeof timeZone === "string" && timeZone !== "" && timeZone.length <= 64) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone });
      return timeZone;
    } catch {
      // An unknown zone reads as none.
    }
  }
  return DEFAULT_DATE_ZONE;
}

/** The wall clock at `ms` in `zone`, and the zone's offset there in minutes. */
function wall(ms, zone) {
  const parts = {};
  const format = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
  for (const part of format.formatToParts(new Date(ms))) parts[part.type] = part.value;
  const clock = { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour) % 24, minute: Number(parts.minute), second: Number(parts.second) };
  const asUtc = Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second);
  return { ...clock, ms: ms % 1000 < 0 ? 0 : Math.floor(ms % 1000), weekday: new Date(Date.UTC(clock.year, clock.month - 1, clock.day)).getUTCDay(), offset: Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000) };
}

const two = (n) => String(n).padStart(2, "0");
const ordinal = (day) => (day % 100 >= 11 && day % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][day % 10] ?? "th");

/** `ms` written in `style` (null: ISO 8601 with offset, to the second) at `timeZone`'s wall clock. */
export function formatDate(ms, timeZone, style) {
  const w = wall(ms, zoneOf(timeZone));
  const date = `${w.year}-${two(w.month)}-${two(w.day)}`;
  const time = (precision) => `${two(w.hour)}:${two(w.minute)}${precision === "m" ? "" : `:${two(w.second)}`}${precision === "ms" ? `.${String(w.ms).padStart(3, "0")}` : ""}`;
  const offset = `${w.offset < 0 ? "-" : "+"}${two(Math.floor(Math.abs(w.offset) / 60))}:${two(Math.abs(w.offset) % 60)}`;
  switch (style?.name) {
    case "linter": {
      const hour = w.hour % 12 === 0 ? 12 : w.hour % 12;
      const half = w.hour < 12 ? "am" : "pm";
      return `${WEEKDAYS[w.weekday]}, ${MONTHS[w.month - 1]} ${w.day}${ordinal(w.day)} ${w.year}, ${hour}:${two(w.minute)}:${two(w.second)} ${style.upper ? half.toUpperCase() : half}`;
    }
    case "local":
      return `${date}T${time(style.precision)}`;
    case "spaced":
      return `${date} ${time(style.precision)}`;
    case "date":
      return date;
    case "iso":
      return `${date}T${time(style.precision)}${offset}`;
    default:
      return `${date}T${time("s")}${offset}`;
  }
}

/**
 * The note with its date properties filled. Returns `text` itself when there is nothing to do.
 *
 * @param {string} text the note as it is about to be (or was just) saved
 * @param {{previous: string|null, modifiedAt: number, createdAt: number|null, timeZone?: string|null, workspaceStyle?: string|null}} when
 *   `previous` the note before this save (null for a new note); `modifiedAt` this content save's time; `createdAt` when
 *   the note was first saved, or null when unknown (an empty `created` then waits); `workspaceStyle` the workspace's
 *   format by name, for a note with no date value of its own to copy.
 */
export function stampDates(text, { previous = null, modifiedAt, createdAt = null, timeZone = null, workspaceStyle = null } = {}) {
  if (typeof text !== "string" || isEncryptedNote(text)) return text;
  const front = frontMatter(text);
  const keys = dateLines(front);
  if (keys.length === 0) return text;
  const changed = contentChanged(previous, text);
  const own = keys.map((key) => (key.empty ? null : styleOf(key.value))).filter(Boolean);
  const fallback = own[0] ?? styleNamed(workspaceStyle);
  const lines = front.lines.map((line) => ({ ...line }));
  let touched = false;
  for (const key of keys) {
    if (key.block) continue;
    let at = null;
    let style = null;
    if (key.role === "created") {
      if (!key.empty || !Number.isFinite(createdAt)) continue;
      at = createdAt;
      style = fallback;
    } else if (key.empty) {
      if (!Number.isFinite(modifiedAt)) continue;
      at = modifiedAt;
      style = fallback;
    } else {
      // A value this file cannot read is the person's own words, not a date to move.
      style = styleOf(key.value);
      if (!changed || style === null || !Number.isFinite(modifiedAt)) continue;
      at = modifiedAt;
    }
    const value = formatDate(at, timeZone, style);
    if (!key.empty && value === key.value) continue;
    const match = KEY_LINE.exec(lines[key.index].text);
    lines[key.index].text = `${match[1]}${key.sep}${key.quote}${value}${key.quote}`;
    touched = true;
  }
  return touched ? front.bom + lines.map((line) => line.text + line.end).join("") : text;
}

/** The format most of these values share, by name, or null: a workspace's format, from its notes' date values. */
export function commonStyle(values) {
  const counts = new Map();
  for (const value of values) {
    const name = styleOf(value)?.name;
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  let best = null;
  for (const [name, count] of counts) if (best === null || count > best[1]) best = [name, count];
  return best === null ? null : best[0];
}
