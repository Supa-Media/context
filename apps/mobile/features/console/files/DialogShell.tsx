import type { ReactNode } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import { Text } from "../../design/components/Text";
import { radii } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";

/**
 * The console's dialog frame: a card in the middle of the window, or a sheet
 * on the bottom edge of a phone's glass. Its own file so a dialog outside
 * `Dialogs.tsx` (`NewFolderForm`) can use it without the two importing each
 * other.
 */
export function Shell({
  title,
  children,
  onClose,
  sheet = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  /**
   * Anchored to the bottom edge with only its top corners rounded, rather
   * than a card in the middle. For the phone's create menu (owner,
   * 2026-09-27, the phone artboards): its rows are a thumb's, and a thumb is
   * at the bottom of the glass.
   */
  sheet?: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose} visible>
      <Pressable
        style={[styles.scrim, sheet && styles.sheetScrim]}
        accessibilityLabel="Close"
        onPress={onClose}
      >
        {/* Swallow presses inside the card so the scrim only closes on the scrim. */}
        <Pressable
          style={[styles.card, sheet && styles.sheet]}
          onPress={() => {}}
          accessibilityLabel={title}
          testID={sheet ? "dialog-sheet" : undefined}
        >
          <Text variant="paneTitle" role="heading" aria-level={2}>
            {title}
          </Text>
          <View style={styles.body}>{children}</View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: "rgba(3,3,4,.72)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  card: {
    width: "100%",
    maxWidth: 460,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radii.card,
    backgroundColor: colors.surface2,
    paddingVertical: 22,
    paddingHorizontal: 24,
    boxShadow: "0 40px 100px -30px rgba(0,0,0,1)",
  },
  /** The scrim under a bottom sheet: the card sits on the bottom edge. */
  sheetScrim: { justifyContent: "flex-end", padding: 0 },
  /**
   * A bottom sheet: full width, flat along the edge it sits on, and paid
   * enough at the foot to clear a home indicator.
   */
  sheet: {
    maxWidth: "100%",
    borderBottomWidth: 0,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    paddingBottom: 34,
  },
  body: { marginTop: 12, gap: 12 },
});
