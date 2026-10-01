/**
 * Picking several rows of a folder page on a phone, and acting on them as one.
 *
 * The owner's phone artboards (2026-09-27, screen 7) give a folder page a
 * "Select" button in its header and make a long press on a row the shortcut
 * into the same mode. A phone has no file tree — and so none of the tree's
 * ⌘-click or shift-click multi-selection — so without this a phone could only
 * ever move, archive or delete one note at a time.
 *
 * **It invents no operation.** What the picked rows can do is exactly what the
 * tree's multi-selection offers: "Actions" hands them to
 * `FolderMenu.onSelection`, which builds `menu.ts`'s items for a `selection`
 * target, and a choice runs through `runMenuAction` — rename and the row's
 * other verbs for one row, move, archive or restore, and delete for several.
 * A selection of one is that row, by `menu.ts`'s own rule.
 *
 * **Every target is a real 44pt box.** `hitSlop` is inert on
 * react-native-web, which is where a phone browser draws this, so the bar's
 * buttons are padded to the touch floor rather than slopped to it.
 */

import { useCallback, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { PressRow } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { layout, radii, space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import type { FileEntry } from "./types";

export interface FolderSelection {
  /** In the mode at all. */
  selecting: boolean;
  /** Whether a row is picked, or `undefined` outside the mode. */
  pickedOf: (path: string) => boolean | undefined;
  /** The picked rows, in listing order, dropping any that have gone. */
  picked: FileEntry[];
  /** Enter the mode, optionally with one row already picked. */
  start: (path?: string) => void;
  toggle: (path: string) => void;
  /** Pick every row, or none when every one is picked already (board 16's "Select all"). */
  toggleAll: () => void;
  /** Every row on the page is picked. */
  all: boolean;
  done: () => void;
}

export function useFolderSelection(rows: readonly FileEntry[], folder: string): FolderSelection {
  const [selecting, setSelecting] = useState(false);
  const [paths, setPaths] = useState<ReadonlySet<string>>(new Set());
  /*
    Opening another folder ends the mode. The page is the same component from
    folder to folder, so without this a person who pressed Select in one would
    land in the next with every press picking instead of opening. Reset while
    rendering rather than in an effect, so the next folder never draws a frame
    in select mode.
  */
  const [shownFolder, setShownFolder] = useState(folder);
  if (shownFolder !== folder) {
    setShownFolder(folder);
    setSelecting(false);
    setPaths(new Set());
  }

  /*
    Derived from the listing rather than held: a row that was moved, archived
    or deleted by the action just taken is simply no longer picked, and the
    mode stays so the next action can be taken on what is left.
  */
  const picked = useMemo(() => rows.filter((row) => paths.has(row.path)), [rows, paths]);

  const start = useCallback((path?: string) => {
    setSelecting(true);
    setPaths(path === undefined ? new Set() : new Set([path]));
  }, []);
  const toggle = useCallback((path: string) => {
    setPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);
  const all = rows.length > 0 && picked.length === rows.length;
  const toggleAll = useCallback(() => {
    setPaths(all ? new Set() : new Set(rows.map((row) => row.path)));
  }, [all, rows]);
  const done = useCallback(() => {
    setSelecting(false);
    setPaths(new Set());
  }, []);

  return {
    selecting,
    pickedOf: (path) => (selecting ? paths.has(path) : undefined),
    picked,
    start,
    toggle,
    toggleAll,
    all,
    done,
  };
}

/**
 * The line above the listing: "Select" outside the mode; the count, Actions
 * and Done inside it.
 */
export function FolderSelectBar({
  selection,
  onActions,
  actionsBelow = false,
}: {
  selection: FolderSelection;
  /** Open the tree's selection menu over the picked rows. */
  onActions: (rows: FileEntry[]) => void;
  /**
   * The picked rows' actions are on the bottom bar (board 16), and the way in
   * is the folder's ••• or a long press: so no Select button, and the line
   * in the mode is Cancel, the count, and Select all.
   */
  actionsBelow?: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  if (actionsBelow) {
    if (!selection.selecting) return null;
    return (
      <View style={styles.bar}>
        <PressRow
          accessibilityLabel="Cancel"
          onPress={selection.done}
          style={styles.button}
          hoverStyle={styles.hover}
          testID="folder-select-done"
        >
          <Text variant="body" style={styles.label}>
            Cancel
          </Text>
        </PressRow>
        <Text variant="paneSub" style={[styles.spacer, styles.middle]} testID="folder-select-count" aria-live="polite">
          {`${selection.picked.length} selected`}
        </Text>
        <PressRow
          accessibilityLabel={selection.all ? "Deselect all" : "Select all"}
          onPress={selection.toggleAll}
          style={styles.button}
          hoverStyle={styles.hover}
          testID="folder-select-all"
        >
          <Text variant="body" style={styles.label}>
            {selection.all ? "Deselect all" : "Select all"}
          </Text>
        </PressRow>
      </View>
    );
  }
  if (!selection.selecting) {
    return (
      <View style={styles.bar}>
        <View style={styles.spacer} />
        <PressRow
          accessibilityLabel="Select several"
          onPress={() => selection.start()}
          style={styles.button}
          hoverStyle={styles.hover}
          testID="folder-select"
        >
          <Text variant="body" style={styles.label}>
            Select
          </Text>
        </PressRow>
      </View>
    );
  }
  const count = selection.picked.length;
  return (
    <View style={styles.bar}>
      <Text variant="paneSub" style={styles.spacer} testID="folder-select-count" aria-live="polite">
        {`${count} selected`}
      </Text>
      {count === 0 ? null : (
        <PressRow
          accessibilityLabel={`Actions for ${count} selected`}
          onPress={() => onActions(selection.picked)}
          style={styles.button}
          hoverStyle={styles.hover}
          testID="folder-select-actions"
        >
          <Text variant="body" style={styles.label}>
            Actions
          </Text>
        </PressRow>
      )}
      <PressRow
        accessibilityLabel="Done selecting"
        onPress={selection.done}
        style={styles.button}
        hoverStyle={styles.hover}
        testID="folder-select-done"
      >
        <Text variant="body" style={styles.label}>
          Done
        </Text>
      </PressRow>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", gap: space.x1 },
  spacer: { flexGrow: 1, flexShrink: 1, color: colors.muted },
  /** The touch floor as real padding — see the file header. */
  button: {
    minHeight: layout.minTouchTarget,
    minWidth: layout.minTouchTarget,
    paddingHorizontal: space.x3,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.md,
  },
  hover: { backgroundColor: colors.surface3 },
  middle: { textAlign: "center", color: colors.text, fontWeight: "600" },
  label: { color: colors.accent },
});
