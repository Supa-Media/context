import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Button } from "../../../design/components/Button";
import { Icon } from "../../../design/components/Icon";
import { Text } from "../../../design/components/Text";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { space } from "../../../design/tokens";
import { UNREADABLE_BODY, UNREADABLE_FOOT, UNREADABLE_TITLE } from "../../files/unreadable";
import { DocumentPage } from "./DocumentPage";

/**
 * A note that is in storage and can't be opened right now (Board 6), drawn
 * where the note would be. There is no editor under it: the read never put
 * one there, so nothing can be typed or saved over the file.
 */
export function UnreadableNote({
  onRetry,
  pathBar,
  notices,
}: {
  onRetry: () => void;
  pathBar?: ReactNode;
  notices?: ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <DocumentPage>
      {pathBar}
      {notices}
      <View style={styles.page} role="alert" testID="note-unreadable">
        <View style={styles.titleRow}>
          <Icon name="lock" size={16} color={colors.warnText} />
          <Text variant="rowTitle" role="heading" aria-level={2} style={styles.title}>
            {UNREADABLE_TITLE}
          </Text>
        </View>
        <Text variant="paneSub">{UNREADABLE_BODY}</Text>
        <View style={styles.actions}>
          <Button label="Try again" onPress={onRetry} testID="note-unreadable-retry" />
        </View>
        <Text variant="meta" style={styles.foot}>
          {UNREADABLE_FOOT}
        </Text>
      </View>
    </DocumentPage>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    page: { paddingVertical: space.x6, gap: space.x2, maxWidth: 520 },
    titleRow: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    title: { color: colors.text, flexShrink: 1 },
    actions: { flexDirection: "row", gap: space.x2, marginTop: space.x2 },
    foot: { marginTop: space.x2 },
  });
