/** Types for `routines.cjs`; see that file for the format and the reasons. */

export type RoutineUnit = "minute" | "hour" | "day" | "week" | "month" | "once";

export interface RoutineCadence {
  unit: RoutineUnit;
  every: number;
}

export interface ClockTime {
  hour: number;
  minute: number;
}

export type RoutinePath =
  | { kind: "routine"; cadence: RoutineCadence; folder: string; name: string }
  | { kind: "unscheduled"; reason: string };

export interface RoutineSettings {
  at: ClockTime | null;
  /** Day numbers, 0 = Sunday. */
  days: number[] | null;
  /** Day of the month, -1 for the last. */
  monthDay: number | null;
  send: "text" | "note" | "both";
  /** Handles without the @, lower-cased. */
  to: string[];
  /** The group chat a shared workspace's routine answers into: 16 hex (`chatRoutineId`). */
  chat: string | null;
  /** `wake: new mail`: a chat routine also runs soon after new mail in a mailbox shared with its chat. */
  wake: "mail" | null;
  until: string | null;
  paused: boolean;
  timeZone: string | null;
  /** A one-off's day (`tex/routines/once/`, or `routines/once/`). */
  date: CivilDate | null;
  /** When a one-off ran, as the gateway wrote it; set means it never runs again. */
  done: string | null;
}

export interface CivilDate {
  year: number;
  month: number;
  day: number;
}

export const ROUTINES_FOLDER: "routines/";
export const TEX_ROUTINES_FOLDER: "tex/routines/";
export type RoutineRoot = "tex/routines/" | "routines/";
export const ROUTINE_ROOTS: readonly RoutineRoot[];
export const ROUTINE_RUNS_PREFIX: string;
export const ROUTINE_RUNS_PREFIXES: Readonly<Record<RoutineRoot, string>>;
export const MIN_INTERVAL_MINUTES: number;
export const DEFAULT_AT: Readonly<ClockTime>;

export function cadenceFromFolder(folder: string): RoutineCadence | null;
export function routineFromPath(path: string): RoutinePath | null;
export function routineRootOf(path: string): RoutineRoot | null;
export function isRoutinePath(path: unknown): boolean;
export function frontMatter(text: string): Record<string, string>;
export function parseTime(value: string): ClockTime | null;
export function parseWeekdays(value: string): number[] | null;
export function parseMonthDay(value: string): number | null;
export function parseDate(value: string): CivilDate | null;
export function parseDateTime(value: string): { date: CivilDate; time: ClockTime | null } | null;
export function routineSettings(
  text: string,
  cadence: RoutineCadence | null,
): { settings: RoutineSettings; problems: string[] };
export function nextRunAt(
  cadence: RoutineCadence,
  settings: Partial<RoutineSettings> | null,
  timeZone: string,
  afterMs: number,
): number | null;
export function chatRoutineId(groupKey: string): string | null;
export function describeSchedule(cadence: RoutineCadence, settings: Partial<RoutineSettings> | null): string;
export function routineRunsKey(path: string): string;
export function wallClock(
  ms: number,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number; weekday: number };
