import { View } from "react-native";
import { Button } from "../design/components/Button";
import { Icon } from "../design/components/Icon";
import { Text } from "../design/components/Text";
import { useColors, useThemedStyles } from "../design/theme";
import { makeStyles as browseStyles } from "../console/panes/browsePane/styles";
import type { Announcement } from "../console/panes/browsePane/announcements";
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
  return phoneEntryCount(organizer?.status ?? null, place) !== null;
}

/**
 * 07's one-time notice for people already on Premium, as an announcement.
 *
 * It left the band for the corner card: it is news, not something wrong, and
 * full width above every note it was what the owner reported as taking over
 * the page. Both answers are the durable ones they always were, and they are
 * the only way it goes away.
 */
export function organizerAnnouncement(organizer: OrganizerView | undefined): Announcement | null {
  if (organizer === undefined || !existingNoticeVisible(organizer.status ?? null)) return null;
  return {
    id: "organizer-existing",
    eyebrow: existingCopy.eyebrow,
    title: existingCopy.title,
    body: existingCopy.body,
    actions: [
      { label: existingCopy.ok, onPress: () => organizer.acknowledgeNotice(false), testID: "organizer-notice-ok" },
      { label: existingCopy.off, onPress: () => organizer.acknowledgeNotice(true), testID: "organizer-notice-off" },
    ],
    testID: "organizer-existing-notice",
  };
}

/** The same, read from the console's organizer. */
export function useOrganizerAnnouncement(): Announcement | null {
  return organizerAnnouncement(useOrganizerView());
}

/**
 * Auto-organize's line in the browse band: 04b's phone entry to the review
 * list, on the workspace's own page, in the band's notice treatment with its
 * `mini` button. It stays in the band because it is the phone's only way in to
 * the list, not news.
 */
export function OrganizerNotices(place: NoticePlace) {
  const organizer = useOrganizerView();
  const styles = useThemedStyles(browseStyles);
  const colors = useColors();
  if (organizer === undefined) return null;
  const count = phoneEntryCount(organizer.status, place);
  if (count === null) return null;
  return (
    <View style={[styles.notice, phoneRow]} testID="organizer-phone-entry">
      <Icon name="sparkle" size={14} color={colors.accent} />
      <Text variant="hint" style={phoneText}>
        {phoneLine(count)}
      </Text>
      <Button label={reviewCopy.phoneOpen} onPress={() => organizer.openReview()} testID="organizer-look-over" />
    </View>
  );
}

const phoneRow = { flexDirection: "row", alignItems: "center", gap: 10 } as const;
const phoneText = { flex: 1, minWidth: 0 } as const;
