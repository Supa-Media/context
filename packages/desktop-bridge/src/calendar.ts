/**
 * Today's meetings from the person's own calendars, handed to the Mac app's
 * menu bar (`DesktopBridge.calendar`, version 9).
 *
 * The shell holds no control-plane session and so cannot read a calendar;
 * the page can, and pushes what it read whenever it changes. The shell keeps
 * the last list in memory only, names the next meeting beside the menu-bar
 * icon, offers "Join and take notes" in its menu, and asks `askBeforeMs`
 * before one starts. Nothing it is handed ever starts a recording: joining is
 * a press on the menu or on the nudge, the same consent as Record
 * (docs/decisions/meetings/joining-from-the-calendar.md). The shell re-checks
 * every link against the join-host allowlist before it opens one, because
 * this crosses from a page served from the network.
 */

/** One meeting the menu bar may name and join. Text is the invite's, so it is rendered as text. */
export interface UpcomingMeetingView {
  id: string;
  title: string;
  /** ISO instants. */
  startsAt: string;
  endsAt: string;
  /** The call link, already allowlisted by the page and checked again by the shell, or `null`. */
  conferenceUrl: string | null;
  /** The other guests, for naming speakers. The person themself is not listed. */
  attendees: { name: string; email: string }[];
}

export interface UpcomingMeetings {
  meetings: UpcomingMeetingView[];
  /** How long before a meeting the shell asks, or `null` for never. */
  askBeforeMs: number | null;
}
