/** Types for `routines.cjs`; see that file for the format and the reasons. */

export type RoutineUnit = "minute" | "hour" | "day" | "week" | "month";

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
  until: string | null;
  paused: boolean;
  timeZone: string | null;
}

export const ROUTINES_FOLDER: "routines/";
export const ROUTINE_RUNS_PREFIX: string;
export const MIN_INTERVAL_MINUTES: number;
export const DEFAULT_AT: Readonly<ClockTime>;

export function cadenceFromFolder(folder: string): RoutineCadence | null;
export function routineFromPath(path: string): RoutinePath | null;
export function frontMatter(text: string): Record<string, string>;
export function parseTime(value: string): ClockTime | null;
export function parseWeekdays(value: string): number[] | null;
export function parseMonthDay(value: string): number | null;
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
export function describeSchedule(cadence: RoutineCadence, settings: Partial<RoutineSettings> | null): string;
export function routineRunsKey(path: string): string;
export function wallClock(
  ms: number,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number; weekday: number };
