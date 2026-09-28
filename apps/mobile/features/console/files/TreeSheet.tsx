import { useEffect, useMemo, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FocusRing } from "../../design/components/FocusRing";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { radii } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors, type Shadows } from "../../design/theme";
import type { FileBrowser } from "./browser";
import { relabelled } from "./linkedTitle";
import { buildTreeRows, type TreeRow } from "./tree";

/**
 * The whole tree, on a phone: what the bar's folder key opens.
 *
 * Owner-approved on 2026-09-28 (phone bottom bar artboard, option B). The
 * folder key used to open the folder page of the note on screen — a folder
 * glyph that meant "up a level", which the breadcrumb's segments already do,
 * and which dimmed on a workspace's own page. A phone had no way to see the
 * tree without leaving the note. Now the key opens this sheet, is never
 * dimmed, and the breadcrumb keeps "up".
 *
 * **The desktop tree's rows, not a second tree.** `buildTreeRows` over the
 * browser's own `listings` and `expanded`, the same call `Explorer` makes, so
 * a folder opened here is open in the sidebar, and the homepage (the console's
 * own frame) draws its site's pages the same way. What differs is the row: 44
 * points tall for a thumb, where the sidebar's 28 is a pointer's, and no drag,
 * row menu or hover control, which are pointer instruments.
 *
 * A tap on a note opens it and puts the sheet away; a tap on a folder opens or
 * shuts it in place, the way a tree does, so finding a note deep down is a few
 * taps in one sheet rather than a page per level.
 */

/** The folders to open so the note on screen is a row, not a collapsed branch. */
export function foldersToReveal(selectedPath: string | null, expanded: ReadonlySet<string>): string[] {
  if (selectedPath === null) return [];
  const folders: string[] = [];
  for (let at = selectedPath; at.includes("/"); ) {
    at = at.slice(0, at.lastIndexOf("/"));
    if (!expanded.has(at)) folders.unshift(at);
  }
  return folders;
}

/** What a tap on a row does: open the note and close the sheet, or fold a folder. */
export function treeSheetTap(row: Pick<TreeRow, "kind" | "path">): "open" | "toggle" | null {
  if (row.kind === "file") return "open";
  if (row.kind === "folder") return "toggle";
  return null;
}

export function TreeSheet({
  files,
  title,
  onDismiss,
}: {
  files: FileBrowser;
  /** The workspace's name, over the tree. */
  title: string;
  onDismiss: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();

  // Open the branch the note on screen is in, once, as the sheet rises.
  const revealed = useRef(false);
  useEffect(() => {
    if (revealed.current) return;
    revealed.current = true;
    for (const folder of foldersToReveal(files.selectedPath, files.expanded)) files.toggleFolder(folder);
  }, [files]);

  const rows = useMemo(
    () =>
      relabelled(
        buildTreeRows({ listings: files.listings, expanded: files.expanded, selectedPath: files.selectedPath }),
        files.titleEdit,
      ),
    [files.listings, files.expanded, files.selectedPath, files.titleEdit],
  );

  return (
    <Modal transparent animationType="slide" visible onRequestClose={onDismiss}>
      <Pressable style={styles.scrim} accessibilityLabel="Close files" onPress={onDismiss}>
        {/* Swallow presses inside the sheet so only the scrim dismisses it. */}
        <Pressable
          style={[styles.sheet, { paddingBottom: insets.bottom + 12 }]}
          onPress={() => {}}
          accessibilityLabel="Files"
          testID="tree-sheet"
        >
          <View style={styles.grabber} aria-hidden />
          <Text variant="railHead" role="heading" aria-level={2} style={styles.sheetHead} numberOfLines={1}>
            {title}
          </Text>
          <ScrollView
            style={styles.list}
            contentContainerStyle={styles.listContent}
            role="tree"
            aria-label="Folders and notes"
          >
            {rows.map((row) => (
              <TreeSheetRow
                key={row.key}
                row={row}
                onPress={() => {
                  const tap = treeSheetTap(row);
                  if (tap === "toggle") files.toggleFolder(row.path);
                  if (tap === "open" && files.select(row.path) !== false) onDismiss();
                }}
              />
            ))}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function TreeSheetRow({ row, onPress }: { row: TreeRow; onPress: () => void }) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const [focused, setFocused] = useState(false);
  const indent = { paddingLeft: 10 + row.depth * 16 };

  if (row.kind === "loading" || row.kind === "empty") {
    return (
      <Text variant="rowSub" style={[styles.placeholder, indent]}>
        {row.label}
      </Text>
    );
  }

  const folder = row.kind === "folder";
  return (
    <Pressable
      role="treeitem"
      aria-expanded={folder ? row.expanded : undefined}
      accessibilityLabel={folder ? `${row.label}, folder` : row.label}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={[styles.row, indent, row.selected && styles.rowCurrent]}
      testID={`tree-sheet-${row.path}`}
    >
      <Icon
        name={folder ? (row.expanded ? "chevronDown" : "chevronRight") : "file"}
        size={folder ? 14 : 16}
        color={row.selected ? colors.accent : colors.muted}
      />
      <Text variant="rowTitle" numberOfLines={1} style={styles.rowText}>
        {row.label}
      </Text>
      <FocusRing visible={focused} radius={radii.md} />
    </Pressable>
  );
}

/** `RecentSheet`'s geometry: the phone's sheets are one kind of object. */
const makeStyles = (colors: Colors, shadows: Shadows) =>
  StyleSheet.create({
    scrim: {
      flexGrow: 1,
      justifyContent: "flex-end",
      backgroundColor: "rgba(0,0,0,0.55)",
    },
    sheet: {
      paddingTop: 8,
      paddingHorizontal: 12,
      borderTopLeftRadius: radii.floating,
      borderTopRightRadius: radii.floating,
      borderTopWidth: 1,
      borderTopColor: colors.lineStrong,
      backgroundColor: colors.surface,
      maxHeight: "75%",
      boxShadow: shadows.rising,
    },
    grabber: {
      alignSelf: "center",
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.lineStrong,
      marginBottom: 10,
    },
    sheetHead: {
      paddingHorizontal: 4,
      paddingBottom: 6,
    },
    list: {
      flexGrow: 0,
      flexShrink: 1,
    },
    listContent: {
      gap: 2,
      paddingBottom: 4,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      minHeight: 44,
      paddingVertical: 6,
      paddingRight: 10,
      borderRadius: radii.md,
    },
    rowCurrent: {
      backgroundColor: colors.accentDim,
    },
    rowText: {
      flexGrow: 1,
      flexShrink: 1,
    },
    placeholder: {
      minHeight: 32,
      paddingVertical: 6,
    },
  });
