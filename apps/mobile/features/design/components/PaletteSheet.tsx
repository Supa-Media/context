import type { ReactNode } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { fonts, layout, leading, radii, space, touchType, tracking } from "../tokens";
import { useColors, useThemedStyles, type Colors, type Shadows } from "../theme";
import { Icon } from "./Icon";
import { Text } from "./Text";

/**
 * What a phone's search adds above the notes it finds: the "Look in" chips and
 * the folders and tags that match (boards 03 and 04). The palette keeps which
 * chip is on (`look`, "all" for none) so it resets each time search opens;
 * the caller draws the rest from it. `notes: false` hides the note rows.
 */
export interface PaletteLookIn {
  render(state: { query: string; found: number; look: string; setLook: (look: string) => void }): {
    chips: ReactNode;
    places: ReactNode;
    notes: boolean;
  };
}

/**
 * Search on a phone (boards 03 and 04 of the phone Home artboards, approved by
 * the owner on 2026-09-30): a big "Search" title, the results under it, and
 * the field at the bottom where the bottom bar's field was, so it rides up on
 * the keyboard under a thumb. The bar's quick-note button becomes an X that
 * closes search, in the same place.
 *
 * It was a sheet with the field at the top and a Cancel word beside it, which
 * put the field a thumb's reach away from the bar that opened it.
 */
export function PaletteSheet({
  field,
  onDismiss,
  children,
}: {
  field: ReactNode;
  onDismiss: () => void;
  /** Scope chips, headings, notices and the list, top to bottom. */
  children: ReactNode;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  return (
    <Modal transparent animationType="slide" visible onRequestClose={onDismiss}>
      <KeyboardAvoidingView
        /*
          The field is at the bottom now, so the keyboard would cover it: `padding`
          on iOS lifts the whole sheet's foot by the keyboard's height; Android
          resizes the window itself, and `height` cooperates with that.
        */
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={[styles.sheet, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
        testID="palette-sheet"
      >
        <Text role="heading" aria-level={1} style={styles.title}>
          Search
        </Text>
        <View style={styles.body}>{children}</View>
        <View style={styles.bar}>
          <View style={styles.field}>
            <Icon name="search" size={18} color={colors.muted} />
            {field}
          </View>
          <Pressable
            onPress={onDismiss}
            accessibilityRole="button"
            accessibilityLabel="Close search"
            style={({ pressed }) => [styles.close, pressed ? styles.pressed : null]}
            testID="palette-cancel"
          >
            <Icon name="close" size={20} color={colors.text} />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** The bottom bar's own field height (`ConsoleBottomBar`), so the two line up. */
const FIELD_HEIGHT = 50;

const makeStyles = (colors: Colors, shadows: Shadows) =>
  StyleSheet.create({
    sheet: { flex: 1, backgroundColor: colors.ground },
    title: {
      paddingHorizontal: layout.readingMargin,
      paddingTop: space.x4,
      paddingBottom: space.x2,
      fontFamily: fonts.display,
      fontSize: touchType.title,
      lineHeight: leading(touchType.title, 1.15),
      fontWeight: "700",
      letterSpacing: tracking(touchType.title, -0.02),
      color: colors.text,
    },
    body: { flex: 1 },
    bar: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      paddingHorizontal: space.x3,
      paddingVertical: space.x2,
    },
    /* A petrol ring rather than the browser's own focus outline: board 03's "soft petrol glow". */
    field: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: space.x1,
      height: FIELD_HEIGHT,
      paddingLeft: space.x4,
      borderRadius: radii.pill,
      borderWidth: 1.5,
      borderColor: colors.accent,
      backgroundColor: colors.pageSurface,
      boxShadow: shadows.floating,
    },
    close: {
      width: FIELD_HEIGHT,
      height: FIELD_HEIGHT,
      borderRadius: radii.pill,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.pageSurface,
      boxShadow: shadows.floating,
    },
    pressed: { opacity: 0.6 },
  });
