import assert from "node:assert/strict";
import { oneToOne } from "../chats.mjs";
import { renderCalendarDay } from "../../../../../packages/communications/src/calendar/render.js";
import { CALENDAR_PATH, calendarDigest, calendarNote } from "../../../../../packages/tex/gateway/agent/calendarCache.js";

const iso = (ms) => new Date(ms).toISOString();

export default {
  id: "happening-now-and-rsvp",
  incident:
    "2026-11-22 (invented names): a person texted a mini-golf rules question from their own mini-golf birthday party, and Tex answered it as a rules question. " +
    "The same week a check-in offered to RSVP yes to an invite they had already accepted.",
  cause:
    "The calendar copy every text is shown dropped each guest's answer and the person's own, and nothing told a text which event on their calendar was going on right now, so the model held the party and the question apart.",
  path: "1:1 texts with a calendar copy",
  async run() {
    const chat = await oneToOne();
    try {
      const now = Date.now();
      const today = iso(now).slice(0, 10);
      // Kept inside today's UTC day, so a run just after midnight still finds the party on today's page.
      const dayStart = Date.parse(`${today}T00:00:00Z`);
      const party = {
        id: "p1",
        account: "rowan@work.example",
        title: "Mini golf birthday",
        start: { dateTime: iso(Math.max(now - 30 * 60_000, dayStart)) },
        end: { dateTime: iso(Math.min(now + 90 * 60_000, dayStart + 86_400_000 - 1_000)) },
        attendees: [
          { email: "rowan@work.example", self: true, organizer: true, responseStatus: "accepted" },
          { name: "Bo Guest", email: "bo@example.invalid", responseStatus: "tentative" },
        ],
      };
      const day = renderCalendarDay({ date: today, timezone: "UTC", events: [party], nonce: "n1", now: iso(now), origin: "calendar-live" });
      const weekday = new Date(now).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
      const digest = calendarDigest(`## ${weekday} ${today}\n\nrowan@work.example\n\n${day}`);
      chat.world.bucket.set(CALENDAR_PATH, { body: calendarNote(digest, now), etag: "c1" });
      const asked = await chat.text("how do you break a tie on the last hole", "Usually a playoff hole.", { body: { timeZone: "UTC" } });
      assert.match(asked.shown, /Happening now on their calendar: Mini golf birthday \(/, "a text sent during the party is told it is on");
      assert.match(asked.shown, /may well be about it/, "and that the text may be about it");
      assert.match(asked.shown, /Your RSVP: going \(you organized it\)/, "the copy keeps their own answer");
      assert.match(asked.shown, /Bo Guest \(maybe\)/, "and each guest's");
    } finally {
      chat.restore();
    }
  },
};
