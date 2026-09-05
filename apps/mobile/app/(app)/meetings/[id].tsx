import { useLocalSearchParams } from "expo-router";
import { LiveMeetingScreen } from "../../../features/meetings/LiveMeetingScreen";
import { MeetingNoteScreen } from "../../../features/meetings/MeetingNoteScreen";
import { isLive } from "../../../features/meetings/session";
import { useMeetingsSnapshot } from "../../../features/meetings/useMeetings";

/**
 * `/meetings/:id` — one meeting, at whatever point in its life it is at.
 *
 * **The route is the same before and after End**, and that is the decision this
 * file exists to hold. Ending a meeting moves the session from `recording` to
 * `finalizing`; it does not navigate. Somebody who has just finished stays on
 * the screen they were on and watches it become a note, instead of being thrown
 * back to a list and having to find the thing they were in the middle of.
 *
 * So the choice of screen is derived from the session's state rather than from
 * the URL — `isLive` is the protocol's own two live states — and there is
 * exactly one place in the app that makes it.
 *
 * A meeting id that is not on this device renders through `MeetingNoteScreen`,
 * which says so plainly. That is the honest answer for a link followed on
 * another phone: the meeting is real, this device does not hold it, and the
 * screen does not pretend either way.
 */
export default function MeetingRoute() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const snapshot = useMeetingsSnapshot();
  const meetingId = typeof id === "string" ? id : "";

  const record = snapshot.records.find((candidate) => candidate.session.id === meetingId);
  if (record !== undefined && isLive(record.session.state)) {
    return <LiveMeetingScreen meetingId={meetingId} />;
  }
  return <MeetingNoteScreen meetingId={meetingId} />;
}
