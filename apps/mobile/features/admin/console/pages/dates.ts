/**
 * The console's one date format: month and day in local time, as "Nov 12". People and Reports both
 * use it, so a date reads the same on every page.
 */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function shortDay(at: number): string {
  const d = new Date(at);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}
