/**
 * What time it is where the person is, told to every turn (the owner,
 * 2026-10-14: Tex said it had "no clock for this chat" and asked for the
 * phone's time before it would set "remind me in 2 minutes").
 *
 * The zone is the one their routines run in: the account's own, which the app
 * keeps in step with their device, else the routines' default. A texted turn
 * is handed it by the texting Worker from the control plane; a routine run has
 * its own; anything else falls back to the default, named, so the model never
 * mistakes it for theirs.
 */

import { wallClock } from "../../../../packages/shared/src/routines.cjs";

/** The routines' default zone when an account has none (Convex `DEFAULT_ROUTINE_TIME_ZONE`). */
export const DEFAULT_TIME_ZONE = "America/New_York";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** `value` when it is an IANA zone this runtime knows, else null. */
export function readTimeZone(value) {
  if (typeof value !== "string" || value === "" || value.length > 64) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    return null;
  }
}

/** "11:35 pm", the way a routine's `at:` line writes a time. */
function twelveHour(hour, minute) {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}:${String(minute).padStart(2, "0")} ${hour < 12 ? "am" : "pm"}`;
}

/**
 * The system prompt's line: the day, date and time in their zone, with the
 * same instant in the form a one-off routine's `at:` takes, so "in 2 minutes"
 * is arithmetic and never a question.
 */
export function localNowPrompt(now, timeZone) {
  const zone = readTimeZone(timeZone) ?? DEFAULT_TIME_ZONE;
  const w = wallClock(now, zone);
  const date = `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
  const time = twelveHour(w.hour, w.minute);
  return (
    `\n\nIt is now ${WEEKDAYS[w.weekday]}, ${MONTHS[w.month - 1]} ${w.day}, ${w.year}, ${time} where they are (${zone}); ` +
    `as a routine's at: line that is ${date} ${time}. ` +
    `Work out today, tomorrow, "in 2 minutes" and every date you write from this. You always know the time: never ask them for it.`
  );
}
