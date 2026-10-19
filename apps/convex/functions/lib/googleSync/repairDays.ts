/**
 * The owner's one-time window repair of Gmail days (`functions/gmailDayRepair.ts`),
 * as dates: which days a row owes, how many one pass rebuilds, and what is
 * left after a pass that finished.
 */

/** Days one forward pass rebuilds besides today and yesterday: a pass stays a pass. */
export const REPAIR_DAYS_PER_PASS = 4;
/** The furthest back the repair reaches; the inbox keeps three calendar months. */
export const REPAIR_MAX_DAYS = 62;

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Every UTC day from `since` to the day before yesterday, oldest first; today
 * and yesterday are rebuilt by every pass already. Null for a date that is not
 * one, is in the future, or is further back than `REPAIR_MAX_DAYS`.
 */
export function repairDaysSince(since: string, now: number): string[] | null {
  if (!DATE.test(since)) return null;
  const start = Date.parse(`${since}T00:00:00.000Z`);
  if (Number.isNaN(start) || new Date(start).toISOString().slice(0, 10) !== since) return null;
  const today = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00.000Z`);
  if (start > today || today - start > REPAIR_MAX_DAYS * DAY_MS) return null;
  const days: string[] = [];
  for (let at = start; at <= today - 2 * DAY_MS; at += DAY_MS) days.push(new Date(at).toISOString().slice(0, 10));
  return days;
}

/** What a row still owes after a finished pass rebuilt `rebuilt`; undefined when nothing is. */
export function remainingRepairDays(owed: string[] | undefined, rebuilt: string[] | undefined): string[] | undefined {
  if (owed === undefined) return undefined;
  const done = new Set(rebuilt ?? []);
  const left = owed.filter((day) => !done.has(day));
  return left.length > 0 ? left : undefined;
}
