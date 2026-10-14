import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "../../../design/components/Icon";
import { Pill } from "../../../design/components/Pill";
import { Text } from "../../../design/components/Text";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { radii, touchType } from "../../../design/tokens";
import { PersonFace } from "../../faces/PersonFace";
import { relativeTime } from "../../format";
import type { FileBrowser } from "../browser";

/**
 * The open note, in the trash and still on screen (design A, Dev2 2026-10-14,
 * project file `trashed-note/`): "In trash" beside the path, Restore where
 * Share was, one quiet line under the title saying who moved it and when, and
 * the page dimmed and read-only. No tinted box around any of it — the page
 * itself says it, which is the design's whole argument.
 */
export interface TrashedView {
  byYou: boolean;
  /** "@ana", or `null` when the mover has no name to show. */
  byName: string | null;
  at: number;
  /** Put it back. Absent while there is nothing to restore from yet. */
  onRestore?: () => void;
  restoring?: boolean;
}

/** What the editor draws for the open note when it is in the trash, or `undefined` when it is not. */
export function trashedViewOf(files: Pick<FileBrowser, "editor" | "trashed" | "restoreTrashed" | "restoringTrashed">): TrashedView | undefined {
  const trashed = files.trashed ?? null;
  if (trashed === null || files.editor.path !== trashed.path) return undefined;
  return {
    byYou: trashed.byYou,
    byName: trashed.byName,
    at: trashed.at,
    // A delete still in this device's queue is taken back out of it (`useTrashedNote`).
    onRestore: trashed.trash === null && trashed.undoQueued === undefined ? undefined : files.restoreTrashed,
    restoring: files.restoringTrashed === true,
  };
}

/**
 * The path whose live room the route joins (`useNoteRoom`): the open note's,
 * or `null` while that note is in the trash. A trashed note is read-only and
 * nobody types in it here, so there is nothing to merge and nothing to say who
 * else is reading; joining its room only showed "Reconnecting" over a note the
 * room cannot find, and could replay a room's text into a page that is meant
 * to show what the trash holds. Restore clears the state and the room is
 * joined again for the note back at its name.
 */
export function roomPathOf(files: Pick<FileBrowser, "editor" | "trashed">): string | null {
  const path = files.editor.path;
  return path !== null && files.trashed?.path === path ? null : path;
}

/** How often "2 minutes ago" is worked out again while the note is on screen. */
const TICK_MS = 30_000;

/** "You moved this to trash · just now", "@ana moved this to trash · 3 minutes ago". */
export function trashedLine(trashed: Pick<TrashedView, "byYou" | "byName" | "at">, now: number): { who: string; rest: string } {
  const who = trashed.byYou ? "You" : (trashed.byName ?? "Someone");
  return { who, rest: ` moved this to trash · ${relativeTime(trashed.at, now)}` };
}

/** The line under the title, with the mover's face. */
export function TrashedByline({ trashed, viewer, style }: { trashed: TrashedView; viewer?: string | null; style?: StyleProp<ViewStyle> }) {
  const styles = useThemedStyles(makeStyles);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  const { who, rest } = trashedLine(trashed, now);
  const face = trashed.byYou ? viewer : trashed.byName;
  return (
    <View style={[styles.byline, style]} testID="trashed-byline">
      <PersonFace name={face ?? null} size={18} />
      <Text variant="meta" style={styles.bylineText} numberOfLines={1}>
        <Text variant="meta" style={styles.who}>{who}</Text>
        {rest}
      </Text>
    </View>
  );
}

/** "In trash", beside the path on a pointer layout and over the title on a phone. */
export function InTrashPill({ style }: { style?: ViewStyle }) {
  const colors = useColors();
  return (
    <Pill tone="crit" leading={<Icon name="trash" size={12} color={colors.critText} />} style={style} testID="in-trash-pill">
      In trash
    </Pill>
  );
}

/**
 * Restore, solid in the accent: the header's, where Share was, or the
 * phone's, full width at the foot of the note.
 */
export function RestoreButton({ trashed, wide = false }: { trashed: TrashedView; wide?: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const disabled = trashed.onRestore === undefined || trashed.restoring === true;
  return (
    <Pressable
      role="button"
      accessibilityLabel="Restore"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={trashed.onRestore}
      testID={wide ? "trashed-restore-wide" : "trashed-restore"}
      style={({ pressed }) => [
        styles.restore,
        wide && styles.restoreWide,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      <Icon name="undo" size={wide ? 18 : 14} color={colors.ink} />
      <Text variant="mini" style={[styles.restoreLabel, wide && styles.restoreLabelWide]}>
        {trashed.restoring === true ? "Restoring…" : "Restore"}
      </Text>
    </Pressable>
  );
}

/** The phone's Restore, pinned over the foot of the note in place of the toolbar. */
export function TrashedRestoreBar({ trashed }: { trashed: TrashedView }) {
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 12) }]}>
      <RestoreButton trashed={trashed} wide />
    </View>
  );
}

/** Room at the foot of a phone's note, so its last line scrolls clear of the bar. */
export const RESTORE_BAR_ROOM = 88;

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    byline: { flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0 },
    bylineText: { flexShrink: 1 },
    who: { color: colors.text, fontWeight: "600" },
    restore: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      paddingVertical: 6,
      paddingHorizontal: 12,
      borderRadius: radii.md,
      backgroundColor: colors.accent,
    },
    restoreWide: { alignSelf: "stretch", paddingVertical: 14, borderRadius: radii.lg },
    restoreLabel: { color: colors.ink },
    restoreLabelWide: { fontSize: touchType.ui },
    pressed: { opacity: 0.85 },
    disabled: { opacity: 0.6 },
    bar: { position: "absolute", left: 16, right: 16, bottom: 0, pointerEvents: "box-none" },
  });
