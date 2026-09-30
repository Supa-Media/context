import { Pressable, StyleSheet, View } from "react-native";
import { Icon } from "../design/components/Icon";
import { Text } from "../design/components/Text";
import { fonts, layout, radii, space, touchType } from "../design/tokens";
import { useColors, useThemedStyles, type Colors, type Shadows } from "../design/theme";
import { targetFolder } from "./files/tree";
import type { ConsoleData } from "./types";

/** Where a quick note from Home lands (Dev2, 2026-09-30: "inbox is the default folder"). */
export const QUICK_NOTE_FOLDER = "0-inbox";

/**
 * Where the round button's note goes: the folder on screen, the folder of the
 * note on screen, and from Home — the workspace's own page — the Inbox. A
 * workspace with no Inbox gets one with its first quick note, because a
 * folder in a bucket is only the notes in it.
 */
export function quickNoteFolder(data: ConsoleData): string {
  const folder = targetFolder(data.files.listings, data.files.selectedPath);
  return folder === "" ? QUICK_NOTE_FOLDER : folder;
}

/**
 * THE PHONE'S BOTTOM BAR IS APPLE NOTES' BAR: SEARCH, AND A NEW NOTE.
 *
 * Approved by the owner on 2026-09-30 (the mobile Home artboards), replacing
 * the five keys of 2026-09-27 — Back, Browse, Search, New and Recent — on
 * every phone screen. A full-width search field with a microphone, within
 * thumb reach, and the round compose button beside it:
 *
 *  - **Back** is the path bar's, at the top left of every inner screen, and
 *    the system's own back gesture.
 *  - **Browse** and **Recent** are Home: it lists every folder, what you open
 *    most and your recent notes, so a key for each was a second copy of it.
 *  - **New** is the round button, and it makes a note at once, in the folder
 *    you are in — from Home, in the Inbox. Held, it raises the sheet with
 *    everything else a `+` can start (a drawing, a folder, a meeting), so
 *    none of those lost their only route on a phone.
 *
 * The microphone opens search the way the field does: iOS and Android both
 * dictate into any focused field from the keyboard's own microphone key, which
 * is the one this points at (see `features/voice/engine.ts` for why the app
 * does not grow a second dictation engine).
 *
 * The bar's room is `AppFrame`'s bottom slot, as it was; this draws what is in
 * it and decides nothing about whether it shows.
 */
export function ConsoleBottomBar({
  data,
  onSearch,
  onCreate,
}: {
  data: ConsoleData;
  onSearch: () => void;
  /**
   * Raises the create sheet for a destination — see the `new` action. `null`
   * where that sheet would have no rows at all (`files/createSheet.ts`).
   */
  onCreate: ((folder: string) => void) | null;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const folder = quickNoteFolder(data);
  // A reader cannot write a note; the round button is then only the sheet, if that has rows.
  const canNote = data.files.canEdit;

  return (
    <View style={styles.bar} testID="notes-bar" role="toolbar" aria-label="Search and new note">
      <View style={styles.field}>
        <Pressable
          onPress={onSearch}
          accessibilityRole="button"
          accessibilityLabel="Search notes"
          style={({ pressed }) => [styles.fieldPress, pressed ? styles.fieldPressed : null]}
          testID="notes-bar-search"
        >
          <Icon name="search" size={18} color={colors.muted} />
          <Text style={styles.placeholder} numberOfLines={1}>
            Search
          </Text>
        </Pressable>
        <Pressable
          onPress={onSearch}
          accessibilityRole="button"
          accessibilityLabel="Search by voice"
          accessibilityHint="Opens search; your keyboard's microphone key types what you say"
          style={({ pressed }) => [styles.mic, pressed ? styles.fieldPressed : null]}
        >
          <Icon name="mic" size={18} color={colors.text2} />
        </Pressable>
      </View>
      {!canNote && onCreate === null ? null : (
        <Pressable
          onPress={canNote ? () => data.files.createUntitled(folder, "note") : () => onCreate?.(folder)}
          onLongPress={onCreate === null ? undefined : () => onCreate(folder)}
          accessibilityRole="button"
          accessibilityLabel={canNote ? "New note" : "Create"}
          accessibilityHint={canNote && onCreate !== null ? "Hold for a drawing, a folder or a meeting" : undefined}
          style={({ pressed }) => [styles.compose, pressed ? styles.composePressed : null]}
          testID="notes-bar-compose"
        >
          <Icon name="compose" size={22} color={colors.ink} />
        </Pressable>
      )}
    </View>
  );
}

const FIELD_HEIGHT = 50;

const makeStyles = (colors: Colors, shadows: Shadows) =>
  StyleSheet.create({
    bar: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      height: layout.bottomBarHeight,
      paddingHorizontal: space.x1,
    },
    field: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      height: FIELD_HEIGHT,
      borderRadius: radii.pill,
      overflow: "hidden",
      backgroundColor: colors.pageSurface,
      boxShadow: shadows.floating,
    },
    fieldPress: {
      flex: 1,
      alignSelf: "stretch",
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      paddingLeft: space.x4,
    },
    fieldPressed: { backgroundColor: colors.surface2 },
    placeholder: { flex: 1, fontFamily: fonts.body, fontSize: touchType.ui, color: colors.muted },
    mic: { width: 48, alignSelf: "stretch", alignItems: "center", justifyContent: "center" },
    compose: {
      width: FIELD_HEIGHT + 2,
      height: FIELD_HEIGHT + 2,
      borderRadius: radii.pill,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.accent,
      boxShadow: shadows.floating,
    },
    composePressed: { opacity: 0.8 },
  });
