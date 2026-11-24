import { Pressable, StyleSheet, View, type ViewStyle } from "react-native";

import { Icon, type IconName } from "../design/components/Icon";
import { Text } from "../design/components/Text";
import { fonts, motion, pointerType, radii, touchType } from "../design/tokens";
import { useReducedMotion } from "../design/useReducedMotion";
import { useColors, useThemedStyles, type Colors } from "../design/theme";
import type { CreateRow } from "./files/createSheet";
import { baseName, folderLabel } from "./files/paths";

/**
 * What the `+` offers, drawn once for both of its surfaces: the corner's
 * popover at a pointer density (`CreateButton`) and the phone's bottom sheet
 * (`CreatePrompt`).
 *
 * It was a menu of five rows, each a label and a sentence under it, and the
 * owner called it wordy (Dev, 2026-11-24: "make it a little bit more cleaner
 * and intuitive and maybe more fun"). So the recording is one wide button on
 * top, because it starts something rather than making a file, and the four
 * files are tiles with a coloured mark and one word each. Where they land is
 * said once, under the tiles, instead of on every row.
 *
 * The accessible names stay the full verbs ("New note"), because a tile that
 * says "Note" is a noun to a screen reader.
 */

/** What each row is called to assistive tech, and the word on its tile. */
export const CREATE_LABELS: Record<CreateRow, string> = {
  "resume-meeting": "Resume meeting",
  "new-meeting": "New meeting",
  "new-note": "New note",
  "new-drawing": "New drawing",
  "new-sheet": "New table",
  "new-folder": "New folder",
};

const TILE_WORDS: Partial<Record<CreateRow, string>> = {
  "new-note": "Note",
  "new-sheet": "Table",
  "new-drawing": "Drawing",
  "new-folder": "Folder",
};

const TILE_ICONS: Partial<Record<CreateRow, IconName>> = {
  "new-note": "file",
  "new-sheet": "table",
  "new-drawing": "pencil",
  "new-folder": "folder",
};

/** The tile order: the two most made first. */
const TILE_ORDER: CreateRow[] = ["new-note", "new-sheet", "new-drawing", "new-folder"];

function tone(colors: Colors, row: CreateRow): { mark: string; wash: string } {
  switch (row) {
    case "new-note":
      return { mark: colors.accent, wash: colors.accentDim };
    case "new-sheet":
      return { mark: colors.ok, wash: colors.okWash };
    case "new-drawing":
      return { mark: colors.warn, wash: colors.warnWash };
    default:
      return { mark: colors.chromeMuted, wash: colors.chipFill };
  }
}

/** Where a file made from here lands, in a few words. */
export function landsIn(folder: string): string {
  return folder === "" ? "Goes at the top of your workspace" : `Goes in ${folderLabel(baseName(folder))}`;
}

export function CreateChoices({
  rows,
  folder,
  resumeDetail,
  touch,
  onChoose,
}: {
  /** From `createRows`, or the corner's fixed list. */
  rows: readonly CreateRow[];
  /** Where a file lands. Absent when no file row is offered. */
  folder?: string;
  /** Which meeting Resume carries on. */
  resumeDetail?: string;
  /** The phone's sheet: larger marks and the touch type scale, four tiles in a row. */
  touch: boolean;
  onChoose: (row: CreateRow) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const scale = touch ? touchType : pointerType;
  const tiles = TILE_ORDER.filter((row) => rows.includes(row));
  const mark = touch ? 44 : 36;
  const reduced = useReducedMotion();

  return (
    <View style={styles.stack} testID="create-choices">
      {rows.includes("resume-meeting") ? (
        <Pressable
          role="menuitem"
          accessibilityLabel={CREATE_LABELS["resume-meeting"]}
          testID="create-row-resume-meeting"
          onPress={() => onChoose("resume-meeting")}
          style={({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => [
            styles.wide,
            { backgroundColor: colors.accentDim },
            (hovered || pressed) && styles.wideHot,
          ]}
        >
          <View style={[styles.round, { width: mark, height: mark, backgroundColor: colors.accent }]}>
            <Icon name="play" size={touch ? 20 : 17} color={colors.surface} />
          </View>
          <View style={styles.words}>
            <Text style={[styles.title, { fontSize: scale.lede }]}>Resume meeting</Text>
            {resumeDetail === undefined ? null : (
              <Text numberOfLines={1} style={[styles.sub, { fontSize: touch ? pointerType.lede : pointerType.ui }]}>
                {resumeDetail}
              </Text>
            )}
          </View>
        </Pressable>
      ) : null}

      {rows.includes("new-meeting") ? (
        <Pressable
          role="menuitem"
          accessibilityLabel={CREATE_LABELS["new-meeting"]}
          testID="create-row-new-meeting"
          onPress={() => onChoose("new-meeting")}
          style={({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => [
            styles.wide,
            { backgroundColor: colors.critWash },
            (hovered || pressed) && styles.wideHot,
          ]}
        >
          <View style={[styles.round, { width: mark, height: mark, backgroundColor: colors.crit }]}>
            <Icon name="mic" size={touch ? 20 : 17} color={colors.surface} />
          </View>
          <View style={styles.words}>
            <Text style={[styles.title, { fontSize: scale.lede }]}>Record a meeting</Text>
            <Text style={[styles.sub, { fontSize: touch ? pointerType.lede : pointerType.ui }]}>Lands in your inbox</Text>
          </View>
        </Pressable>
      ) : null}

      {tiles.length === 0 ? null : (
        <View style={styles.grid}>
          {tiles.map((row) => {
            const { mark: ink, wash } = tone(colors, row);
            return (
              <Pressable
                key={row}
                role="menuitem"
                accessibilityLabel={CREATE_LABELS[row]}
                testID={`create-row-${row}`}
                onPress={() => onChoose(row)}
                style={({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => [
                  styles.tile,
                  touch ? styles.tileTouch : styles.tilePointer,
                  !reduced && LIFT,
                  hovered && !reduced && styles.tileHover,
                  hovered && reduced && styles.tileHoverStill,
                  pressed && styles.tilePressed,
                ]}
              >
                <View style={[styles.square, { width: mark - 2, height: mark - 2, backgroundColor: wash }]}>
                  <Icon name={TILE_ICONS[row]!} size={touch ? 20 : 18} color={ink} />
                </View>
                <Text style={[styles.title, { fontSize: pointerType.lede }]}>{TILE_WORDS[row]}</Text>
              </Pressable>
            );
          })}
        </View>
      )}

      {tiles.length === 0 || folder === undefined ? null : (
        <Text style={[styles.where, { fontSize: touch ? pointerType.ui : pointerType.meta }]} testID="create-lands-in">
          {landsIn(folder)}
        </Text>
      )}
    </View>
  );
}

/** A tile lifts a little under the pointer: a web transition, which React Native's types do not list. */
const LIFT = { transition: `transform 120ms ${motion.ease}, background-color 120ms ${motion.ease}` } as unknown as ViewStyle;

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    stack: { gap: 8 },
    wide: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingVertical: 10,
      paddingHorizontal: 12,
      borderRadius: radii.xl,
      cursor: "pointer",
    },
    wideHot: { opacity: 0.86 },
    round: { borderRadius: radii.pill, alignItems: "center", justifyContent: "center" },
    words: { flexShrink: 1, gap: 1 },
    title: { fontFamily: fonts.body, fontWeight: "600", color: colors.text },
    sub: { fontFamily: fonts.body, color: colors.muted },
    grid: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
    tile: {
      borderRadius: radii.xl,
      backgroundColor: colors.surface2,
      cursor: "pointer",
    },
    // Two by two in the popover: each tile half the row, less the gap.
    tilePointer: { width: "48.5%", flexGrow: 1, alignItems: "flex-start", gap: 10, padding: 12 },
    // Four in a row on the phone, centred like an app grid.
    tileTouch: { borderRadius: radii.control, flexBasis: 0, flexGrow: 1, alignItems: "center", gap: 8, paddingVertical: 12, paddingHorizontal: 4 },
    tileHover: { backgroundColor: colors.surface3, transform: [{ translateY: -2 }] },
    tileHoverStill: { backgroundColor: colors.surface3 },
    tilePressed: { backgroundColor: colors.surface3, transform: [{ scale: 0.97 }] },
    square: { borderRadius: radii.xl, alignItems: "center", justifyContent: "center" },
    where: { fontFamily: fonts.body, color: colors.muted, paddingHorizontal: 6, paddingTop: 2 },
  });
