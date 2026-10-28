# Meetings — Joining from the calendar

_See `docs/decisions/README.md` for the index._

### Join and take notes is one press, never none (decided by the owner, 2026-10-27)

The owner connected every Gmail account, calendars included, and asked for
"1 click to join and start transcribing meeting notes" in the Mac app and a
clear way to join a scheduled meeting on the web. Boards j1–j4 and w1–w3
(project files `meeting-join/`) were approved with "go for it".

**What the press does.** The meeting on the person's own calendar is read live
from Google (`apps/convex/functions/meetingCalendar.ts`, nothing kept, the same
rule as every calendar read since the copies were removed on 2026-10-21). One
press of **Join and take notes** opens the call and starts a meeting named
after the event, with the invite's guests as attendees, so the speaker labeller
has names. A meeting with no call link offers **Take notes** and records the
room.

**One press, never zero.** Nothing starts recording because a meeting began.
*Consent is the customer's* ([namespacing-and-signing](./namespacing-and-signing.md))
says a detector that starts recording on its own is the indicator removed, and
a calendar is a detector. The most the product does is name the meeting and
offer the press. Reversing this means a recorder that starts itself; the test
that fails is `useMeetingFlow`'s, which has no path to `controller.start`
except a press.

**Only a known call opens.** An invite's words are whoever sent it, so a Join
button that opened any link in a description would be a link anybody can put
behind a button that says Join. `safeJoinUrl` (`packages/meetings/src/scheduled.js`)
opens https links on Meet, Zoom, Teams, Webex and FaceTime hosts and their
subdomains only, with no login in the URL, and the live card checks the link
again rather than trusting the record. `packages/meetings/test/scheduled.test.mjs`
holds the look-alike hosts.

**A browser is two presses in the same spot, and says so.** A page cannot hear
the call without the browser's share prompt, which needs a press, and opening
the call in a new tab spends a press too. So on the web the one button opens
the prompt (with the first-time primer), and the live card then offers **Open
Google Meet** where the button was. Where the call can be heard without a
prompt (the Mac app's own tap, a phone's microphone) the call opens in the same
press. `__tests__/meetingsJoin.test.ts` fails if a browser spends its press on
the call.

**Which events are meetings.** Timed, not cancelled, not declined, and with a
call link or another person on it. Holds, birthdays and all-day blocks are not
offered. A meeting two of the person's accounts were both invited to shows
once.

**Where the notes go is unchanged: the person's own Inbox › Meetings.** Board
j4 drew a meeting whose guests are all members of a shared workspace filing
there instead. That was not built: `automaticDestination` holds that a
transcript lands in the recorder's own inbox before anyone else can read it,
and filing by guest list would put a transcript in a folder colleagues watch
before its owner has read a word of it. It is a separate decision for the
owner, not a default.

**Who can read the calendar.** Only the signed-in owner of the personal
workspace the Google accounts are connected to. An editor of somebody's
personal workspace never sees their meetings
(`apps/convex/__tests__/meetingCalendar.test.ts`).

**The read is a credential barrier.** Reading a calendar mints a Google access
token, and no public Convex function may reach that decrypt. So the public
`upcomingMeetings` checks the window and the session and calls one internal
action, `readMeetingCalendars`, pinned in `CREDENTIAL_BARRIERS` beside the file
and vault barriers. It answers meetings and addresses, never a token. The
structure suite (`__tests__/structure/`) fails if the public action reaches the
mint any other way.

**The Mac app's menu bar is handed the list, and asks once.** The shell holds
no control-plane session, so the console pushes today's meetings over the
desktop bridge (version 9, `calendar.setUpcoming`). The shell keeps them in
memory only. It rebuilds every field and checks every link against the
allowlist again, because the list crosses from a page served from the network.

What the person sees:

- From fifteen minutes before a meeting, the menu bar shows "Leadership Weekly
  · 4 min". A detected meeting or a recording's timer always wins that spot.
- The menu offers **Join and take notes** and **Join only**.
- A minute before the meeting, one notification asks with the same two
  buttons. Its close button is **Not now**, a click on the notification itself
  only opens Context, and it asks once per meeting.

Nothing the shell is handed starts a recording. Only a press does, and it
takes the same path as Record a meeting. `apps/desktop/test/calendarUpcoming.test.mjs`
reads `main/calendar.ts` and fails if a tick, an arriving list or a shown
nudge could reach `recordNow`.
