import { texChatType } from "../../design/tokens";
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Tex } from "../../chaos/Tex";
import { Text } from "../../design/components/Text";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";

/**
 * The pill at the top of Tex's chat: the Tex mark, its name, and whether it is
 * ready or working. Centred, with no sub line and no divider under it.
 *
 * `mark` replaces the still Tex mark: the working animation is drawn by the
 * chat engine (section A's TexWorkingMark), so this file only places it.
 */
export function TexChatHeader({ busy, mark }: { busy: boolean; mark?: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <View style={styles.pill}>
      {mark ?? <Tex chaos={0} size={26} testID="tex-chat-figure" />}
      <View style={styles.words}>
        <Text variant="body" style={styles.name}>
          Tex
        </Text>
        <View style={styles.status}>
          <View style={[styles.dot, { backgroundColor: busy ? colors.accent : colors.ok }]} />
          <Text variant="meta" style={styles.statusText} testID="tex-status">
            {busy ? "Working" : "Ready"}
          </Text>
        </View>
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    pill: {
      alignSelf: "center",
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginTop: 6,
      marginBottom: 4,
      paddingTop: 4,
      paddingBottom: 4,
      paddingLeft: 8,
      paddingRight: 14,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: 10,
      backgroundColor: colors.surface2,
    },
    words: { flexDirection: "row", alignItems: "baseline", gap: 10 },
    name: { fontSize: texChatType.bubble, fontWeight: "600", color: colors.text },
    status: { flexDirection: "row", alignItems: "center", gap: 6 },
    dot: { width: 7, height: 7, borderRadius: 3.5 },
    statusText: { fontSize: texChatType.status, color: colors.muted },
  });
