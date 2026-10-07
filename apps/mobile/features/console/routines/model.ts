/**
 * What a routine note shows about itself: the run bar's words, the recent
 * runs' words, and the one edit the bar makes to the file.
 *
 * Pure, so every state the bar can be in is a test rather than a screenshot.
 * The schedule is read from the note's own text through the one module that
 * reads the format (`packages/shared/src/routines.cjs`), so it changes as
 * somebody types and agrees with what the control plane will run. The last
 * run comes from the control plane's row, which keeps only a time and a code.
 * See `docs/decisions/routines.md`.
 */

import {
  describeSchedule,
  routineFromPath,
  routineSettings,
} from "@context/shared/src/routines.cjs";
import { relativeTime } from "../format";
import { changeProperty } from "../files/noteEditor/propertyEdit";

/** The parts of `routineForNote`'s answer the note draws. */
export interface RoutineRow {
  paused: boolean;
  send: "text" | "note" | "both";
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastOutcome: string | null;
}

/** One run from the history file, as `routineRuns` hands it back. */
export interface RoutineRun {
  at: number;
  outcome: string;
  text: string;
}

export type LastRunMark = "ok" | "failed" | null;

export type RoutineBarView =
  /** Not under `routines/`: nothing is drawn. */
  | { kind: "none" }
  /** Under `routines/` but will never run: one quiet line saying why. */
  | { kind: "unscheduled"; line: string }
  | {
      kind: "bar";
      /** "Every day at 7:30 am". */
      schedule: string;
      /** "Last ran 2 hours ago", "Not run yet", "Paused", or why it stopped. */
      last: string;
      mark: LastRunMark;
      /** The file says `paused: yes`. */
      paused: boolean;
      /** Run now does something: a scheduled row, not paused, not stopped. */
      canRun: boolean;
      /** The sentences `routineSettings` returns for lines it can't read. */
      problems: string[];
    };

/** The codes that mean the run did what it was asked. Everything else is a failure of some kind. */
const WENT_WELL = new Set(["answered", "skipped", "finished"]);

export const WRITER_GONE_WORDS = "Stopped: the writer can't edit here any more";

/**
 * The bar for the note at `path` with this text.
 *
 * `row` is `undefined` while the control plane has not answered, and `null`
 * when it has no row for this note yet (just written, not scanned).
 */
export function routineBarView(options: {
  path: string | null;
  text: string;
  row: RoutineRow | null | undefined;
  now: number;
}): RoutineBarView {
  const found = options.path === null ? null : routineFromPath(options.path);
  if (found === null) return { kind: "none" };
  if (found.kind === "unscheduled") return { kind: "unscheduled", line: found.reason };
  const { settings, problems } = routineSettings(options.text, found.cadence);
  const row = options.row;
  const stopped = row?.lastOutcome === "writer_gone";
  let last: string;
  let mark: LastRunMark = null;
  if (stopped) {
    last = WRITER_GONE_WORDS;
    mark = "failed";
  } else if (settings.paused) {
    last = "Paused";
  } else if (row === undefined) {
    last = "";
  } else if (row === null || row.lastRunAt === null) {
    last = "Not run yet";
  } else {
    last = `Last ran ${relativeTime(row.lastRunAt, options.now)}`;
    mark = row.lastOutcome === null ? null : WENT_WELL.has(row.lastOutcome) ? "ok" : "failed";
  }
  return {
    kind: "bar",
    schedule: describeSchedule(found.cadence, settings),
    last,
    mark,
    paused: settings.paused,
    canRun:
      !settings.paused && !stopped && row !== undefined && row !== null && !row.paused && row.nextRunAt !== null,
    problems,
  };
}

/** One run in words: what happened, and the line under it when there is no text to show. */
export function runWords(run: RoutineRun, send: RoutineRow["send"] = "text"): { label: string; detail: string | null } {
  switch (run.outcome) {
    case "answered":
      return { label: send === "note" ? "Answered" : "Texted", detail: null };
    case "skipped":
      return { label: "Skipped", detail: "Nothing worth saying, so no text." };
    case "finished":
      return { label: "Finished", detail: null };
    case "failed":
      return { label: "Failed", detail: "Something went wrong on this run." };
    case "paused":
      return { label: "Paused", detail: null };
    case "routine_gone":
      return { label: "Didn't run", detail: "The note had moved or couldn't be read." };
    case "not_a_routine":
      return { label: "Didn't run", detail: "The note wasn't in a schedule folder." };
    case "daily_limit":
      return { label: "Didn't run", detail: "Today's limit was reached." };
    case "no_provider":
      return { label: "Didn't run", detail: "No AI is set up for this workspace." };
    case "no_chat":
      return { label: "Not texted", detail: "Nobody to text yet. Text the assistant first." };
    case "writer_gone":
      return { label: "Stopped", detail: "The writer can't edit here any more." };
    default:
      return { label: "Didn't run", detail: null };
  }
}

const DAY = 24 * 60 * 60 * 1000;

function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** "Today, 7:30 am", "Yesterday, 7:30 am", "Sunday, 7:30 am", "3 Oct, 7:30 am", in this device's time. */
export function runWhen(at: number, now: number): string {
  const date = new Date(at);
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const clock = `${hours % 12 === 0 ? 12 : hours % 12}:${String(minutes).padStart(2, "0")} ${hours < 12 ? "am" : "pm"}`;
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY);
  let day: string;
  if (days <= 0) day = "Today";
  else if (days === 1) day = "Yesterday";
  else if (days < 7) day = date.toLocaleDateString("en-US", { weekday: "long" });
  else day = `${date.getDate()} ${date.toLocaleDateString("en-US", { month: "short" })}`;
  return `${day}, ${clock}`;
}

/**
 * The note with `paused: yes` added, or with its `paused:` line removed.
 *
 * Through `changeProperty`, the same one-line front matter write the
 * Properties panel uses, so every other line of the file stays as it was and
 * a note with no front matter yet gets a block holding just this line.
 */
export function pauseEdit(source: string, pause: boolean): { text: string } | { error: string } {
  const changed = changeProperty(source, "paused", pause ? "yes" : null);
  if (!pause || "error" in changed) return changed;
  return { text: unquotedYes(changed.text) };
}

/**
 * `paused: "yes"` as `paused: yes`, the way the routine format writes it.
 *
 * The shared writer quotes a bare `yes` because YAML 1.1 would read it as a
 * boolean, and every reader here takes it as the word either way. The routine
 * format's own spelling is the bare word (and it is what somebody reading the
 * file in Obsidian expects), so the one line the writer just wrote is put
 * back in that spelling. Only that line: the last `paused:` line inside the
 * front matter, and only when it is exactly the quoted form.
 */
function unquotedYes(text: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const close = lines.findIndex((line, i) => i > 0 && /^---\s*$/.test(line));
  for (let i = close - 1; i > 0; i--) {
    if (/^paused\s*:/.test(lines[i]!)) {
      if (lines[i] === 'paused: "yes"') lines[i] = "paused: yes";
      break;
    }
  }
  return lines.join(eol);
}
