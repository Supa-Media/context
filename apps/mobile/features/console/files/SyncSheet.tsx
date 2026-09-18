import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PressRow } from "../../design/components/Button";
import { Dot } from "../../design/components/Dot";
import { FocusRing } from "../../design/components/FocusRing";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { layout, radii, space } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors, type Shadows } from "../../design/theme";
import type { SyncFacts } from "../../offline/copy";
import { baseName, displayName, displayPath, parentPath } from "./paths";
import type { PendingMarks } from "./pendingMarks";
import { compactSync, syncSheetSections, type StatusSegment, type SyncSheetSection } from "./status";
import { SyncMarkDot, withSyncMark } from "./SyncMarkDot";
import { mirrorSheetSection } from "../../offline/mirrorCopy";

/**
 * Sync, on a phone: a pill in the header and a sheet behind it.
 *
 * ## Why this exists
 *
 * Everything the offline layer knows was said in one place — the status strip
 * along the bottom of a pointer layout — and **a phone has no status strip**:
 * `frame.ts` answers `statusBar: false` at compact, because the bottom edge is
 * the thumb's toolbar and a screen with both is 28pt of chrome saying nothing.
 * The per-note `SaveChip` was pointer-only too. So somebody on a train, which
 * is the case the whole offline layer was built for, was told nothing about
 * the connection, nothing about the three notes waiting to go, and nothing
 * about the one that had been parked for them — until they scrolled to the foot
 * of a note and read its last line.
 *
 * ## The same three states, from the same functions
 *
 * The pill is `compactSync`, which is `syncSegments` — the strip's own first
 * two segments — plus the open note's `saveChip` in its loud states. So it is
 * **absent** in exactly the states the strip is silent in: online with nothing
 * waiting, and while the platform has not said whether it is online. It is
 * `crit` whenever anything behind it is, because a conflict never sorts itself
 * out and a waiting write always does (`queueLine`).
 *
 * The sheet is `syncSheetSections`: the sentences are `copy.ts`'s, and where
 * the strip can name three notes in a line, the sheet lists every one of them
 * as a row that opens it — which is how a waiting write is checked and a parked
 * one is answered.
 */
export function SyncPill({
  sync,
  save,
  onPress,
}: {
  sync: SyncFacts | undefined;
  /** The open note's `saveChip`, or `null` with nothing open. */
  save: StatusSegment | null;
  onPress: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const pill = compactSync(sync, save);
  if (pill === null) return null;

  return (
    <PressRow
      accessibilityLabel={`${pill.label}. Show sync details`}
      onPress={onPress}
      radius={radii.pill}
      /*
        Its own floating capsule, the same surface and shadow as the account
        mark and the trailing group it sits between — chrome lying on the note,
        not a tinted wash lying on body text. The tone is in the dot and the
        words; a warn-washed pill over a paragraph is legible on neither
        palette.
      */
      style={styles.pill}
      hoverStyle={styles.pillHover}
      testID="sync-pill"
    >
      <Dot tone={pill.tone} />
      <Text
        variant="pill"
        numberOfLines={1}
        style={[styles.pillText, pill.tone === "crit" ? styles.critText : styles.warnText]}
      >
        {pill.text}
      </Text>
    </PressRow>
  );
}

export function SyncSheet({
  sync,
  save,
  pending,
  onOpen,
  onDismiss,
}: {
  sync: SyncFacts | undefined;
  save: StatusSegment | null;
  pending: PendingMarks;
  onOpen: (path: string) => void;
  onDismiss: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  /*
    The mirror's line last: how much of this context is on the device. Quiet
    unless the device is offline with part of it missing — `mirrorCopy.ts` —
    and never on its own a reason for the pill that opens this sheet.
  */
  const sections = [...syncSheetSections(sync, pending, save), ...mirrorSheetSection(sync, Date.now())];

  /*
    A sheet about nothing closes itself — the queue draining while it is open
    is the ordinary way that happens, and it is good news. `RecentSheet` makes
    the same rule for the same reason: a sheet with nothing in it is a dead end
    whose only way out is a scrim somebody has to guess at.
  */
  useEffect(() => {
    if (sections.length === 0) onDismiss();
  }, [sections.length, onDismiss]);

  return (
    <Modal transparent animationType="slide" visible onRequestClose={onDismiss}>
      <Pressable style={styles.scrim} accessibilityLabel="Close sync details" onPress={onDismiss}>
        {/* Swallow presses inside the sheet so only the scrim dismisses it. */}
        <Pressable
          style={[styles.sheet, { paddingBottom: insets.bottom + 12 }]}
          onPress={() => {}}
          accessibilityLabel="Sync"
          testID="sync-sheet"
        >
          <View style={styles.grabber} aria-hidden />
          <Text variant="railHead" role="heading" aria-level={2} style={styles.sheetHead}>
            Sync
          </Text>
          <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
            {sections.map((section) => (
              <Section key={section.id} section={section} pending={pending} onOpen={onOpen} />
            ))}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Section({
  section,
  pending,
  onOpen,
}: {
  section: SyncSheetSection;
  pending: PendingMarks;
  onOpen: (path: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.section} testID={`sync-section-${section.id}`}>
      <View style={styles.sectionHead}>
        <Dot tone={section.tone === "quiet" ? "neutral" : section.tone} />
        <Text
          variant="rowTitle"
          style={
            section.tone === "crit"
              ? styles.critText
              : section.tone === "warn"
                ? styles.warnText
                : undefined
          }
        >
          {section.text}
        </Text>
      </View>
      {section.detail === "" ? null : (
        <Text variant="meta" style={styles.detail}>
          {section.detail}
        </Text>
      )}
      {section.paths.map((path) => (
        <NoteRow
          key={path}
          path={path}
          mark={pending.stateFor(path)}
          onPress={() => onOpen(path)}
        />
      ))}
    </View>
  );
}

/** One note the sheet is about. Pressing it opens it, which is the answer. */
function NoteRow({
  path,
  mark,
  onPress,
}: {
  path: string;
  mark: ReturnType<PendingMarks["stateFor"]>;
  onPress: () => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const [focused, setFocused] = useState(false);
  const folder = parentPath(path);
  const name = displayName(baseName(path));

  return (
    <Pressable
      role="button"
      accessibilityLabel={withSyncMark(`Open ${name}`, mark)}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={styles.row}
      testID={`sync-note-${path}`}
    >
      <Icon name="file" size={17} color={colors.muted} />
      <View style={styles.rowText}>
        <Text variant="rowTitle" numberOfLines={1}>
          {name}
        </Text>
        <Text variant="rowSub" numberOfLines={1}>
          {folder === "" ? "in your context root" : displayPath(folder)}
        </Text>
      </View>
      {mark === null ? null : <SyncMarkDot mark={mark} />}
      <FocusRing visible={focused} radius={radii.md} />
    </Pressable>
  );
}

const makeStyles = (colors: Colors, shadows: Shadows) => StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.x2,
    minHeight: layout.chromeButton,
    minWidth: 0,
    flexShrink: 1,
    paddingHorizontal: space.x3,
    borderRadius: radii.pill,
    backgroundColor: colors.chrome,
    boxShadow: shadows.floating,
  },
  pillHover: { backgroundColor: colors.surface3 },
  pillText: { flexShrink: 1, minWidth: 0 },
  warnText: { color: colors.warnText },
  critText: { color: colors.critText },

  /* The sheet: `RecentSheet`'s geometry, because it is the same kind of object. */
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
  sheetHead: { paddingHorizontal: 4, paddingBottom: 6 },
  list: { flexGrow: 0, flexShrink: 1 },
  listContent: { gap: space.x4, paddingBottom: 4 },

  section: { gap: 4 },
  sectionHead: { flexDirection: "row", alignItems: "center", gap: space.x2, paddingHorizontal: 4 },
  detail: { paddingHorizontal: 4, color: colors.muted },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 44,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: radii.md,
  },
  rowText: { flexGrow: 1, flexShrink: 1 },
});
