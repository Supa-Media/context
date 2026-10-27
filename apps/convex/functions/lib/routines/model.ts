/**
 * Routines, the control plane's half: the pure parts.
 *
 * The format is read by one module, `packages/shared/src/routines.cjs`, which
 * the gateway imports too, so "when does this run" has one answer. Nothing in
 * this file reads a clock or a database; see `docs/decisions/routines.md`.
 */

import {
  ROUTINES_FOLDER,
  TEX_ROUTINES_FOLDER,
  isRoutinePath,
  nextRunAt as nextRunOf,
  routineFromPath,
  routineSettings,
  type RoutineCadence,
} from "@context/shared/src/routines.cjs";
import { TEX_FOLDER } from "@context/shared/src/folderRoles.cjs";

/**
 * The folders a scan lists, both of them every time (the owner, 2026-10-14):
 * `routines/`, where routines lived first and keep running, then
 * `tex/routines/`, where new ones go. The old root first, so a workspace at
 * `MAX_ROUTINES_PER_WORKSPACE` keeps the routines it already had running and a
 * new one past the cap is the one left out.
 */
export const ROUTINE_SCAN_ROOTS: readonly string[] = [ROUTINES_FOLDER, TEX_ROUTINES_FOLDER].map((root) =>
  root.replace(/\/$/, ""),
);

/** The zone a routine runs in when neither its file nor its writer names one. */
export const DEFAULT_ROUTINE_TIME_ZONE = "America/New_York";

/** The routine runner's first-party client. The gateway decides by it (`apps/mcp/src/agent/routine.js`). */
export const ROUTINES_CLIENT_ID = "context_routines";
export const ROUTINES_CLIENT_NAME = "Routines";

/**
 * How long a handed-out run holds its row, and how long its grant lives. The
 * same number on purpose: a run whose lease has lapsed holds no live token, so
 * minting the next one for the same writer can never cut a turn off mid-way.
 */
export const ROUTINE_LEASE_MS = 15 * 60 * 1000;
export const ROUTINE_GRANT_TTL_MS = ROUTINE_LEASE_MS;

/** Most runs one `/agent-texts/routines/due` call hands out. */
export const MAX_DUE_RUNS = 20;

/** How long after its time a failed one-off is still tried again, and how often. */
export const ONE_OFF_RETRY_MS = 30 * 60 * 1000;
export const ONE_OFF_RETRY_EVERY_MS = 5 * 60 * 1000;

/** Most routines one workspace keeps rows for; the scan refuses past it. */
export const MAX_ROUTINES_PER_WORKSPACE = 200;

/** Most paths one signal may name, and their longest. */
export const MAX_SIGNAL_PATHS = 50;
export const MAX_PATH_LENGTH = 512;

/** How long a burst of saves waits before its one scan. */
export const RECONCILE_AFTER_SIGNAL_MS = 5_000;

/** A pending reconcile older than this is assumed lost and scheduled again. */
export const RECONCILE_STALE_MS = 10 * 60 * 1000;

/**
 * What a run may report. A closed list of codes, never a sentence: whatever
 * a routine answered is note-derived text and stays in the person's bucket.
 */
export const ROUTINE_OUTCOMES = [
  "answered",
  "skipped",
  "finished",
  "failed",
  "paused",
  "routine_gone",
  "not_a_routine",
  "daily_limit",
  "no_provider",
  "no_chat",
] as const;
export type RoutineOutcome = (typeof ROUTINE_OUTCOMES)[number];

/** Set by the control plane itself when the writer can no longer write here. */
export const WRITER_GONE = "writer_gone";

/**
 * Set by the control plane itself on a shared workspace's routine that nobody
 * was seen writing: it waits, not running, until someone who can write saves
 * it. Only a personal workspace falls back to its owner.
 */
export const WRITER_UNKNOWN = "writer_unknown";

/** Outcomes that mean the row no longer describes the file: re-read the folder. */
export const RECONCILE_OUTCOMES: ReadonlySet<string> = new Set([
  "routine_gone",
  "not_a_routine",
  "paused",
]);

export function isRoutineOutcome(value: unknown): value is RoutineOutcome {
  return typeof value === "string" && (ROUTINE_OUTCOMES as readonly string[]).includes(value);
}

/**
 * Whether a path is a routine root, the folder holding one (`tex`, whose move
 * or deletion takes `tex/routines/` with it), or anything under a root,
 * scheduled or not. The shared module's answer, so the gateway's signal and
 * this agree. Case-insensitive, like the shared module.
 */
export function isUnderRoutines(path: string): boolean {
  return isRoutinePath(path);
}

/**
 * `path` as a routine row names it: under `tex/`, wherever the folder doing
 * Tex's job (`texPath`) now sits (owner, 2026-10-18; Tex's folder may be
 * nested). Rows keep the default name because every reader of a `tex/` path
 * is carried to the real folder (`canonicalJobPath`), so a later move of
 * Tex's folder leaves them right. Any other path is returned as it is.
 */
export function asTexPath(path: string, texPath: string | null | undefined): string {
  if (typeof texPath !== "string" || texPath === "" || texPath === TEX_FOLDER) return path;
  if (path === texPath) return TEX_FOLDER;
  return path.startsWith(`${texPath}/`) ? `${TEX_FOLDER}/${path.slice(texPath.length + 1)}` : path;
}

/** The schedule a routine file carries, as stored. No body, no `until`, no problems. */
export interface RoutineSchedule {
  path: string;
  cadence: RoutineCadence;
  at?: { hour: number; minute: number };
  days?: number[];
  monthDay?: number;
  /** A one-off's day. */
  date?: { year: number; month: number; day: number };
  timeZone?: string;
  paused: boolean;
  send: "text" | "note" | "both";
  to: string[];
  /** A shared workspace's routine: the group chat it answers into (`chat:`, 16 hex). */
  chat?: string;
}

/**
 * Read one routine file into the fields the control plane keeps, or `null`
 * when the path is not a schedulable routine. The text is read and dropped
 * here; nothing returned quotes it.
 */
export function scheduleFromNote(path: string, text: string): RoutineSchedule | null {
  const found = routineFromPath(path);
  if (found === null || found.kind !== "routine") return null;
  const { settings } = routineSettings(text, found.cadence);
  return {
    path,
    cadence: { unit: found.cadence.unit, every: found.cadence.every },
    ...(settings.at === null ? {} : { at: { hour: settings.at.hour, minute: settings.at.minute } }),
    ...(settings.days === null ? {} : { days: [...settings.days] }),
    ...(settings.monthDay === null ? {} : { monthDay: settings.monthDay }),
    ...(settings.date === null ? {} : { date: { year: settings.date.year, month: settings.date.month, day: settings.date.day } }),
    ...(settings.timeZone === null ? {} : { timeZone: settings.timeZone }),
    paused: settings.paused,
    send: settings.send,
    to: settings.to.slice(0, 20),
    ...(settings.chat === null ? {} : { chat: settings.chat }),
  };
}

export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** The file's zone, else the writer's, else the default. */
export function effectiveTimeZone(fileZone: string | undefined, accountZone: string | null): string {
  if (fileZone !== undefined && isTimeZone(fileZone)) return fileZone;
  if (accountZone !== null && isTimeZone(accountZone)) return accountZone;
  return DEFAULT_ROUTINE_TIME_ZONE;
}

/** When a stored schedule next runs after `afterMs`, or null if paused or never. */
export function nextRunFor(
  schedule: Pick<RoutineSchedule, "cadence" | "at" | "days" | "monthDay" | "date" | "paused">,
  timeZone: string,
  afterMs: number,
): number | null {
  if (schedule.paused) return null;
  try {
    return nextRunOf(
      schedule.cadence,
      {
        at: schedule.at ?? null,
        days: schedule.days ?? null,
        monthDay: schedule.monthDay ?? null,
        date: schedule.date ?? null,
        timeZone,
      },
      timeZone,
      afterMs,
    );
  } catch {
    // An unusable zone is a routine that cannot say when it runs; it waits
    // rather than running at a guessed time.
    return null;
  }
}

/**
 * The front matter a routine's schedule is read from, rebuilt from the props
 * its tree row holds (`tree/props.js`), in the lines `routineSettings` reads:
 * a list is written back as the flow list it was most likely written as.
 * `""` for a note with none, or one whose props are sealed.
 */
export function frontMatterFromProps(props: string | null): string {
  if (props === null) return "";
  let properties: unknown;
  try {
    properties = (JSON.parse(props) as { properties?: unknown }).properties;
  } catch {
    return "";
  }
  if (properties === null || typeof properties !== "object" || Array.isArray(properties)) return "";
  const lines = Object.entries(properties as Record<string, unknown>).map(
    ([key, value]) => `${key}: ${Array.isArray(value) ? `[${value.map(String).join(", ")}]` : String(value)}`,
  );
  return lines.length === 0 ? "" : `---\n${lines.join("\n")}\n---\n`;
}
