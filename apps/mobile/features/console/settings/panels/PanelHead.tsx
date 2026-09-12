import type { ReactNode } from "react";
import { StyleSheet } from "react-native";
import { Card } from "../../../design/components/Card";
import { Text } from "../../../design/components/Text";
import { useThemedStyles } from "../../../design/theme";
import { settingsSectionLabel, type SettingsSectionKey } from "../sections";

/**
 * The two lines every settings panel opens with.
 *
 * Here rather than copied into four files for the reason a test already pins:
 * **the heading is `settingsSectionLabel(key)`, never a literal.** The row and
 * the panel were separate strings once and they drifted — a row reading "Mail,
 * calendar & chats" opened a panel headed "Integrations", handing back the
 * vocabulary the row existed to avoid. One helper reading the one list is how
 * that stays impossible rather than merely unlikely.
 *
 * `sectioned` is which of the two shapes the pane is in. With a `section` the
 * overlay owns the chrome and one block is the whole panel, so its name is the
 * panel's *title*; without one this is the original scroll and the name is an
 * eyebrow separating this block from the one above it. See `SettingsPane`.
 */
export function PanelHead({
  section,
  sectioned,
  first = false,
  children,
}: {
  section: SettingsSectionKey;
  sectioned: boolean;
  /**
   * The first block of the whole-scroll pane, which has a pane head above it
   * and needs no 30pt of its own to separate it from a block that is not
   * there. Meaningless when `sectioned`, where there is only ever one block.
   */
  first?: boolean;
  children: ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <>
      {/*
        A heading, but only when this block *is* the screen.

        The overlay's title bar no longer carries the section's name — a bar
        titled "Storage" over a panel titled "Storage" was the duplicate this
        redesign removed — so with a `section` this is the only name on the
        screen and has to be readable as one. Without a `section` these are
        eyebrows separating eight blocks under a single pane head, and a page
        of sibling h2s there would be a worse outline rather than a better one.
      */}
      <Text
        variant={sectioned ? "paneTitle" : "eyebrow"}
        role={sectioned ? "heading" : undefined}
        aria-level={sectioned ? 2 : undefined}
        style={sectioned || first ? styles.head : styles.headLater}
      >
        {settingsSectionLabel(section)}
      </Text>
      <Text variant="paneSub" style={styles.sub}>
        {children}
      </Text>
    </>
  );
}

/**
 * Why this context cannot do the thing the panel is named after.
 *
 * A shared workspace is not a brain: it has no capture address, and nobody's
 * mailbox, calendar or chat history belongs to a bucket several people watch.
 * The *controls* for those are absent rather than disabled — but the sentence
 * saying why is the reason these sections are listed for a workspace at all,
 * so it is a card with a title rather than a greyed row or a missing one.
 *
 * Every one of them ends on the same clause — **"Switch to a personal
 * brain"** — deliberately: it is the one action that resolves any of them, and
 * a reader who has met it once should recognise it rather than read three
 * different phrasings of the same instruction.
 */
export function WorkspaceRefusalCard({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Card>
      <Text variant="rowTitle">{title}</Text>
      <Text variant="rowSub" style={styles.rowSub}>
        {children}
      </Text>
    </Card>
  );
}

const makeStyles = () =>
  StyleSheet.create({
    head: { marginBottom: 4 },
    headLater: { marginTop: 30, marginBottom: 4 },
    sub: { marginBottom: 12, maxWidth: 546 },
    rowSub: { marginTop: 2 },
  });
