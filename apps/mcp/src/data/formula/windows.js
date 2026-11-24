/**
 * The stretch of time a metric's period means, in UTC.
 *
 * `day`, `week` (starting Monday, as ISO weeks do) and `month` are the
 * calendar period to date: from its start up to and including now. `N days`
 * is rolling: the N × 24 hours up to now. A window is
 * `{ from, to, current }` with ISO-8601 instants; a row belongs to it when
 * `from <= t < to`, or `t <= to` for the current window, which ends at now.
 */

const DAY_MS = 86_400_000;
export const MAX_ROLLING_DAYS = 366;
export const MAX_WINDOWS = 400;

/** "day" | "week" | "month" | "N days" → `{ unit }` / `{ unit: "days", days }`, or null. */
export function parseEvery(every) {
  if (typeof every !== "string") return null;
  const s = every.trim().toLowerCase();
  if (s === "day" || s === "week" || s === "month") return { unit: s };
  const parts = s.split(" ");
  if (parts.length !== 2 || (parts[1] !== "days" && parts[1] !== "day")) return null;
  const digits = parts[0];
  if (!digits || digits.length > 3 || [...digits].some((c) => c < "0" || c > "9")) return null;
  const days = Number(digits);
  return days >= 1 && days <= MAX_ROLLING_DAYS ? { unit: "days", days } : null;
}

/** A time as milliseconds: a number, a Date or an ISO string; NaN otherwise. */
export function toMs(now) {
  if (typeof now === "number") return now;
  if (now instanceof Date) return now.getTime();
  // UTC throughout: a time written without an offset is read as UTC, never as the host's local time.
  if (typeof now === "string") return Date.parse(/T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(now) ? `${now}Z` : now);
  return Number.NaN;
}

function startOf(unit, ms) {
  const d = new Date(ms);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (unit === "day") return day;
  if (unit === "week") return day - ((d.getUTCDay() + 6) % 7) * DAY_MS;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** The start of the period `back` periods before the one starting at `start`. */
function shift(unit, start, back) {
  if (unit === "day") return start - back * DAY_MS;
  if (unit === "week") return start - back * 7 * DAY_MS;
  const d = new Date(start);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1);
}

const iso = (ms) => new Date(ms).toISOString();

/** Windows in milliseconds, oldest first, the last one the current window. */
export function windowsMs(every, now, n) {
  const period = parseEvery(every);
  const at = toMs(now);
  if (!period || !Number.isFinite(at) || Math.abs(at) > 8.64e15 - 1e12 || !Number.isInteger(n) || n < 1) return [];
  const count = Math.min(n, MAX_WINDOWS);
  const out = [];
  for (let back = count - 1; back >= 0; back -= 1) {
    if (period.unit === "days") {
      const span = period.days * DAY_MS;
      out.push({ from: at - (back + 1) * span, to: at - back * span, current: back === 0 });
    } else {
      const start = startOf(period.unit, at);
      out.push({ from: shift(period.unit, start, back), to: back === 0 ? at : shift(period.unit, start, back - 1), current: back === 0 });
    }
  }
  return out;
}

/** The current window for a period: `{ from, to, current: true }`, or null for a period or time that isn't one. */
export function windowFor(every, now) {
  const [w] = windowsMs(every, now, 1);
  return w ? { from: iso(w.from), to: iso(w.to), current: true } : null;
}

/** The last `n` windows, oldest first, ending with the current one (`n` at most 400). */
export function previousWindows(every, now, n) {
  return windowsMs(every, now, n).map((w) => ({ from: iso(w.from), to: iso(w.to), current: w.current }));
}
