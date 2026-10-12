/**
 * The contacts folder's letter folders, drawn as an A–Z index: one compact,
 * wrapping row of letters with `Other` last, in place of 27 folder rows.
 *
 * It is the only part of the contacts folder that is drawn differently — the
 * legacy folders and any flat pages are still ordinary `FolderRow`s under it,
 * and a letter opens its folder exactly as its row would have
 * (`docs/decisions/app-and-console/communications-console.md`). A letter with
 * no folder is drawn dim and does nothing, so the alphabet never has gaps that
 * read as a layout bug.
 */

import { StyleSheet, View } from "react-native";
import { PressRow } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { radii, space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import type { ContactLetter } from "./contactPages";

export function ContactsIndex({
  letters,
  onSelect,
  compact,
}: {
  letters: readonly ContactLetter[];
  onSelect: (path: string) => void;
  /** A phone: bigger cells, on the listing's own card ground. */
  compact: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const cell = [styles.cell, compact && styles.cellCompact];
  return (
    <View style={[styles.index, compact && styles.indexCompact]} role="navigation" accessibilityLabel="Contacts, A to Z" testID="contacts-index">
      {letters.map(({ letter, label, path }) => {
        const wide = letter === "other" ? styles.cellWide : null;
        return path === null ? (
          <View key={letter} style={[...cell, wide]} aria-disabled testID={`contacts-letter-${letter}`}>
            <Text variant="tree" style={styles.absent}>
              {label}
            </Text>
          </View>
        ) : (
          <PressRow
            key={letter}
            onPress={() => onSelect(path)}
            accessibilityLabel={letter === "other" ? "Other contacts" : `Contacts under ${label}`}
            style={[...cell, styles.cellPresent, wide]}
            hoverStyle={styles.cellHover}
            radius={radii.md}
            testID={`contacts-letter-${letter}`}
          >
            <Text variant="tree" style={styles.present}>
              {label}
            </Text>
          </PressRow>
        );
      })}
    </View>
  );
}

const CELL = 32;
const CELL_COMPACT = 38;

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    index: { flexDirection: "row", flexWrap: "wrap", gap: 4, paddingVertical: space.x1 },
    indexCompact: {
      padding: space.x2,
      borderRadius: radii.sheet,
      backgroundColor: colors.pageSurface,
      marginBottom: space.x2,
    },
    cell: {
      minWidth: CELL,
      height: CELL,
      borderRadius: radii.md,
      alignItems: "center",
      justifyContent: "center",
    },
    cellCompact: { minWidth: CELL_COMPACT, height: CELL_COMPACT },
    cellWide: { paddingHorizontal: space.x2 },
    cellPresent: { backgroundColor: colors.chipFill },
    cellHover: { backgroundColor: colors.surface3 },
    present: { color: colors.text, fontWeight: "600" },
    absent: { color: colors.muted, opacity: 0.5 },
  });
