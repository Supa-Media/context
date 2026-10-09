/**
 * A folder's whole about note in a sheet from the bottom: what Read more
 * opens where the side panel has no room — a phone, a narrow window
 * (`AboutBlock.tsx`). The words are read here; Open as note goes to the
 * note's own page, where they are edited. A close button as well as the
 * scrim, since a swipe alone is out of reach of a screen reader.
 */

import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Button } from "../../../design/components/Button";
import { Icon } from "../../../design/components/Icon";
import { Text } from "../../../design/components/Text";
import { radii, space } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import type { FolderListSource } from "../listBlock/model";
import { PanelBody } from "./panel/PanelBody";

export function AboutSheet({
  path,
  title,
  source,
  onOpenNote,
  onClose,
}: {
  path: string;
  title: string;
  source: FolderListSource | undefined;
  /** The note's own page. */
  onOpenNote: (path: string) => void;
  onClose: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [width, setWidth] = useState(0);
  return (
    <Modal transparent visible animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.scrim} accessibilityLabel="Close" onPress={onClose}>
        <Pressable onPress={() => {}} style={styles.sheet} role="dialog" aria-modal accessibilityLabel={`About ${title}`} testID="about-sheet">
          <View style={styles.handle} />
          <View style={styles.head}>
            <Text variant="paneTitle" numberOfLines={1} style={styles.title}>
              {`About ${title}`}
            </Text>
            <Pressable onPress={onClose} role="button" accessibilityLabel="Close" style={styles.close} testID="about-sheet-close">
              <Icon name="close" size={16} color={colors.text2} />
            </Pressable>
          </View>
          <ScrollView style={styles.scroll} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
            <PanelBody
              source={source}
              path={path}
              title={title}
              width={width > 0 ? width : 340}
              onOpenNote={(to) => {
                onClose();
                onOpenNote(to);
              }}
            />
          </ScrollView>
          <Button
            label="Open as note"
            variant="dialogPrimary"
            onPress={() => {
              onClose();
              onOpenNote(path);
            }}
            style={styles.open}
            testID="about-sheet-open"
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    scrim: { flex: 1, backgroundColor: colors.scrim, justifyContent: "flex-end" },
    sheet: {
      maxHeight: "85%",
      paddingHorizontal: space.x4,
      paddingTop: space.x2,
      paddingBottom: space.x6,
      gap: space.x3,
      borderTopLeftRadius: radii.floating,
      borderTopRightRadius: radii.floating,
      borderTopWidth: 1,
      borderColor: colors.lineStrong,
      backgroundColor: colors.surface2,
    },
    handle: { alignSelf: "center", width: 40, height: 5, borderRadius: 3, backgroundColor: colors.lineStrong },
    head: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    title: { flexShrink: 1, flexGrow: 1, color: colors.text },
    close: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 22 },
    scroll: { flexGrow: 0, flexShrink: 1 },
    open: { alignSelf: "stretch", minHeight: 48, justifyContent: "center" },
  });
