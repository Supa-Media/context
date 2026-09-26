import { View } from "react-native";
import { Button } from "../design/components/Button";
import { Icon } from "../design/components/Icon";
import { Text } from "../design/components/Text";
import { useColors, useThemedStyles } from "../design/theme";
import { makeStyles as browseStyles } from "../console/panes/browsePane/styles";
import { existingCopy, phoneLine, reviewCopy } from "./copy";
import { useOrganizerView } from "./OrganizerContext";
import { existingNoticeVisible, phoneEntryCount } from "./rules";
import type { OrganizerView } from "./useOrganizer";

/** Where the band is being drawn, which decides whether the phone's entry line belongs in it. */
export interface NoticePlace {
  compact: boolean;
  /** The workspace's own page: nothing, or the root folder, selected. */
  atRoot: boolean;
}

/** Whether auto-organize has a line for the notices band here — `useBrowseNotices`'s `hasNotice`. */
export function useOrganizerHasNotice(place: NoticePlace): boolean {
  const organizer = useOrganizerView();
  return organizerNotices(organizer, place).length > 0;
}

function organizerNotices(organizer: OrganizerView | undefined, place: NoticePlace): ("existing" | "entry")[] {
  const status = organizer?.status ?? null;
  const lines: ("existing" | "entry")[] = [];
  if (existingNoticeVisible(status)) lines.push("existing");
  if (phoneEntryCount(status, place) !== null) lines.push("entry");
  return lines;
}

/**
 * Auto-organize's lines in the browse band: 07's one-time notice for people
 * already on Premium, and 04b's phone entry to the review list. Both use the
 * band's own notice treatment and its `mini` pair.
 */
export function OrganizerNotices(place: NoticePlace) {
  const organizer = useOrganizerView();
  const styles = useThemedStyles(browseStyles);
  const colors = useColors();
  if (organizer === undefined) return null;
  const lines = organizerNotices(organizer, place);
  const count = phoneEntryCount(organizer.status, place);
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
      {lines.includes("entry") && count !== null ? (
        <View style={[styles.notice, phoneRow]} testID="organizer-phone-entry">
          <Icon name="sparkle" size={14} color={colors.accent} />
          <Text variant="hint" style={phoneText}>
            {phoneLine(count)}
          </Text>
          <Button label={reviewCopy.phoneOpen} onPress={() => organizer.openReview()} testID="organizer-look-over" />
        </View>
      ) : null}
    </>
  );
}

const phoneRow = { flexDirection: "row", alignItems: "center", gap: 10 } as const;
const phoneText = { flex: 1, minWidth: 0 } as const;
