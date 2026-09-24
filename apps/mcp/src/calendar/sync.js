/** The cron's calendar refresh (single-deployment only). */

import { expandCalendarEvents, parseIcs } from "./ics.js";
import {
  generatedCollaborationBase,
  generatedNoteFor,
  storedTextAt,
  writeGeneratedNote,
} from "../notes/sealing.js";
import { recordChange } from "../activity/record.js";

/* ------------------------------- calendar --------------------------------- */

export async function syncCalendar(env, store) {
  if (!env.CALENDAR_ICS_URL) return;
  const res = await fetch(env.CALENDAR_ICS_URL);
  if (!res.ok) return;
  const ics = await res.text();
  const now = Date.now();
  const horizon = now + 14 * 24 * 3600 * 1000;
  const events = expandCalendarEvents(
    parseIcs(ics),
    new Date(now - 24 * 3600 * 1000),
    new Date(horizon)
  );
  const upcoming = events
    .filter((e) => e.start && e.start.getTime() >= now - 24 * 3600 * 1000 && e.start.getTime() <= horizon)
    .sort((a, b) => a.start - b.start);

  const byDay = new Map();
  for (const e of upcoming) {
    const day = e.start.toISOString().slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(e);
  }

  let md = `---\nupdated: ${new Date().toISOString()}\nsource: calendar-cron\n---\n\n# Calendar — next 14 days\n\n`;
  md += `> Auto-generated from the calendar feed. Times are UTC unless the event was all-day.\n> Common recurring-event rules are expanded; unusually complex rules may be under-represented.\n\n`;
  if (!byDay.size) md += "_No events in the next 14 days._\n";
  for (const [day, list] of byDay) {
    md += `## ${day}\n`;
    for (const e of list) {
      const time = e.allDay ? "all day" : e.start.toISOString().slice(11, 16);
      md += `- ${time} — ${e.summary}${e.location ? ` @ ${e.location}` : ""}\n`;
    }
    md += "\n";
  }
  // The refresh regenerates this note every run. If somebody encrypted it, it
  // stays encrypted; if it cannot be opened, the refresh is skipped rather than
  // stripping the encryption off a note in the customer's own bucket.
  //
  // The path is written as a literal at the `store.put` below rather than held
  // in the variable read just above it, because `teamShare.test.ts` reads this
  // source for `store.put("<product path>"` and checks every one against
  // `PRODUCT_MANDATED_PATHS` — a guard that a variable here would silently
  // empty out.
  const calendarPrevious = await storedTextAt(store, "2-areas/calendar/next-14-days.md");
  const calendarCollaborationBase = await generatedCollaborationBase(
    store,
    "2-areas/calendar/next-14-days.md",
    calendarPrevious,
  );
  const calendarBody = await generatedNoteFor(
    store,
    md,
    calendarCollaborationBase?.text ?? calendarPrevious,
  );
  if (calendarBody === null) return;
  await writeGeneratedNote(
    store,
    "2-areas/calendar/next-14-days.md",
    calendarBody,
    calendarCollaborationBase,
  );
  await recordChange(store, "calendar_sync", "system", ["2-areas/calendar/next-14-days.md"], {
    count: upcoming.length,
  });
}
