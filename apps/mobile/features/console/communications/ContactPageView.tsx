/**
 * The Contact page: identifiers, a person's own notes, and activity links
 * grouped by month — each one opening the channel-day it happened in, at the
 * message's own anchor.
 */

import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { contactNotePath } from "@context/communications";
import { PressRow } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { radii, space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import type { FileBrowser } from "../files/browser";
import { ensureMarkdown } from "../files/paths";
import { groupContactActivity, shapeContactView } from "./contact";

export function ContactPageView({
  slug,
  files,
  onOpenActivity,
}: {
  slug: string;
  files: FileBrowser;
  /** Opens the channel-day an activity entry points at, at its own anchor. */
  onOpenActivity: (path: string, anchor: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const path = contactNotePath(slug);

  /**
   * `readRaw` is a plain read with no cache of its own (`browser.ts`'s own
   * comment) — this view keeps the one copy it read rather than the console
   * growing a second cache beside `listings` for a single page kind.
   * `undefined` is "still reading"; `null` is "not found, or not visible to
   * this scope" — `readRaw`'s contract answers the two alike, on purpose.
   */
  const [text, setText] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    setText(undefined);
    void files.readRaw(path).then((note) => {
      if (!cancelled) setText(note?.text ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [files, path]);

  if (text === undefined) {
    return (
      <View style={styles.page}>
        <Text variant="meta">Loading…</Text>
      </View>
    );
  }
  if (text === null) {
    return (
      <View style={styles.page}>
        <Text variant="meta">Not found.</Text>
      </View>
    );
  }

  const view = shapeContactView(text);
  const groups = groupContactActivity(view);

  return (
    <View style={styles.page}>
      <Text variant="noteTitle" role="heading" aria-level={2}>
        {view.name}
      </Text>
      {view.organization ? (
        <Text variant="paneSub" style={styles.organization}>
          {view.organization}
        </Text>
      ) : null}

      {view.identifiers.length > 0 ? (
        <View style={styles.section}>
          <Text variant="rowSub" style={styles.sectionHeading}>
            Identifiers
          </Text>
          {view.identifiers.map((identifier, index) => (
            <Text key={index} variant="body">
              {identifier.kind}: {identifier.value}
            </Text>
          ))}
        </View>
      ) : null}

      {view.conflicts.length > 0 ? (
        <View style={styles.section}>
          <Text variant="hint" style={styles.sectionHeading}>
            Disagreements
          </Text>
          {view.conflicts.map((conflict, index) => (
            <Text key={index} variant="hint">
              {conflict}
            </Text>
          ))}
        </View>
      ) : null}

      <View style={styles.section}>
        <Text variant="rowSub" style={styles.sectionHeading}>
          Activity
        </Text>
        {groups.length === 0 ? (
          <Text variant="meta">Nothing yet.</Text>
        ) : (
          groups.map((group) => (
            <View key={group.month} style={styles.month}>
              <Text variant="treeMeta" style={styles.monthHeading}>
                {group.month}
              </Text>
              {group.entries.map((entry, index) => (
                <PressRow
                  key={index}
                  /*
                    `entry.path` has no `.md` — `activityLink` (in
                    `@context/communications`) strips it deliberately,
                    because it is writing an Obsidian wikilink target and a
                    wikilink never carries the extension. This console's own
                    navigation is not wikilink resolution — `files.select`
                    and the route's `noteHref` both work on real bucket
                    paths — so the suffix goes back on here, at the one seam
                    between "how a link is written" and "how this app opens
                    one".
                  */
                  onPress={() => onOpenActivity(ensureMarkdown(entry.path), entry.anchor)}
                  style={styles.activityRow}
                  hoverStyle={styles.activityRowHover}
                  radius={radii.md}
                  accessibilityLabel={`${entry.date}: ${entry.label}`}
                  testID="contact-activity-row"
                >
                  <Text variant="treeMeta" style={styles.activityDate}>
                    {entry.date}
                  </Text>
                  <Text variant="body" numberOfLines={1} style={styles.activityLabel}>
                    {entry.label}
                  </Text>
                </PressRow>
              ))}
            </View>
          ))
        )}
      </View>

      {view.notes ? (
        <View style={styles.section}>
          <Text variant="rowSub" style={styles.sectionHeading}>
            Notes
          </Text>
          <Text variant="body">{view.notes}</Text>
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  page: { gap: space.x3 },
  organization: { color: colors.muted, marginTop: -space.x2 },
  section: { marginTop: space.x3, gap: space.x1 },
  sectionHeading: { color: colors.muted, marginBottom: space.x1 },
  month: { marginTop: space.x2 },
  monthHeading: { color: colors.muted, marginBottom: 2 },
  activityRow: { flexDirection: "row", alignItems: "center", gap: space.x2, paddingVertical: 6 },
  activityRowHover: { backgroundColor: colors.surface3 },
  activityDate: { color: colors.muted, width: 92 },
  activityLabel: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
});
