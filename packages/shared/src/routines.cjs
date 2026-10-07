/**
 * Routines: notes that run on a schedule.
 *
 * A routine is one Markdown note at `routines/<how-often>/<name>.md`. The
 * folder says how often it runs, the body says what to do in plain words, and a
 * few optional front matter lines fine-tune it. Adding the file starts it,
 * deleting it stops it, and moving it to another folder changes how often it
 * runs. Decided by the owner, 2026-10-07; see `docs/decisions/routines.md`.
 *
 * This file is the one reading of that format. The gateway, the control plane
 * and the app all import it, so "when does this run" has one answer. It is
 * CommonJS for the same reason as `storageLayout.cjs`: the gateway is plain
 * JavaScript and cannot import this package's TypeScript.
 *
 * Nothing here reads a clock or a bucket. Every function takes what it needs.
 */

const ROUTINES_FOLDER = "routines/";

/** The fastest a routine may run. Anything faster is refused, not rounded. */
const MIN_INTERVAL_MINUTES = 5;

/** Where a run's history is kept: Context's own space in the person's bucket. */
const ROUTINE_RUNS_PREFIX = ".context/agent/routines/";

/** When a daily-or-slower routine runs if its file names no time. */
const DEFAULT_AT = Object.freeze({ hour: 8, minute: 0 });

const UNITS = Object.freeze(["minute", "hour", "day", "week", "month"]);

const NAMED_FOLDERS = Object.freeze({
  hourly: { unit: "hour", every: 1 },
  daily: { unit: "day", every: 1 },
  weekly: { unit: "week", every: 1 },
  biweekly: { unit: "week", every: 2 },
  "bi-weekly": { unit: "week", every: 2 },
  fortnightly: { unit: "week", every: 2 },
  monthly: { unit: "month", every: 1 },
  quarterly: { unit: "month", every: 3 },
  yearly: { unit: "month", every: 12 },
});

const WEEKDAYS = Object.freeze(["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]);

/**
 * How often a folder name means, or null when it means nothing.
 * `every-5-minutes`, `every-3-hours`, `every-2-weeks`, `every-day`, `hourly`…
 */
function cadenceFromFolder(folder) {
  const name = String(folder).trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(NAMED_FOLDERS, name)) return { ...NAMED_FOLDERS[name] };
  const match = /^every-(?:(\d{1,3})-)?(minute|hour|day|week|month)s?$/.exec(name);
  if (!match) return null;
  const every = match[1] === undefined ? 1 : Number(match[1]);
  if (!Number.isInteger(every) || every < 1) return null;
  const unit = match[2];
  if (unit === "minute" && every < MIN_INTERVAL_MINUTES) return null;
  return { unit, every };
}

/**
 * Whether `path` is a routine, and how often it runs.
 *
 * - `{ kind: "routine", cadence, folder, name }` for `routines/<folder>/<name>.md`
 *   whose folder means a schedule.
 * - `{ kind: "unscheduled", reason }` for a note under `routines/` that will
 *   never run, with the reason in words a person can act on.
 * - `null` for anything outside `routines/`.
 */
function routineFromPath(path) {
  if (typeof path !== "string") return null;
  if (path.slice(0, ROUTINES_FOLDER.length).toLowerCase() !== ROUTINES_FOLDER) return null;
  if (!/\.md$/i.test(path)) return null;
  const rest = path.slice(ROUTINES_FOLDER.length).split("/");
  if (rest.length === 1) {
    return {
      kind: "unscheduled",
      reason: "Put it in a folder that says how often, like routines/daily/.",
    };
  }
  if (rest.length > 2) {
    return {
      kind: "unscheduled",
      reason: `Only notes directly inside routines/${rest[0]}/ run.`,
    };
  }
  const cadence = cadenceFromFolder(rest[0]);
  if (!cadence) {
    const tooFast = /^every-(\d+)-minutes?$/i.exec(rest[0]);
    return {
      kind: "unscheduled",
      reason: tooFast
        ? `The fastest a routine can run is every ${MIN_INTERVAL_MINUTES} minutes.`
        : `"${rest[0]}" isn't a schedule. Use hourly, daily, weekly, monthly or a name like every-3-hours.`,
    };
  }
  return { kind: "routine", cadence, folder: rest[0], name: rest[1].replace(/\.md$/i, "") };
}

/** The `key: value` lines of a note's leading front matter, keys lower-cased. */
function frontMatter(text) {
  const out = {};
  if (typeof text !== "string") return out;
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0] === undefined || lines[0].trim() !== "---") return out;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "---" || line.trim() === "...") return out;
    const match = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    out[match[1].toLowerCase()] = unquote(match[2].trim());
  }
  // No closing line: it was never front matter.
  return {};
}

function unquote(value) {
  const m = /^(["'])(.*)\1$/.exec(value);
  return m ? m[2] : value;
}

/** `7:30 am`, `7am`, `19:00`, `noon`, `midnight` → `{ hour, minute }`, or null. */
function parseTime(value) {
  const text = String(value).trim().toLowerCase().replace(/\./g, "");
  if (text === "noon") return { hour: 12, minute: 0 };
  if (text === "midnight") return { hour: 0, minute: 0 };
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(text);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  const half = match[3];
  if (minute > 59) return null;
  if (half) {
    if (hour < 1 || hour > 12) return null;
    if (half === "am") hour = hour === 12 ? 0 : hour;
    else hour = hour === 12 ? 12 : hour + 12;
  } else if (match[2] === undefined) {
    // A bare "7" is ambiguous between a time and a minute; ask for words.
    return null;
  }
  if (hour > 23) return null;
  return { hour, minute };
}

/** `weekdays`, `weekends`, `friday`, `mon, wed`, `every day` → sorted day numbers (0 = Sunday). */
function parseWeekdays(value) {
  const text = String(value).trim().toLowerCase();
  if (text === "weekdays" || text === "weekday") return [1, 2, 3, 4, 5];
  if (text === "weekends" || text === "weekend") return [0, 6];
  if (text === "every day" || text === "everyday" || text === "daily") return [0, 1, 2, 3, 4, 5, 6];
  const days = new Set();
  for (const raw of text.split(/\s*(?:,|\band\b|&)\s*/)) {
    const word = raw.trim().replace(/s$/, "");
    if (word === "") continue;
    const index = WEEKDAYS.findIndex((day) => day === word || (word.length >= 3 && day.startsWith(word)));
    if (index === -1) return null;
    days.add(index);
  }
  return days.size === 0 ? null : [...days].sort((a, b) => a - b);
}

/** `1`, `1st`, `15th`, `last` → a day of the month (`-1` for the last), or null. */
function parseMonthDay(value) {
  const text = String(value).trim().toLowerCase().replace(/^the\s+/, "");
  if (text === "last" || text === "last day") return -1;
  const match = /^(\d{1,2})(?:st|nd|rd|th)?$/.exec(text);
  if (!match) return null;
  const day = Number(match[1]);
  return day >= 1 && day <= 31 ? day : null;
}

function isTimeZone(value) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const YES = new Set(["yes", "true", "on", "y"]);
const NO = new Set(["no", "false", "off", "n", ""]);

/**
 * The optional lines of a routine note, read against its cadence.
 *
 * Returns `{ settings, problems }`. A line that is not understood is a problem
 * with a sentence saying how to fix it; it never silently becomes a default,
 * because a routine that quietly runs at the wrong time is worse than one that
 * says it can't read its own time.
 */
function routineSettings(text, cadence) {
  const fields = frontMatter(text);
  const problems = [];
  const settings = {
    at: null,
    days: null,
    monthDay: null,
    send: "text",
    to: [],
    until: null,
    paused: false,
    timeZone: null,
  };

  if (fields.at !== undefined && fields.at !== "") {
    const at = parseTime(fields.at);
    if (at) settings.at = at;
    else problems.push(`"at: ${fields.at}" isn't a time. Write it like 7:30 am or 19:00.`);
  }
  if (fields.on !== undefined && fields.on !== "") {
    if (cadence && cadence.unit === "month") {
      const day = parseMonthDay(fields.on);
      if (day !== null) settings.monthDay = day;
      else problems.push(`"on: ${fields.on}" isn't a day of the month. Write it like 1st, 15 or last.`);
    } else if (cadence && cadence.unit === "minute") {
      problems.push(`"on:" doesn't apply to a routine that runs every few minutes.`);
    } else {
      const days = parseWeekdays(fields.on);
      if (days) settings.days = days;
      else problems.push(`"on: ${fields.on}" isn't a day. Write it like friday, weekdays or mon, wed.`);
    }
  }
  if (fields.send !== undefined && fields.send !== "") {
    const send = fields.send.toLowerCase();
    if (send === "text" || send === "note" || send === "both") settings.send = send;
    else problems.push(`"send: ${fields.send}" should be text, note or both.`);
  }
  if (fields.to !== undefined && fields.to !== "") {
    const handles = fields.to
      .replace(/^\[|\]$/g, "")
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((handle) => handle.replace(/^@/, "").toLowerCase());
    if (handles.every((handle) => /^[a-z0-9][a-z0-9_-]{0,38}$/.test(handle))) settings.to = handles;
    else problems.push(`"to: ${fields.to}" should list people as @handles.`);
  }
  if (fields.until !== undefined && fields.until !== "") settings.until = fields.until;
  if (fields.paused !== undefined) {
    const paused = fields.paused.toLowerCase();
    if (YES.has(paused)) settings.paused = true;
    else if (!NO.has(paused)) problems.push(`"paused: ${fields.paused}" should be yes or no.`);
  }
  const zone = fields.timezone ?? fields["time-zone"] ?? fields.tz;
  if (zone !== undefined && zone !== "") {
    if (isTimeZone(zone)) settings.timeZone = zone;
    else problems.push(`"timezone: ${zone}" isn't a time zone. Write it like America/New_York.`);
  }
  if (cadence && cadence.unit === "minute" && settings.at) {
    problems.push(`"at:" doesn't apply to a routine that runs every few minutes.`);
    settings.at = null;
  }
  return { settings, problems };
}

// ── Time ────────────────────────────────────────────────────────────────────

const partsFormatters = new Map();

function formatterFor(timeZone) {
  let formatter = partsFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    partsFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The wall clock in `timeZone` at instant `ms`. */
function wallClock(ms, timeZone) {
  const parts = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(ms))) parts[part.type] = part.value;
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  return {
    year,
    month,
    day,
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

function offsetAt(ms, timeZone) {
  const w = wallClock(ms, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  return asUtc - Math.floor(ms / 60000) * 60000;
}

/**
 * The instant a wall-clock time happens in `timeZone`. A time skipped by a
 * daylight-saving jump lands just after the jump.
 */
function instantOf(year, month, day, hour, minute, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let instant = guess - offsetAt(guess, timeZone);
  const second = guess - offsetAt(instant, timeZone);
  if (second !== instant) instant = Math.max(instant, second);
  return instant;
}

const DAY_MS = 86400000;

/** Whole days from 1970-01-01 to a civil date. */
function dayNumber(year, month, day) {
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * When a routine next runs, strictly after `afterMs`, or null if never.
 *
 * Intervals of more than one unit count from a fixed epoch, never from when
 * the file was written, so the answer does not change when a file is re-saved:
 * - every N minutes: minute marks divisible by N since 1970 (UTC);
 * - every N hours: local hours divisible by N, at the `at` minute (default :00);
 * - every N days: local days since 1970 divisible by N;
 * - every N weeks: weeks since Monday 1970-01-05 divisible by N;
 * - every N months: months since January 1970 divisible by N.
 */
function nextRunAt(cadence, settings, timeZone, afterMs) {
  if (!cadence || !UNITS.includes(cadence.unit)) return null;
  const every = cadence.every || 1;
  const zone = (settings && settings.timeZone) || timeZone || "UTC";
  const at = (settings && settings.at) || DEFAULT_AT;
  const days = settings && settings.days;

  if (cadence.unit === "minute") {
    const step = every * 60000;
    return Math.floor(afterMs / step) * step + step;
  }

  if (cadence.unit === "hour") {
    const minute = settings && settings.at ? settings.at.minute : 0;
    const start = Math.floor(afterMs / 3600000) * 3600000 - 3600000;
    for (let i = 0; i < 24 * 8 * every + 48; i++) {
      const w = wallClock(start + i * 3600000, zone);
      if (w.hour % every !== 0) continue;
      if (days && !days.includes(w.weekday)) continue;
      const candidate = instantOf(w.year, w.month, w.day, w.hour, minute, zone);
      if (candidate > afterMs) return candidate;
    }
    return null;
  }

  const today = wallClock(afterMs, zone);
  const first = dayNumber(today.year, today.month, today.day) - 1;
  const horizon = cadence.unit === "month" ? 31 * 13 * every : 8 * 7 * every + 8;
  for (let i = 0; i < horizon; i++) {
    const date = new Date((first + i) * DAY_MS);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    const weekday = date.getUTCDay();
    const n = first + i;

    if (cadence.unit === "day") {
      if (n % every !== 0) continue;
      if (days && !days.includes(weekday)) continue;
    } else if (cadence.unit === "week") {
      const wanted = days || [1];
      if (!wanted.includes(weekday)) continue;
      // 1970-01-05 was a Monday: day number 4.
      const week = Math.floor((n - 4) / 7);
      if (((week % every) + every) % every !== 0) continue;
    } else if (cadence.unit === "month") {
      const monthIndex = (year - 1970) * 12 + (month - 1);
      if (monthIndex % every !== 0) continue;
      const wantedDay = settings && settings.monthDay !== null && settings.monthDay !== undefined ? settings.monthDay : 1;
      const last = daysInMonth(year, month);
      const target = wantedDay === -1 ? last : Math.min(wantedDay, last);
      if (day !== target) continue;
    }
    const candidate = instantOf(year, month, day, at.hour, at.minute, zone);
    if (candidate > afterMs) return candidate;
  }
  return null;
}

// ── Words ───────────────────────────────────────────────────────────────────

function clock(at) {
  const hour = at.hour % 12 === 0 ? 12 : at.hour % 12;
  const minute = at.minute === 0 ? "" : `:${String(at.minute).padStart(2, "0")}`;
  return `${hour}${minute} ${at.hour < 12 ? "am" : "pm"}`;
}

function dayList(days) {
  const key = days.join(",");
  if (key === "1,2,3,4,5") return "weekdays";
  if (key === "0,6") return "weekends";
  if (key === "0,1,2,3,4,5,6") return "every day";
  const names = days.map((d) => WEEKDAYS[d][0].toUpperCase() + WEEKDAYS[d].slice(1, 3));
  return names.length === 1 ? `${WEEKDAYS[days[0]][0].toUpperCase()}${WEEKDAYS[days[0]].slice(1)}s` : names.join(", ");
}

function ordinal(n) {
  if (n === -1) return "last day";
  const rem = n % 100;
  if (rem >= 11 && rem <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] || "th"}`;
}

/** "Every day at 7:30 am", "Weekdays at 9 am", "Every 5 minutes", "Fridays at 4 pm". */
function describeSchedule(cadence, settings) {
  const at = (settings && settings.at) || DEFAULT_AT;
  const days = settings && settings.days;
  const every = cadence.every || 1;
  switch (cadence.unit) {
    case "minute":
      return `Every ${every} minutes`;
    case "hour": {
      const base = every === 1 ? "Every hour" : `Every ${every} hours`;
      const minute = settings && settings.at ? settings.at.minute : 0;
      const tail = minute === 0 ? "" : ` at :${String(minute).padStart(2, "0")}`;
      return `${base}${tail}${days ? `, ${dayList(days)}` : ""}`;
    }
    case "day":
      if (every === 1) {
        if (days && days.length < 7) {
          const words = dayList(days);
          return `${words[0].toUpperCase()}${words.slice(1)} at ${clock(at)}`;
        }
        return `Every day at ${clock(at)}`;
      }
      return `Every ${every} days at ${clock(at)}`;
    case "week": {
      const words = dayList(days || [1]);
      const lead = every === 1 ? `${words[0].toUpperCase()}${words.slice(1)}` : `Every ${every} weeks on ${words}`;
      return `${lead} at ${clock(at)}`;
    }
    case "month": {
      const day = settings && settings.monthDay !== null && settings.monthDay !== undefined ? settings.monthDay : 1;
      const lead = every === 1 ? "Monthly" : every === 12 ? "Yearly" : `Every ${every} months`;
      return `${lead} on the ${ordinal(day)} at ${clock(at)}`;
    }
    default:
      return "";
  }
}

/** The run history file for a routine at `path`. */
function routineRunsKey(path) {
  return `${ROUTINE_RUNS_PREFIX}${path.slice(ROUTINES_FOLDER.length).replace(/\.md$/i, "")}.json`;
}

module.exports = {
  ROUTINES_FOLDER,
  ROUTINE_RUNS_PREFIX,
  MIN_INTERVAL_MINUTES,
  DEFAULT_AT,
  cadenceFromFolder,
  routineFromPath,
  frontMatter,
  parseTime,
  parseWeekdays,
  parseMonthDay,
  routineSettings,
  nextRunAt,
  describeSchedule,
  routineRunsKey,
  wallClock,
};
