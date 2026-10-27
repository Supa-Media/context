/**
 * WHEN A ROUTINE TEXTS, SAID BACK TO THE TURN THAT WROTE IT (a review of a
 * chat, 2026-10-25: "remind me to respond to elizabeth tmrw 5pm" got "Will
 * do." after one write, and nothing said whether a reminder would come).
 *
 * The written routine is read the way the scheduler reads it
 * (`packages/shared/src/routines.cjs`): its settings, then the first time it
 * runs in their zone. The turn is told that moment ("Sunday, October 25 at
 * 5:00 pm, tomorrow"), so a wrong day or a time already gone is fixed before
 * it answers, and one that won't run at all says why.
 */

import { nextRunAt, routineFromPath, routineSettings, wallClock } from "../../../../packages/shared/src/routines.cjs";
import { DEFAULT_TIME_ZONE, readTimeZone } from "./localNow.js";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const dayOf = (w) => Date.UTC(w.year, w.month - 1, w.day) / 86_400_000;

/** "Sunday, October 25 at 5:00 pm, tomorrow" for instant `ms` in `zone`, said from `now`. */
export function localWhen(ms, zone, now) {
  const w = wallClock(ms, zone);
  const h = w.hour % 12 === 0 ? 12 : w.hour % 12;
  const time = `${h}:${String(w.minute).padStart(2, "0")} ${w.hour < 12 ? "am" : "pm"}`;
  const days = dayOf(w) - dayOf(wallClock(now, zone));
  const near = days === 0 ? ", today" : days === 1 ? ", tomorrow" : "";
  return `${WEEKDAYS[w.weekday]}, ${MONTHS[w.month - 1]} ${w.day} at ${time}${near}`;
}

/**
 * The line a routine write's result gains: `{ runs, text }`, or null for a
 * path that is no routine. `runs` false means no text will come from it as
 * written.
 */
export function routineWhen(path, content, timeZone, now = Date.now()) {
  const routine = routineFromPath(path);
  if (routine?.kind !== "routine" || typeof content !== "string") return null;
  const { settings, problems } = routineSettings(content, routine.cadence);
  if (problems.length > 0) {
    return { runs: false, text: `This routine won't run as written: ${problems.join(" ")} Fix it now with write_note before you answer.` };
  }
  if (settings.paused) return { runs: false, text: "It is paused, so it won't text them until the paused: (or done:) line is taken out." };
  const zone = readTimeZone(settings.timeZone) ?? readTimeZone(timeZone) ?? DEFAULT_TIME_ZONE;
  const next = nextRunAt(routine.cadence, settings, zone, now);
  if (next === null) {
    return {
      runs: false,
      text: `This reminder won't text them: the time it names has already passed where they are (it is now ${localWhen(now, zone, now)}). Fix its at: line now before you answer.`,
    };
  }
  return { runs: true, text: `It first texts them ${localWhen(next, zone, now)} (${zone}). If that isn't when they asked for, fix its at: line now.` };
}
