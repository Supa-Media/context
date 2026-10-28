import { Linking } from "react-native";

import { Button } from "../../design/components/Button";
import { openCallLabel } from "../join";
import type { MeetingSession } from "../protocol";
import { safeJoinUrl } from "@context/meetings/scheduled";

/**
 * "Open Google Meet", on a meeting joined from the calendar (board w2).
 *
 * The browser's half of Join and take notes: its share prompt spends the press
 * that would have opened the call, so the call is offered here, in the spot
 * the button was, the moment the notes are running. The link is checked again
 * rather than trusted from the record: it came from an invite.
 */
export function OpenCallButton({ session, testID }: { session: MeetingSession; testID?: string }) {
  const url = safeJoinUrl(session.source?.url ?? null);
  if (url === null) return null;
  return (
    <Button
      label={`${openCallLabel(url)} ↗`}
      variant="dialogPrimary"
      onPress={() => void Linking.openURL(url).catch(() => {})}
      testID={testID}
    />
  );
}
