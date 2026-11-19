import { Linking, Pressable } from "react-native";

import { Button } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { useColors } from "../../design/theme";
import { callName, openCallLabel } from "../join";
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
export function OpenCallButton({
  session,
  link = false,
  testID,
}: {
  session: MeetingSession;
  /** Drawn as an accent link ("Google Meet ↗") in a line of text, for the side panel. */
  link?: boolean;
  testID?: string;
}) {
  const colors = useColors();
  const url = safeJoinUrl(session.source?.url ?? null);
  if (url === null) return null;
  if (link) {
    return (
      <Pressable
        onPress={() => void Linking.openURL(url).catch(() => {})}
        role="link"
        accessibilityLabel={openCallLabel(url)}
        testID={testID}
      >
        <Text variant="rowSub" style={{ color: colors.accentText }}>
          {`${callName(url) ?? "Open the call"} ↗`}
        </Text>
      </Pressable>
    );
  }
  return (
    <Button
      label={`${openCallLabel(url)} ↗`}
      variant="dialogPrimary"
      onPress={() => void Linking.openURL(url).catch(() => {})}
      testID={testID}
    />
  );
}
