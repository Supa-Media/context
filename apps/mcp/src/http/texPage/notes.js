/**
 * The notes behind the Tex page: a person's Routines, Check-ins and "About
 * you" lines, read and changed for one chat at a time.
 *
 * ONE STORAGE DOOR. Every function here takes `call(name, args)`, a function
 * the page's route binds to `callToolForSession({ name, arguments }, store,
 * session)`, exactly as Tex's own turns do (`agent/chatHome.js`,
 * `agent/routine.js`). Nothing here touches a store, a bucket or a Durable
 * Object, so a workspace kept in either works the same. Reads are
 * `read_note`; writes are `write_note` with the etag the read returned;
 * removal is `archive_note`, the only retraction the gateway has (there is no
 * delete). A group chat's notes are addressed with `context: "@<slug>"`.
 *
 * A routine's id is `${slug ?? ""}:${path}`. An id whose path is not under
 * `tex/routines/` or `routines/` is refused before anything is read.
 *
 * Note text is never logged, and never returned in an error: an error is one
 * fixed word (`changed`, `denied`, `failed`, `not_found`, `no_etag`, `invalid`).
 *
 * Fake names only in comments and tests.
 */

import {
  describeSchedule,
  frontMatter,
  routineFromPath,
  routineSettings,
  wallClock,
} from "../../../../../packages/shared/src/routines.cjs";
import { bodyStart, isAboutNotePath, itemOf } from "../../agent/aboutLines.js";
import { DREAMS_SETTINGS_PATH, HOUSEKEEPING_SETTINGS_PATH, switchedOff } from "../../agent/texSwitches.js";

/** Where routines live: Tex's own folder first, the older root still read and run. */
const ROUTINE_ROOTS = Object.freeze(["tex/routines/", "routines/"]);
const ONCE_ROOTS = Object.freeze(["tex/routines/once/", "routines/once/"]);

/** The person's own check-in settings (`agent/checkIns.js`). */
const HEARTBEAT_SETTINGS_PATH = "tex/heartbeat.md";

/** At most this many routine notes are read per call, in parallel. */
const MAX_ROUTINES_READ = 30;
const WHAT_MAX = 140;
const MAX_LINE = 2000;
const MAX_BODY = 4000;
const DAY_MS = 86400000;
const RECENT_MS = DAY_MS;

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const WHEN = /^(\d{4})-(\d{2})-(\d{2}) (\d{1,2}):(\d{2})$/;
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const fail = (error) => ({ ok: false, error });

// ── Calls ───────────────────────────────────────────────────────────────────

/** `@slug` for a context name, as the gateway's tools address one. */
function atName(name) {
  const text = String(name ?? "").trim();
  return text.startsWith("@") ? text : `@${text}`;
}

/** The `context` argument for a call, or nothing for the caller's own workspace. */
function ctx(context) {
  return typeof context === "string" && context !== "" ? { context: atName(context) } : {};
}

function textOf(result) {
  return (Array.isArray(result?.content) ? result.content : [])
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("\n");
}

/** A write's refusal as one fixed word. Its own text (a conflict carries the note) is never passed on. */
function refusalOf(result) {
  const head = textOf(result).split(/[:\n(]/, 1)[0].trim().toLowerCase();
  if (head.startsWith("conflict")) return "changed";
  if (head.startsWith("permission denied")) return "denied";
  return "failed";
}

/**
 * A note read through the door: `{ etag, note, moved }`, where `note` is the
 * whole note below the header lines. Null when it can't be read, is missing,
 * or has moved (a moved note is not the one that was asked for).
 */
async function readNote(call, path, context) {
  let result;
  try {
    result = await call("read_note", { path, ...ctx(context) });
  } catch {
    return null;
  }
  if (result?.isError === true) return null;
  const text = textOf(result);
  const split = text.indexOf("\n\n");
  const header = split === -1 ? text : text.slice(0, split);
  if (/^moved_from:/m.test(header)) return null;
  const etag = /^etag: (.+)$/m.exec(header)?.[1]?.trim() || null;
  return { etag, note: split === -1 ? "" : text.slice(split + 2) };
}

/** Write `content` to `path`, refusing a stale etag. `expectedEtag` null creates a new note. */
async function writeNote(call, path, content, expectedEtag, context) {
  const args = { path, content, ...(expectedEtag ? { expected_etag: expectedEtag } : {}), ...ctx(context) };
  let result;
  try {
    result = await call("write_note", args);
  } catch {
    return fail("failed");
  }
  return result?.isError === true ? fail(refusalOf(result)) : { ok: true };
}

/** Retract a note into the archive, the gateway's removal (`archive_note`, as `routine.js` `stopRoutine` uses it). */
async function archiveNote(call, path, expectedEtag, context) {
  let result;
  try {
    result = await call("archive_note", { path, expected_etag: expectedEtag, ...ctx(context) });
  } catch {
    return fail("failed");
  }
  return result?.isError === true ? fail(refusalOf(result)) : { ok: true };
}

// ── Paths and ids ───────────────────────────────────────────────────────────

/** A routine note's path: under one of the routine roots, a `.md`, and no way out of the root. */
export function isRoutinePath(path) {
  if (typeof path !== "string" || path.length > 512) return false;
  if (/[\\\u0000-\u001f]/.test(path) || path.includes("..") || path.startsWith("/")) return false;
  return ROUTINE_ROOTS.some((root) => path.startsWith(root) && path.length > root.length && path.endsWith(".md"));
}

function isOncePath(path) {
  return ONCE_ROOTS.some((root) => path.startsWith(root) && path.endsWith(".md") && !path.slice(root.length).includes("/"));
}

/** `${slug}:${path}` back into its parts, or null. A path outside the routine roots is never parsed. */
export function parseId(id) {
  if (typeof id !== "string") return null;
  const cut = id.indexOf(":");
  if (cut === -1) return null;
  const slug = id.slice(0, cut);
  const path = id.slice(cut + 1);
  if (slug !== "" && !SLUG.test(slug)) return null;
  if (!isRoutinePath(path)) return null;
  return { slug: slug === "" ? null : slug, path };
}

const idOf = (slug, path) => `${slug ?? ""}:${path}`;

/** Their about note: the person's, or a group chat's home note (`agent/chatHome.js`, `agent/aboutLines.js`). */
const isAboutPath = isAboutNotePath;

// ── Note text ───────────────────────────────────────────────────────────────

/** A note split into its front matter lines (null when it has none) and its body. */
function splitNote(text) {
  const raw = String(text ?? "").replace(/^\uFEFF/, "");
  const lines = raw.split("\n");
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line === "---" || line === "...") return { front: lines.slice(1, i), body: lines.slice(i + 1).join("\n") };
    }
  }
  return { front: null, body: raw };
}

function joinNote(front, body) {
  return front === null || front.length === 0 ? body : `---\n${front.join("\n")}\n---\n${body}`;
}

/** The front matter lines with `key` set to `value` (replacing it in place), or removed when `value` is null. */
function setKey(front, key, value) {
  const same = new RegExp(`^${key}\\s*:`, "i");
  const out = [];
  let placed = false;
  for (const line of front) {
    if (!same.test(line.trim())) {
      out.push(line);
    } else if (value !== null && !placed) {
      out.push(`${key}: ${value}`);
      placed = true;
    }
  }
  if (value !== null && !placed) out.push(`${key}: ${value}`);
  return out;
}

/** The note's text with one front matter key set (or removed); a note with no front matter gains one. */
function withFrontKey(text, key, value) {
  const note = splitNote(text);
  return joinNote(setKey(note.front ?? [], key, value), note.body);
}

/** The note's body below its front matter, trimmed. */
export function bodyOf(text) {
  return splitNote(text).body.trim();
}

function clip(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function humanName(path) {
  const base = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "").replace(/[-_]+/g, " ").trim();
  return base === "" ? path : base.charAt(0).toUpperCase() + base.slice(1);
}

function titleOf(body, path) {
  const heading = /^#{1,6}\s+(.+)$/m.exec(body);
  return heading ? heading[1].trim() : humanName(path);
}

/** The first line of the body that is not blank or a heading (the title says the heading). */
function firstLine(body) {
  const line = body.split("\n").find((entry) => entry.trim() !== "" && !/^#{1,6}\s/.test(entry.trim()));
  return line === undefined ? undefined : clip(line.trim(), WHAT_MAX);
}

// ── Time ────────────────────────────────────────────────────────────────────

function zoneOr(zone, fallback = "UTC") {
  if (typeof zone !== "string" || zone === "") return fallback;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return fallback;
  }
}

/** A row's instant as ms: a number, or a date string; anything else is null. */
function instantOf(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string" && value !== "") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

const dayNumber = (w) => Math.round(Date.UTC(w.year, w.month - 1, w.day) / DAY_MS);

/** "Tonight at 9:30 pm", "Tomorrow at 8 am", "Sat Nov 7 at 9:30 pm": when a run is, in their zone. */
function wordsAt(ms, zone, now) {
  const w = wallClock(ms, zone);
  const days = dayNumber(w) - dayNumber(wallClock(now, zone));
  const hour12 = w.hour % 12 === 0 ? 12 : w.hour % 12;
  const clock = `${hour12}${w.minute === 0 ? "" : `:${String(w.minute).padStart(2, "0")}`} ${w.hour < 12 ? "am" : "pm"}`;
  const lead =
    days === 0 ? (w.hour >= 17 ? "Tonight" : "Today") : days === 1 ? "Tomorrow" : `${WEEKDAY[w.weekday]} ${MONTH[w.month - 1]} ${w.day}`;
  return `${lead} at ${clock}`;
}

/** `YYYY-MM-DD HH:MM` for a check-in's `at:`, or null when it is not a real date and time. */
export function normalizeWhen(value) {
  const match = WHEN.exec(String(value ?? "").trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  if (hour > 23 || minute > 59) return null;
  return `${match[1]}-${match[2]}-${match[3]} ${String(hour).padStart(2, "0")}:${match[5]}`;
}

// ── Routines and check-ins ──────────────────────────────────────────────────

/** One row's read: its title, schedule and first line, or null when the note can't be read. */
async function readRow(call, row, cadence, zone, now) {
  const context = row.slug ?? null;
  const read = await readNote(call, row.path, context);
  const note = read?.note ?? null;
  const body = note === null ? null : bodyOf(note);
  const settings = note === null ? null : routineSettings(note, cadence).settings;
  const nextAt = instantOf(row.nextRunAt);
  const id = idOf(row.slug, row.path);

  if (cadence.unit === "once") {
    const done = row.nextRunAt === undefined ? Boolean(settings?.done) : nextAt === null;
    const when = nextAt !== null ? wordsAt(nextAt, zone, now) : settings ? describeSchedule(cadence, settings) : "Not scheduled";
    return { kind: "checkin", item: { id, when, what: body === null ? undefined : firstLine(body) ?? "", done, ...(nextAt !== null ? { at: nextAt } : {}) } };
  }

  const paused = row.paused === true || settings?.paused === true;
  const when = settings
    ? describeSchedule(cadence, settings)
    : nextAt !== null
      ? `Next ${wordsAt(nextAt, zone, now)}`
      : "Not scheduled";
  const item = {
    id,
    title: body === null ? humanName(row.path) : titleOf(body, row.path),
    when,
    on: !paused,
    ...(body === null ? {} : { what: firstLine(body) ?? "" }),
  };
  return { kind: "routine", item };
}

/**
 * The person's routines and check-ins, for the page. `rows` are the control
 * plane's routine rows (`slug` null for the caller's own workspace). Up to 30
 * notes are read, in parallel; a row past that, or a note that fails to read,
 * keeps its place with the title from its path and the time its row says.
 */
export async function readRoutines(call, rows, { now = Date.now(), timeZone = "UTC" } = {}) {
  const zone = zoneOr(timeZone);
  const routines = [];
  const checkins = [];
  const usable = (Array.isArray(rows) ? rows : [])
    .map((row) => ({ row: normalizeRow(row), cadence: routineFromPath(row?.path) }))
    .filter(({ row, cadence }) => row !== null && isRoutinePath(row.path) && cadence?.kind === "routine");
  const results = await Promise.all(
    usable.map(({ row, cadence }, index) => (index < MAX_ROUTINES_READ ? readRow(call, row, cadence.cadence, zone, now) : unreadRow(row, cadence.cadence, zone, now))),
  );
  for (const result of results) {
    if (result.kind === "checkin") checkins.push(result.item);
    else routines.push(result.item);
  }
  checkins.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
  return { routines, checkins };
}

function normalizeRow(row) {
  if (row === null || typeof row !== "object" || typeof row.path !== "string") return null;
  return { ...row, slug: typeof row.slug === "string" && row.slug !== "" ? row.slug : null };
}

/** A row not read: its title from the path, its time from the row alone. */
function unreadRow(row, cadence, zone, now) {
  const nextAt = instantOf(row.nextRunAt);
  const when = nextAt !== null ? `${cadence.unit === "once" ? "" : "Next "}${wordsAt(nextAt, zone, now)}` : "Not scheduled";
  const id = idOf(row.slug, row.path);
  if (cadence.unit === "once") return { kind: "checkin", item: { id, when, done: nextAt === null, ...(nextAt !== null ? { at: nextAt } : {}) } };
  return { kind: "routine", item: { id, title: humanName(row.path), when, on: row.paused !== true } };
}

/** The check-in settings (`tex/heartbeat.md`): paused, looks at, quiet hours. Defaults when the note is missing. */
export async function readCheckinSettings(call) {
  const read = await readNote(call, HEARTBEAT_SETTINGS_PATH, null);
  if (read === null) return { looksAt: [], paused: false };
  const fields = frontMatter(read.note);
  const paused = /^(true|yes|on)$/i.test(String(fields.paused ?? "").replace(/^["']|["']$/g, "").trim());
  const looks = fields["looks-at"] ?? fields.looks ?? fields.looks_at;
  const looksAt = typeof looks === "string" ? looks.replace(/^\[|\]$/g, "").split(/\s*,\s*/).map((word) => word.trim()).filter(Boolean) : [];
  const quiet = fields["quiet-hours"] ?? fields.quiet ?? fields.quiet_hours;
  return { looksAt, paused, ...(typeof quiet === "string" && quiet.trim() !== "" ? { quietHours: quiet.trim() } : {}) };
}

/** Toggle a routine: `paused: yes` to stop it, `paused: no` to run it again. */
export async function routineToggle(call, id, on) {
  const target = parseId(id);
  if (target === null) return fail("not_found");
  const read = await readNote(call, target.path, target.slug);
  if (read === null) return fail("not_found");
  if (!read.etag) return fail("no_etag");
  return writeNote(call, target.path, withFrontKey(read.note, "paused", on === true ? "no" : "yes"), read.etag, target.slug);
}

/**
 * Tex's own jobs the person can switch off (`agent/texSwitches.js`): the daily
 * tidy and the nightly rewrite of About me, each on unless its note says
 * `paused: yes`. The same switch Tex flips from a text.
 */
const SWITCH_PATHS = Object.freeze({ housekeeping: HOUSEKEEPING_SETTINGS_PATH, dreams: DREAMS_SETTINGS_PATH });

/** `{ housekeeping, dreams }`, each true when on. A note that is missing or can't be read is on. */
export async function readSwitches(call) {
  const on = async (path) => !switchedOff((await readNote(call, path, null))?.note ?? "");
  const [housekeeping, dreams] = await Promise.all([on(SWITCH_PATHS.housekeeping), on(SWITCH_PATHS.dreams)]);
  return { housekeeping, dreams };
}

/** Switch one of Tex's own jobs on or off: `paused: no` or `yes` in its note, made when it is missing. */
export async function switchSet(call, name, on) {
  const path = Object.hasOwn(SWITCH_PATHS, name) ? SWITCH_PATHS[name] : null;
  if (path === null || typeof on !== "boolean") return fail("invalid");
  return await frontSet(call, path, "paused", on ? "no" : "yes");
}

/**
 * One front matter key of one of Tex's own settings notes in the person's `tex/` folder (`tex/heartbeat.md`,
 * `tex/attention.md`, ...), set to `value` or removed with null; the note is made when it is missing. For the Tex page's
 * switches and for a setting changed by text (`agent/settingsTools.js`).
 */
export async function frontSet(call, path, key, value) {
  if (typeof path !== "string" || !/^tex\/[a-z-]+\.md$/.test(path)) return fail("invalid");
  let result;
  try {
    result = await call("read_note", { path });
  } catch {
    return fail("failed");
  }
  const missing = result?.isError === true && /^not found\b/i.test(textOf(result).trim());
  if (result?.isError === true && !missing) return fail("failed");
  const read = missing ? { etag: null, note: "" } : await readNote(call, path, null);
  if (read === null || (!missing && !read.etag)) return fail("no_etag");
  return writeNote(call, path, withFrontKey(read.note, key, value), read.etag, null);
}

/** Remove a routine: archived, so it can be recovered, and it stops running. */
export async function routineRemove(call, id) {
  const target = parseId(id);
  if (target === null) return fail("not_found");
  const read = await readNote(call, target.path, target.slug);
  if (read === null) return fail("not_found");
  if (!read.etag) return fail("no_etag");
  return archiveNote(call, target.path, read.etag, target.slug);
}

/**
 * Edit a check-in: `when` ("YYYY-MM-DD HH:MM") sets its `at:` and re-arms it
 * if it had run (`done:` goes); `what` replaces its body. Either or both.
 */
export async function checkinEdit(call, id, { when, what } = {}) {
  const target = parseId(id);
  if (target === null || !isOncePath(target.path)) return fail("not_found");
  const hasWhen = when !== undefined;
  const hasWhat = what !== undefined;
  if (!hasWhen && !hasWhat) return fail("invalid");
  const at = hasWhen ? normalizeWhen(when) : null;
  if (hasWhen && at === null) return fail("invalid");
  const body = hasWhat ? String(what).trim() : null;
  if (hasWhat && (body === "" || body.length > MAX_BODY)) return fail("invalid");
  const read = await readNote(call, target.path, target.slug);
  if (read === null) return fail("not_found");
  if (!read.etag) return fail("no_etag");

  const note = splitNote(read.note);
  let front = note.front ?? [];
  if (hasWhen) {
    front = setKey(front, "on", null);
    front = setKey(front, "done", null);
    front = setKey(front, "at", at);
  }
  const text = joinNote(front, hasWhat ? `${body}\n` : note.body);
  return writeNote(call, target.path, text, read.etag, target.slug);
}

/** Cancel a check-in: archived, as a routine's removal is. */
export async function checkinCancel(call, id) {
  const target = parseId(id);
  if (target === null || !isOncePath(target.path)) return fail("not_found");
  const read = await readNote(call, target.path, target.slug);
  if (read === null) return fail("not_found");
  if (!read.etag) return fail("no_etag");
  return archiveNote(call, target.path, read.etag, target.slug);
}

/** A check-in's file name from what it says: lower-case words, at most 40 characters. */
export function slugOf(what) {
  const slug = String(what ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug === "" ? "check-in" : slug;
}

/** True only when `read_note` says the path is not found. Any other answer, an error included, counts as present. */
async function isMissing(call, path) {
  let result;
  try {
    result = await call("read_note", { path });
  } catch {
    return false;
  }
  return result?.isError === true && /^not found\b/i.test(textOf(result).trim());
}

/** Add a check-in under `tex/routines/once/`, in the person's own workspace. Never replaces a note already there. */
export async function checkinAdd(call, { when, what } = {}) {
  const at = normalizeWhen(when);
  const body = typeof what === "string" ? what.trim() : "";
  if (at === null || body === "" || body.length > MAX_BODY) return fail("invalid");
  const base = `tex/routines/once/${slugOf(body)}`;
  for (let attempt = 1; attempt <= 9; attempt += 1) {
    const path = attempt === 1 ? `${base}.md` : `${base}-${attempt}.md`;
    if (!(await isMissing(call, path))) continue;
    const content = `---\nat: ${at}\n---\n${body}\n`;
    const written = await writeNote(call, path, content, null, null);
    return written.ok ? { ok: true, id: idOf(null, path) } : written;
  }
  return fail("failed");
}

// ── About you ───────────────────────────────────────────────────────────────

async function lineHash(raw) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw.trim()));
  return [...new Uint8Array(digest).slice(0, 4)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The about items of a note, each with its stable line id (`index:hash`). */
async function aboutItems(text, now) {
  const lines = String(text ?? "").replace(/^\uFEFF/, "").split("\n");
  const start = bodyStart(lines);
  const items = [];
  for (let i = start; i < lines.length; i++) {
    const entry = itemOf(lines[i]);
    if (entry === null) continue;
    const hash = await lineHash(lines[i]);
    items.push({
      line: `${i + 1}:${hash}`,
      text: entry.text,
      source: entry.source,
      ...(entry.at === undefined ? {} : { at: entry.at }),
      isNew: entry.at !== undefined && now - entry.at >= 0 && now - entry.at < RECENT_MS,
    });
  }
  return items;
}

/** The lines of the person's about note, or of a group chat's, for the page. `total` is the count shown. */
export async function readAbout(call, { context, path } = {}, now = Date.now()) {
  if (!isAboutPath(path)) return { items: [], total: 0 };
  const read = await readNote(call, path, context);
  if (read === null) return { items: [], total: 0 };
  const items = await aboutItems(read.note, now);
  return { items, total: items.length };
}

/**
 * Rewrite one about line's text, keeping its bullet and its source marker. A
 * line id that no longer matches what is there is refused as `changed`.
 */
export async function aboutFix(call, target = {}, line, text) {
  const clean = typeof text === "string" ? text.trim() : "";
  if (clean === "" || /[\r\n]/.test(clean) || clean.length > MAX_LINE) return fail("invalid");
  // A line with no source that the person fixes on their own page is theirs now; the save dates it (`stampAboutLines`).
  const own = target?.path?.startsWith("tex/groups/") ? "" : " (you said so)";
  return editAboutLine(call, target, line, (entry) => `${entry.bullet}${clean}${entry.marker || own}`);
}

/** Remove one about line. A stale line id is refused as `changed`. */
export async function aboutRemove(call, target = {}, line) {
  return editAboutLine(call, target, line, null);
}

async function editAboutLine(call, target, line, replacement) {
  const path = target?.path;
  if (!isAboutPath(path)) return fail("not_found");
  const id = /^(\d{1,6}):([0-9a-f]{8})$/.exec(String(line ?? ""));
  if (!id) return fail("changed");
  const read = await readNote(call, path, target.context);
  if (read === null) return fail("not_found");
  if (!read.etag) return fail("no_etag");

  const lines = read.note.split("\n");
  const index = Number(id[1]) - 1;
  const current = lines[index];
  const entry = current === undefined || index < bodyStart(lines) ? null : itemOf(current);
  if (entry === null || (await lineHash(current)) !== id[2]) return fail("changed");

  if (replacement === null) lines.splice(index, 1);
  else lines[index] = replacement(entry);
  return writeNote(call, path, lines.join("\n"), read.etag, target.context);
}
