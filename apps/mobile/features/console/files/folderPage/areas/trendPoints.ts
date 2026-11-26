/**
 * What hovering a point on an area's trend says: its value and its date (the
 * owner, 2026-11-26: "when hovering over the timeline we should see the value
 * and the date"). One per number the trend draws, in the same order.
 *
 * Pure, so every date's words are tested without drawing anything.
 */

export interface TrendPoint {
  /** As shown: "5", "$1,121", "2.4 days". */
  readonly value: string;
  /** "Nov 24", "Nov 18 – Nov 24", "Nov 24, 3 PM"; "" when nothing says when. */
  readonly date: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY = 86_400_000;

function day(at: Date): string {
  return `${MONTHS[at.getMonth()]} ${at.getDate()}`;
}

function hour(at: Date): string {
  const h = at.getHours();
  return `${day(at)}, ${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "AM" : "PM"}`;
}

/** A sheet row's date as words: `2026-11-24` → "Nov 24"; a time keeps its hour; text that is not a date is kept as written. */
export function rowDateWords(date: string): string {
  const said = date.trim();
  const plain = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(said);
  if (plain !== null) return `${MONTHS[Number(plain[2]) - 1] ?? ""} ${Number(plain[3])}`.trim();
  const at = Date.parse(said);
  if (Number.isNaN(at)) return said;
  return hour(new Date(at));
}

/**
 * A worked-out period as words: a day or shorter is its day (with its hour
 * when it is an hour or less), longer is its first and last day. `to` is the
 * period's end, not part of it.
 */
export function periodDateWords(from: string, to: string): string {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return Number.isNaN(end) ? "" : day(new Date(end));
  const last = new Date(end - 1);
  if (end - start <= 3_600_000) return hour(new Date(start));
  if (end - start <= DAY && day(new Date(start)) === day(last)) return day(last);
  return day(new Date(start)) === day(last) ? day(last) : `${day(new Date(start))} – ${day(last)}`;
}
