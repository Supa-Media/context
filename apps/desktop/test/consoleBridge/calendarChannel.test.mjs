/**
 * The console handing the menu bar today's meetings (bridge version 9,
 * `calendar.setUpcoming`), as the main process receives it: only from the
 * console's own frame, and rebuilt field by field, so a link off the join-host
 * allowlist arrives as no link. Split from `ipcCensus.test.mjs`, which counts
 * the channel.
 */

import { BRIDGE_CHANNELS } from "@context/desktop-bridge";
import { mainBridge, sender } from "./fixtures.mjs";

export async function runCalendarChannelChecks(check) {
  // -- today's meetings, version 9 --------------------------------------------
  {
    const { ipc, upcomings } = mainBridge();
    await ipc.handlers.get(BRIDGE_CHANNELS.calendarSetUpcoming)(sender(), {
      meetings: [
        {
          id: "a@example.test:1",
          title: "Weekly",
          startsAt: "2026-10-28T16:00:00Z",
          endsAt: "2026-10-28T17:00:00Z",
          conferenceUrl: "https://meet.google.com.evil.example/x",
          attendees: [],
          token: "cat_secret",
        },
      ],
      askBeforeMs: 60_000,
    });
    check("the console can hand the menu bar today's meetings", upcomings.length === 1 && upcomings[0].meetings[0].title === "Weekly");
    check("...rebuilt in the main process, so a link off the allowlist arrives as no link", upcomings[0].meetings[0].conferenceUrl === null);
    check("...and a field the contract does not name is not carried", !JSON.stringify(upcomings[0]).includes("cat_secret"));
    let refused = false;
    const { ipc: other, upcomings: otherUpcomings } = mainBridge();
    try {
      await other.handlers.get(BRIDGE_CHANNELS.calendarSetUpcoming)(sender({ id: 99 }), { meetings: [] });
    } catch {
      refused = true;
    }
    check("a frame that is not the console cannot name a meeting in the menu bar", refused && otherUpcomings.length === 0);
  }
}
