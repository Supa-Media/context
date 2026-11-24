import { Pressable, StyleSheet, View } from "react-native";

import { Icon, type IconName } from "../design/components/Icon";
import { Text } from "../design/components/Text";
import { radii, space } from "../design/tokens";
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
 * and intuitive and maybe more fun"). So the recording is one row on top,
 * because it starts something rather than making a file, and the four files
 * are tiles of an icon and one word. Where they land is said once, under the
 * tiles, instead of on every row.
 *
 * **It is drawn in the menu's own language** (`MenuRow`, `Menu.web.tsx`): the
 * same panel, type roles, muted icons and accent-wash highlight. A first cut
 * gave each tile a status colour and the meeting a red button, and the owner
 * said it looked like a different design system: status colours here mean
 * status, and brand blue means live or yours, so neither is decoration.
 *
 * The accessible names stay the full verbs ("New note"), because a tile that
 * says "Note" is a noun to a screen reader.
 */

/** What each row is called to assistive tech. */
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

/** Where a file made from here lands, in a few words. */
export function landsIn(folder: string): string {
  return folder === "" ? "Goes at the top of your workspace" : `Goes in ${folderLabel(baseName(folder))}`;
}

type PressState = { hovered?: boolean; pressed: boolean; focused?: boolean };

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
  /** The phone's sheet: the touch rows and type, four tiles in a row. */
  touch: boolean;
  onChoose: (row: CreateRow) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const tiles = TILE_ORDER.filter((row) => rows.includes(row));
  const lit = ({ hovered, pressed, focused }: PressState) => hovered === true || pressed || focused === true;

  const wide = (row: "resume-meeting" | "new-meeting", icon: IconName, label: string, detail: string | undefined) => (
    <Pressable
      key={row}
      role="menuitem"
      accessibilityLabel={CREATE_LABELS[row]}
      testID={`create-row-${row}`}
      onPress={() => onChoose(row)}
      style={(state: PressState) => [styles.wide, touch ? styles.wideTouch : styles.widePointer, lit(state) && styles.lit]}
    >
      {(state: PressState) => (
        <>
          <Icon name={icon} size={touch ? 20 : 16} color={lit(state) ? colors.accentText : colors.text2} />
          <View style={styles.words}>
            <Text variant={touch ? "body" : "tree"} style={styles.label}>
              {label}
            </Text>
            {detail === undefined ? null : (
              <Text variant="treeMeta" numberOfLines={1}>
                {detail}
              </Text>
            )}
          </View>
        </>
      )}
    </Pressable>
  );

  return (
    <View style={styles.stack} testID="create-choices">
      {rows.includes("resume-meeting") ? wide("resume-meeting", "play", "Resume meeting", resumeDetail) : null}
      {rows.includes("new-meeting") ? wide("new-meeting", "mic", "Record a meeting", "Lands in your inbox") : null}

      {tiles.length === 0 ? null : (
        <>
          {rows.includes("new-meeting") ? <View aria-hidden style={[styles.rule, touch && styles.ruleTouch]} /> : null}
          <View style={[styles.grid, touch && styles.gridTouch]}>
            {tiles.map((row) => (
              <Pressable
                key={row}
                role="menuitem"
                accessibilityLabel={CREATE_LABELS[row]}
                testID={`create-row-${row}`}
                onPress={() => onChoose(row)}
                style={(state: PressState) => [
                  styles.tile,
                  touch ? styles.tileTouch : styles.tilePointer,
                  lit(state) && styles.lit,
                ]}
              >
                {(state: PressState) => (
                  <>
                    <Icon name={TILE_ICONS[row]!} size={touch ? 22 : 18} color={lit(state) ? colors.accentText : colors.text2} />
                    <Text variant={touch ? "body" : "tree"} style={styles.label}>
                      {TILE_WORDS[row]}
                    </Text>
                  </>
                )}
              </Pressable>
            ))}
          </View>
          {folder === undefined ? null : (
            <Text variant="treeMeta" style={[styles.where, touch && styles.whereTouch]} testID="create-lands-in">
              {landsIn(folder)}
            </Text>
          )}
        </>
      )}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    stack: { gap: 2 },
    wide: { flexDirection: "row", alignItems: "center", gap: space.x3, cursor: "pointer" },
    // `MenuRow`'s pointer row, tall enough for its detail.
    widePointer: { paddingVertical: 6, paddingHorizontal: 10, borderRadius: radii.sm },
    // `MenuRow`'s touch row.
    wideTouch: { paddingVertical: space.x3, paddingHorizontal: space.x4, borderRadius: radii.md, backgroundColor: colors.surface2 },
    // The menu's one highlight: hover and keyboard focus look the same.
    lit: { backgroundColor: colors.accentDim },
    words: { flexShrink: 1 },
    label: { color: colors.text },
    rule: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginVertical: 4, marginHorizontal: 10 },
    ruleTouch: { marginVertical: space.x1, height: 0 },
    grid: { flexDirection: "row", flexWrap: "wrap", gap: 2 },
    gridTouch: { gap: space.x2 },
    tile: { alignItems: "center", justifyContent: "center", gap: 6, cursor: "pointer" },
    // Two by two in the popover.
    tilePointer: { width: "49%", flexGrow: 1, paddingVertical: 12, borderRadius: radii.sm },
    // Four in a row on the phone, each a well like the sheet's other rows.
    tileTouch: { flexBasis: 0, flexGrow: 1, paddingVertical: space.x3, borderRadius: radii.md, backgroundColor: colors.surface2 },
    where: { paddingHorizontal: 10, paddingTop: 4, paddingBottom: 2 },
    whereTouch: { paddingHorizontal: space.x1 },
  });
