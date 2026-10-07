import { View } from "react-native";
import { Button } from "../design/components/Button";
import { Icon } from "../design/components/Icon";
import { Text } from "../design/components/Text";
import { useColors, useThemedStyles } from "../design/theme";
import { makeStyles as browseStyles } from "../console/panes/browsePane/styles";
import { existingCopy, phoneLine, reviewCopy } from "./copy";
import { useOrganizerView } from "./OrganizerContext";
import { existingNoticeVisible, phoneChangesCount, phoneEntryCount } from "./rules";
import type { OrganizerView } from "./useOrganizer";
import { useMessageSlot } from "../messages/useInAppMessage";

/** Where the band is being drawn, which decides whether the phone's entry line belongs in it. */
export interface NoticePlace {
  compact: boolean;
  /** The workspace's own page: nothing, or the root folder, selected. */
  atRoot: boolean;
}

/** Whether auto-organize has a line for the notices band here — `useBrowseNotices`'s `hasNotice`. */
export function useOrganizerHasNotice(place: NoticePlace): boolean {
  const organizer = useOrganizerView();
  const existing = useExistingNoticeTurn(organizer);
  return organizerNotices(organizer, place, existing).length > 0;
}

/**
 * The one-time notice is a tip on the app's one message path
 * (`features/messages/`): its answer stays on auto-organize's settings, and it
 * waits for a visit where nothing else has been said. The phone's entry line
 * is a way in to a list, not a message, and is not arbitrated.
 */
function useExistingNoticeTurn(organizer: OrganizerView | undefined): boolean {
  const status = organizer?.status ?? null;
  const eligible = status !== null && status.available && status.isOwner;
  const { visible } = useMessageSlot({
    id: "organizer-notice",
    eligible,
    seen: status === null ? undefined : !status.noticeNeeded,
  });
  return visible && existingNoticeVisible(status);
}

function organizerNotices(
  organizer: OrganizerView | undefined,
  place: NoticePlace,
  existing: boolean,
): ("existing" | "entry")[] {
  const status = organizer?.status ?? null;
  const lines: ("existing" | "entry")[] = [];
  if (existing) lines.push("existing");
  // One line for both: what came in and what could be tidied are one page.
  if (phoneChangesCount(status, place) !== null || phoneEntryCount(status, place) !== null) lines.push("entry");
  return lines;
}

/**
 * Auto-organize's lines in the browse band: 07's one-time notice for people
 * already on Premium, and 04b's phone entry to What changed: one line for
 * what came in and what could be tidied, as the sidebar has one. Both use the
 * band's own notice treatment and its `mini` pair.
 */
export function OrganizerNotices(place: NoticePlace) {
  const organizer = useOrganizerView();
  const styles = useThemedStyles(browseStyles);
  const colors = useColors();
  const existing = useExistingNoticeTurn(organizer);
  if (organizer === undefined) return null;
  const lines = organizerNotices(organizer, place, existing);
  const count = phoneEntryCount(organizer.status, place);
  const changed = phoneChangesCount(organizer.status, place);
  return (
    <>
      {lines.includes("existing") ? (
        <View style={styles.notice} testID="organizer-existing-notice">
          <Text variant="hint">{existingCopy.body}</Text>
          <View style={styles.noticeActions}>
            <Button
              label={existingCopy.off}
              onPress={() => organizer.acknowledgeNotice(true)}
              testID="organizer-notice-off"
            />
            <Button
              label={existingCopy.ok}
              onPress={() => organizer.acknowledgeNotice(false)}
              testID="organizer-notice-ok"
            />
          </View>
        </View>
      ) : null}
      {lines.includes("entry") ? (
        <View style={[styles.notice, phoneRow]} testID="organizer-phone-entry">
          <Icon name="sparkle" size={14} color={colors.accent} />
          <Text variant="hint" style={phoneText}>
            {phoneLine((changed ?? 0) + (count ?? 0))}
          </Text>
          <Button
            label={reviewCopy.phoneOpen}
            onPress={() => {
              // What came in first; the tidy-ups when that is all there is.
              if (changed === null) organizer.openReview();
              else {
                organizer.setTab("inbox");
                organizer.openPage();
              }
            }}
            testID="organizer-look-over"
          />
        </View>
      ) : null}
    </>
  );
}

const phoneRow = { flexDirection: "row", alignItems: "center", gap: 10 } as const;
const phoneText = { flex: 1, minWidth: 0 } as const;
