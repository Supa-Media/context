import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FocusRing } from "../../design/components/FocusRing";
import { Text } from "../../design/components/Text";
import { colors, radii } from "../../design/tokens";
import { baseName, parentPath } from "./paths";
import { dirtyCount, type Tab, type TabsState } from "./tabs";

/**
 * Tabs on a phone: a count button, and a sheet.
 *
 * A strip is a pointer instrument. It assumes a hover state to reveal a close
 * button, a horizontal scroll nobody minds, and targets a few pixels wide. None
 * of those survive a thumb, and shrinking a strip until it does produces a row
 * of tabs too narrow to read and too small to hit — the worst of both.
 *
 * So the phone gets Obsidian's arrangement instead, which is the one people
 * coming to this product most likely already use: a **tab-count button** in the
 * bottom toolbar, borrowing mobile Safari's and Chrome's number-in-a-square, and
 * a sheet listing what is open. The number is the affordance — it is the only
 * thing on the toolbar that changes as you work, which is what makes it findable
 * without a label.
 *
 * `TabStrip.tsx` is the pointer half. Both read the same `TabsState` and neither
 * decides anything: every rule about what closing or activating a tab *does*
 * lives in `tabs.ts`.
 */

/**
 * The name and the folder, as two lines.
 *
 * Not `tabLabel`, on purpose. `tabLabel` folds the folder into the name when two
 * open tabs collide, because a strip has one line to work with. A sheet row has
 * two, and it shows the folder for *every* row — which both disambiguates the
 * collision case and answers "where does this one live" the rest of the time, so
 * qualifying the name as well would print the folder twice on the same row.
 */
function noteName(path: string): string {
  return baseName(path).replace(/\.md$/i, "");
}

/** Where it lives, in words. The root is a place, so it gets a name. */
function folderLabel(path: string): string {
  const folder = parentPath(path);
  return folder === "" ? "in your context root" : folder;
}

/**
 * What a screen reader hears.
 *
 * The unsaved count is in here rather than only in the dot because the dot is
 * the entire warning that leaving is lossy, and a warning only sighted people
 * get is not a warning. It is a separate clause rather than a second element so
 * it is announced with the button rather than after it.
 */
function describeCount(open: number, dirty: number): string {
  const notes = open === 1 ? "1 note open" : `${open} notes open`;
  if (open === 0) return "No notes open";
  if (dirty === 0) return notes;
  return `${notes}, ${dirty === 1 ? "1 with unsaved changes" : `${dirty} with unsaved changes`}`;
}

/**
 * The count, in words, for a caller that draws the control itself.
 *
 * `BottomBar` takes a flat list of actions and owns the drawing, so the tab
 * count on a phone is one of its targets rather than `TabCountButton` embedded
 * in it — but the *phrasing* has to be this file's, or there are two answers to
 * "how many notes are open, and how many are unsaved" and they can disagree.
 * Both routes end at `describeCount` and at `dirtyCount` in `tabs.ts`.
 */
export function tabCountLabel(state: TabsState): string {
  return describeCount(state.tabs.length, dirtyCount(state));
}

export function TabCountButton({
  state,
  onPress,
}: {
  state: TabsState;
  onPress: () => void;
}) {
  const open = state.tabs.length;
  const dirty = dirtyCount(state);

  return (
    <Pressable
      role="button"
      accessibilityLabel={describeCount(open, dirty)}
      onPress={onPress}
      style={styles.countHit}
      testID="tab-count"
    >
      {/*
        The square is drawn at 24pt and the *target* around it is 44 — the whole
        point of this control is that it is reachable one-handed, and a 24pt hit
        area in the corner of a toolbar is not.
      */}
      <View style={styles.countSquare}>
        <Text style={styles.countLabel}>{open}</Text>
      </View>
      {dirty > 0 ? <View style={styles.countDot} testID="tab-count-dot" /> : null}
    </Pressable>
  );
}

export function TabSwitcher({
  state,
  onActivate,
  onClose,
  onDismiss,
}: {
  state: TabsState;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
  onDismiss: () => void;
}) {
  const insets = useSafeAreaInsets();

  /**
   * An empty switcher is a dead end: no rows, nothing to activate, and the only
   * way out is a scrim press somebody has to guess at. So closing the last tab
   * closes the sheet.
   *
   * Written as an effect on the *state* rather than as an extra call inside the
   * close handler so that it also covers the tab going away for some other
   * reason while the sheet is open — a rename that resolves to nothing, a note
   * deleted from another surface, or the sheet being opened with nothing in it.
   * One condition, one place, however you got there.
   */
  useEffect(() => {
    if (state.tabs.length === 0) onDismiss();
  }, [state.tabs.length, onDismiss]);

  return (
    <Modal transparent animationType="slide" visible onRequestClose={onDismiss}>
      <Pressable style={styles.scrim} accessibilityLabel="Close open notes" onPress={onDismiss}>
        {/* Swallow presses inside the sheet so only the scrim dismisses it. */}
        <Pressable
          style={[styles.sheet, { paddingBottom: insets.bottom + 12 }]}
          onPress={() => {}}
          accessibilityLabel="Open notes"
          testID="tab-switcher"
        >
          <View style={styles.grabber} aria-hidden />
          <Text variant="railHead" role="heading" aria-level={2} style={styles.sheetHead}>
            Open notes
          </Text>

          <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
            {state.tabs.map((tab) => (
              <SwitcherRow
                key={tab.path}
                tab={tab}
                active={tab.path === state.activePath}
                onActivate={() => onActivate(tab.path)}
                onClose={() => onClose(tab.path)}
              />
            ))}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/**
 * One note in the sheet.
 *
 * Two separate targets, for the same reason the tab strip has two: 44pt of close
 * button *inside* a row that also activates is how you open the note you meant
 * to close. There is no dot/× swap here — a phone has no hover, so both are
 * drawn, side by side.
 *
 * `aria-selected` is set directly rather than through `PressRow`'s `selected`,
 * which reaches react-native-web as `accessibilityState` — a prop version 0.21
 * no longer maps to anything, so it renders no attribute at all. Silently.
 */
function SwitcherRow({
  tab,
  active,
  onActivate,
  onClose,
}: {
  tab: Tab;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
}) {
  const [focused, setFocused] = useState(false);
  const name = noteName(tab.path);

  return (
    <View style={[styles.row, active && styles.rowActive]} testID={`switch-${tab.path}`}>
      <Pressable
        role="tab"
        aria-selected={active}
        accessibilityLabel={`${tab.path}${tab.dirty ? ", unsaved changes" : ""}`}
        onPress={onActivate}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={styles.rowHit}
        testID={`switch-open-${tab.path}`}
      >
        <View style={styles.rowText}>
          <Text variant="rowTitle" numberOfLines={1}>
            {name}
          </Text>
          <Text variant="rowSub" numberOfLines={1}>
            {folderLabel(tab.path)}
          </Text>
        </View>
        {tab.dirty ? <View style={styles.rowDot} testID={`switch-dot-${tab.path}`} /> : null}
        <FocusRing visible={focused} radius={radii.md} />
      </Pressable>

      <Pressable
        role="button"
        accessibilityLabel={`Close ${name}${tab.dirty ? ", unsaved changes" : ""}`}
        onPress={onClose}
        style={styles.rowClose}
        testID={`switch-close-${tab.path}`}
      >
        <Text style={styles.closeGlyph}>×</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  countHit: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },

  countSquare: {
    minWidth: 24,
    height: 24,
    paddingHorizontal: 4,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: colors.text2,
    borderRadius: radii.xs,
  },

  countLabel: {
    fontSize: 12.5,
    lineHeight: 15,
    fontWeight: "600",
    color: colors.text2,
    fontVariant: ["tabular-nums"],
  },

  /** Sits on the corner of the square, where a badge belongs. */
  countDot: {
    position: "absolute",
    top: 8,
    right: 7,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.accent,
    borderWidth: 1.5,
    borderColor: colors.surface,
  },

  scrim: {
    flexGrow: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.55)",
  },

  sheet: {
    paddingTop: 8,
    paddingHorizontal: 12,
    borderTopLeftRadius: radii.panel,
    borderTopRightRadius: radii.panel,
    borderTopWidth: 1,
    borderTopColor: colors.lineStrong,
    backgroundColor: colors.surface,
    maxHeight: "70%",
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
    borderRadius: radii.md,
  },

  rowActive: {
    backgroundColor: colors.accentDim,
  },

  rowHit: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 44,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: radii.md,
  },

  rowText: {
    flexGrow: 1,
    flexShrink: 1,
  },

  rowDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.accent,
  },

  rowClose: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },

  closeGlyph: {
    fontSize: 19,
    lineHeight: 21,
    color: colors.muted,
  },
});
