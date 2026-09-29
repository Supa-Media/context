/**
 * The Encryption row under a binding's fields in Settings › Storage.
 *
 * Drawn as one more row of the binding's `FieldList` (same label column, same
 * hairline), because it is one more fact about where the files are kept. What
 * it says is `encryptionRowCopy`'s; this only lays it out.
 */

import { useState } from "react";
import { Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { densityFor } from "../../app/frame";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { layout, radii, space } from "../../design/tokens";
import type { ConsoleStorage } from "../types";
import { encryptionRowCopy } from "./encryptionRow";

export function EncryptionRow({ storage }: { storage: ConsoleStorage }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const compact = densityFor(useWindowDimensions().width) === "compact";
  const [more, setMore] = useState(false);
  const copy = encryptionRowCopy(storage, compact);
  if (copy === null) return null;

  return (
    <View style={styles.row} testID={`storage-field-encryption-${copy.state}`}>
      <Text variant="rowSub" style={styles.label} numberOfLines={1}>
        Encryption
      </Text>
      <View style={styles.value}>
        {copy.title ? (
          <View style={styles.titleRow}>
            {copy.lock ? (
              <Icon name="lock" size={14} color={copy.state === "encrypted" ? colors.okText : colors.text2} />
            ) : null}
            <Text variant="check" style={styles.title} testID="storage-encryption-title">
              {copy.title}
            </Text>
          </View>
        ) : null}
        {copy.progress !== undefined ? (
          <View
            style={styles.track}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(copy.progress * 100)}
            testID="storage-encryption-progress"
          >
            <View style={[styles.fill, { width: `${Math.round(copy.progress * 1000) / 10}%` }]} />
          </View>
        ) : null}
        <Text variant="rowSub" style={styles.body} testID="storage-encryption-body">
          {more && copy.more ? copy.more : copy.body}
        </Text>
        {copy.more && !more ? (
          <Pressable role="button" onPress={() => setMore(true)} hitSlop={8} testID="storage-encryption-more">
            <Text variant="rowSub" style={styles.link}>
              What this means
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    // The `FieldList` row, so this reads as one more line of the same list.
    row: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: space.x4,
      paddingVertical: space.x3,
      minHeight: layout.minTouchTarget,
      borderTopWidth: 1,
      borderTopColor: colors.line,
    },
    label: { width: 132, flexShrink: 0, color: colors.muted },
    value: { flex: 1, minWidth: 0, gap: space.x1 },
    titleRow: { flexDirection: "row", alignItems: "center", gap: 6 },
    title: { color: colors.text, fontWeight: "600", flexShrink: 1 },
    body: { color: colors.text2 },
    track: {
      height: 4,
      borderRadius: radii.pill,
      backgroundColor: colors.surface3,
      overflow: "hidden",
      marginVertical: 2,
    },
    fill: { height: "100%", backgroundColor: colors.accent },
    link: { color: colors.accentText },
  });
