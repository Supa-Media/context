/**
 * Routines, the control plane's half: the pure parts.
 *
 * The format is read by one module, `packages/shared/src/routines.cjs`, which
 * the gateway imports too, so "when does this run" has one answer. Nothing in
 * this file reads a clock or a database; see `docs/decisions/routines.md`.
 */

import {
  nextRunAt as nextRunOf,
  routineFromPath,
  routineSettings,
  type RoutineCadence,
} from "@context/shared/src/routines.cjs";

/** Where a person's routines live. Matched case-insensitively, like the shared module. */
export const ROUTINES_ROOT = "routines";

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

/** Outcomes that mean the row no longer describes the file: re-read the folder. */
export const RECONCILE_OUTCOMES: ReadonlySet<string> = new Set([
  "routine_gone",
  "not_a_routine",
  "paused",
]);

export function isRoutineOutcome(value: unknown): value is RoutineOutcome {
  return typeof value === "string" && (ROUTINE_OUTCOMES as readonly string[]).includes(value);
}

/** Whether a path is `routines/` or anything under it (scheduled or not). */
export function isUnderRoutines(path: string): boolean {
  const normalized = path.replace(/^\/+/, "").replace(/\/+$/, "").toLowerCase();
  return normalized === ROUTINES_ROOT || normalized.startsWith(`${ROUTINES_ROOT}/`);
}

/** The schedule a routine file carries, as stored. No body, no `until`, no problems. */
export interface RoutineSchedule {
  path: string;
  cadence: RoutineCadence;
  at?: { hour: number; minute: number };
  days?: number[];
  monthDay?: number;
  timeZone?: string;
  paused: boolean;
  send: "text" | "note" | "both";
  to: string[];
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
    ...(settings.timeZone === null ? {} : { timeZone: settings.timeZone }),
    paused: settings.paused,
    send: settings.send,
    to: settings.to.slice(0, 20),
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
  schedule: Pick<RoutineSchedule, "cadence" | "at" | "days" | "monthDay" | "paused">,
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
