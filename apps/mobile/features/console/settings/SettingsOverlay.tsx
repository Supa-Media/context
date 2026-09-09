import {
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import { useState } from "react";
import { Overlay } from "../../design/components/Overlay";
import { Pill } from "../../design/components/Pill";
import { Text } from "../../design/components/Text";
import { layout, radii, space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { SettingsPane } from "../panes/SettingsPane";
import { atName } from "../format";
import type { AppSectionKey } from "../nav";
import { selectedContext, type ConsoleData } from "../types";
import {
  settingsSectionsFor,
  type SettingsSectionKey,
  type SettingsSectionSpec,
} from "./sections";

/**
 * Settings, drawn over the context somebody is already looking at.
 *
 * The pane's content is unchanged — the same binding card, the same connect
 * form, the same ingestion and search cards. What changed is that it is no
 * longer one scroll opening on an access key: the sections are addressable,
 * the list is the index, and the note behind the scrim keeps its place in the
 * URL. `SettingsPane` renders one block at a time when given a `section`; this
 * component owns the chrome around it.
 *
 * The group headings are the point of the ordering. "What comes in" and "Your
 * notes" are questions a person can answer without knowing what a bucket is,
 * which the previous headings — Storage, Integrations, Email ingestion — were
 * not. A section absent from `settingsSectionsFor` is absent from the list
 * rather than disabled: a shared workspace has no capture address, and a
 * greyed row inviting somebody to press it is a worse answer than no row.
 */
export function SettingsOverlay({
  data,
  section,
  onSelect,
  onOpenSection,
  onDismiss,
}: {
  data: ConsoleData;
  section: SettingsSectionKey;
  onSelect: (next: SettingsSectionKey) => void;
  /**
   * Map and Connections, which are console destinations rather than settings.
   * They are rendered at the foot of whichever section is open because this
   * list is the only surface `features/app/reachability.ts` claims those two
   * routes are reachable from — dropping it here would make them unreachable
   * rather than merely tidier.
   */
  onOpenSection?: (key: AppSectionKey) => void;
  onDismiss: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const current = selectedContext(data);
  /*
    A phone shows the list, then the section, rather than both at once. It
    starts on the section because opening settings from the gear or the
    storage chip is somebody asking for a *thing*, not for a menu — the list
    is one press back from there.
  */
  const compact = useWindowDimensions().width < layout.narrowBreakpoint;
  const [listing, setListing] = useState(false);
  const sections = settingsSectionsFor(
    current?.kind === "personal" || current?.kind === "shared" ? current.kind : null,
  );

  // A URL naming a section this context does not have — `?settings=email` on a
  // shared workspace — lands on the first one it does rather than on nothing.
  const active = sections.some((entry) => entry.key === section)
    ? section
    : (sections[0]?.key ?? "storage");

  let lastGroup: SettingsSectionSpec["group"] = null;
  const list = (
    <ScrollView contentContainerStyle={styles.side} testID="settings-sections">
      {sections.map((entry) => {
        const heading = entry.group !== lastGroup ? entry.group : null;
        lastGroup = entry.group;
        const on = entry.key === active;
        return (
          <View key={entry.key}>
            {heading === null ? null : (
              <Text variant="railHead" style={styles.group}>
                {heading}
              </Text>
            )}
            <Pressable
              accessibilityRole="tab"
              aria-selected={on}
              accessibilityLabel={entry.label}
              onPress={() => {
                onSelect(entry.key);
                setListing(false);
              }}
              style={[styles.row, on ? styles.rowOn : null]}
              testID={`settings-section-${entry.key}`}
            >
              <Text variant="rail" style={on ? styles.labelOn : undefined}>
                {entry.label}
              </Text>
            </Pressable>
          </View>
        );
      })}
    </ScrollView>
  );

  const chosen = sections.find((entry) => entry.key === active);

  if (compact) {
    return (
      <Overlay
        title={listing ? "Settings" : (chosen?.label ?? "Settings")}
        badge={current ? <Pill tone="neutral">{atName(current.slug)}</Pill> : null}
        onBack={listing ? undefined : () => setListing(true)}
        onDismiss={onDismiss}
        testID="settings-overlay"
      >
        {listing ? (
          list
        ) : (
          <ScrollView contentContainerStyle={styles.body}>
            <SettingsPane
              data={data}
              onClose={onDismiss}
              section={active}
              onOpenSection={onOpenSection}
            />
          </ScrollView>
        )}
      </Overlay>
    );
  }

  return (
    <Overlay
      title="Settings"
      badge={current ? <Pill tone="neutral">{atName(current.slug)}</Pill> : null}
      sidebar={list}
      onDismiss={onDismiss}
      testID="settings-overlay"
    >
      <ScrollView contentContainerStyle={styles.body}>
        <SettingsPane
          data={data}
          onClose={onDismiss}
          section={active}
          onOpenSection={onOpenSection}
        />
      </ScrollView>
    </Overlay>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    side: { paddingVertical: space.x4, paddingHorizontal: space.x3 },
    group: { marginTop: space.x4, marginBottom: space.x2, paddingHorizontal: space.x2 },
    row: {
      paddingVertical: 7,
      paddingHorizontal: 9,
      borderRadius: radii.md,
    },
    rowOn: { backgroundColor: colors.accentDim },
    labelOn: { color: colors.accentText },
    body: { padding: space.x6, paddingBottom: space.x8 },
  });
