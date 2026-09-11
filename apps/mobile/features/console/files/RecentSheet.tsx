import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FocusRing } from "../../design/components/FocusRing";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { radii } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors, type Shadows } from "../../design/theme";
import { baseName, displayName, parentPath } from "./paths";

/**
 * Where you have been in this context, on a phone.
 *
 * ## What this replaced, and why it had to go
 *
 * This toolbar slot used to hold a **tab count** and an **Open notes** sheet —
 * mobile Safari's number-in-a-square over Obsidian's switcher. The arrangement
 * is a good one and it was unreachable here, for a reason no amount of polish
 * on the sheet could fix: **a phone had no way to open a second tab.** The only
 * verb that does it is `openInNewTab`, which `menu.ts` offers to `platform ===
 * "web"` only, on a row menu that lives in the Explorer — and `frame.ts` sets
 * `explorer: "hidden"` at compact. Every phone open went through `useTabs` as a
 * `preview`, and a new preview *replaces* the preview slot (`tabs.ts`). One in,
 * one out. The count could only ever read `1`.
 *
 * So the control's stated affordance — "the number is the only thing on the
 * toolbar that changes as you work" — was false, its sheet had one row, and its
 * × was a no-op you could watch: closing the last tab leaves `activePath` null,
 * and a tab set has no opinion about navigation, so the note stayed on screen.
 * The one path to a second row was an accident: typing into a note pins its tab,
 * so "Open notes" on a phone meant *notes you happened to edit this session*.
 *
 * ## Why recency rather than a fixed switcher
 *
 * The underlying mistake was two models of "which notes am I working with" on a
 * 390pt screen. The phone already had a complete one — a URL-addressed note,
 * `‹ ›`, a folder view, a breadcrumb — and tabs were a second one layered over
 * it that owned display without owning navigation.
 *
 * This is the first model, given a list. `history.ts` was already there, already
 * pure, already what `‹` and `›` read; `recentPaths` is the same array walked
 * backwards. **A tab list on a phone is empty exactly when you need it — you
 * have to have curated it first. A recents list is never empty**, because using
 * the app fills it. And "close" stops needing an explanation at all: you leave a
 * note by going back or up, which already worked.
 *
 * Desktop tabs are untouched. A strip is a pointer instrument and a pointer has
 * the middle button, the row menu and the room; `TabStrip.tsx` keeps all of it.
 */

/** Where it lives, in words. The root is a place, so it gets a name. */
function folderLabel(path: string): string {
  const folder = parentPath(path);
  return folder === "" ? "in your context root" : folder;
}

/**
 * Whether to draw this row as a folder.
 *
 * History records the *selection*, and a selection is a folder about as often as
 * it is a note — `useTabs` reads `editor.path` precisely to avoid that, and here
 * it is wanted: "back to the folder I was in" is a destination a phone reaches
 * constantly. A path is all there is to go on, so the test is whether the last
 * segment carries an extension; an attachment (`.png`) is correctly a file, and
 * a folder somebody named `v1.2` gets the wrong glyph and the right destination.
 * Kind is not passed in because the caller does not reliably have it either: a
 * recent path can sit in a folder whose listing is no longer loaded.
 */
function looksLikeFolder(path: string): boolean {
  return !/\.[^./]+$/.test(baseName(path));
}

/**
 * What a screen reader hears for one row.
 *
 * Where-you-are is a clause in the name rather than an `aria-current`, which is
 * not one of `View`'s typed accessibility props and which react-native-web has
 * form for dropping silently (see `TabStrip`'s note on `accessibilityState`).
 * The accent behind the row is the sighted half of the same fact, and a state
 * only sighted people get is not a state.
 */
export function describeRecent(path: string, current: boolean): string {
  const kind = looksLikeFolder(path) ? "folder" : "note";
  const where = `${kind} ${displayName(baseName(path))}, ${folderLabel(path)}`;
  return current ? `${where}, where you are now` : where;
}

export function RecentSheet({
  paths,
  currentPath,
  onOpen,
  onDismiss,
}: {
  /** Newest first, from `recentPaths`. */
  paths: readonly string[];
  /** The one to mark, or `null` on a folder view with no note open. */
  currentPath: string | null;
  onOpen: (path: string) => void;
  onDismiss: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();

  /**
   * A sheet with nowhere to go is a dead end — no rows to press, and the only
   * way out a scrim somebody has to guess at.
   *
   * An effect on the *list* rather than a check inside the press handler, so it
   * also covers the list emptying underneath an open sheet: a context switch
   * clears the history (`clearedHistory`), and the sheet is mounted above the
   * route that does it.
   */
  useEffect(() => {
    if (paths.length === 0) onDismiss();
  }, [paths.length, onDismiss]);

  return (
    <Modal transparent animationType="slide" visible onRequestClose={onDismiss}>
      <Pressable style={styles.scrim} accessibilityLabel="Close recent" onPress={onDismiss}>
        {/* Swallow presses inside the sheet so only the scrim dismisses it. */}
        <Pressable
          style={[styles.sheet, { paddingBottom: insets.bottom + 12 }]}
          onPress={() => {}}
          accessibilityLabel="Recent"
          testID="recent-sheet"
        >
          <View style={styles.grabber} aria-hidden />
          <Text variant="railHead" role="heading" aria-level={2} style={styles.sheetHead}>
            Recent
          </Text>

          <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
            {paths.map((path) => (
              <RecentRow
                key={path}
                path={path}
                current={path === currentPath}
                onPress={() => onOpen(path)}
              />
            ))}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/**
 * One place in the sheet.
 *
 * A single target, unlike the switcher row this replaces — there is no × here,
 * because there is nothing to close. That is the point of the change rather
 * than a simplification of it: the switcher's × was the control that did
 * nothing, and a recents list has no state a person has to tidy up.
 */
function RecentRow({
  path,
  current,
  onPress,
}: {
  path: string;
  current: boolean;
  onPress: () => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const [focused, setFocused] = useState(false);

  return (
    <Pressable
      role="button"
      accessibilityLabel={describeRecent(path, current)}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={[styles.row, current && styles.rowCurrent]}
      testID={`recent-${path}`}
    >
      <Icon
        name={looksLikeFolder(path) ? "folder" : "file"}
        size={17}
        color={current ? colors.accent : colors.muted}
      />
      <View style={styles.rowText}>
        <Text variant="rowTitle" numberOfLines={1}>
          {displayName(baseName(path))}
        </Text>
        <Text variant="rowSub" numberOfLines={1}>
          {folderLabel(path)}
        </Text>
      </View>
      <FocusRing visible={focused} radius={radii.md} />
    </Pressable>
  );
}

const makeStyles = (colors: Colors, shadows: Shadows) => StyleSheet.create({
  scrim: {
    flexGrow: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.55)",
  },

  /**
   * The same geometry the action sheet uses — `radii.floating` and
   * `shadows.rising`, not the panel radius and a hairline.
   *
   * Two sheets rising from the same edge of the same phone, drawn with
   * different corners and one of them without a shadow, read as two different
   * kinds of object. They are not: both are "a list of things, over the note,
   * with a grabber". `Menu.tsx` is the other one.
   */
  sheet: {
    paddingTop: 8,
    paddingHorizontal: 12,
    borderTopLeftRadius: radii.floating,
    borderTopRightRadius: radii.floating,
    borderTopWidth: 1,
    borderTopColor: colors.lineStrong,
    backgroundColor: colors.surface,
    maxHeight: "70%",
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
    paddingHorizontal: 10,
    borderRadius: radii.md,
  },

  rowCurrent: {
    backgroundColor: colors.accentDim,
  },

  rowText: {
    flexGrow: 1,
    flexShrink: 1,
  },
});
