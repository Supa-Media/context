import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, PressRow } from "../../design/components/Button";
import { Dot } from "../../design/components/Dot";
import { FocusRing } from "../../design/components/FocusRing";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { layout, radii, space } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors, type Shadows } from "../../design/theme";
import type { SyncFacts } from "../../offline/copy";
import { baseName, displayName, displayPath, parentPath } from "./paths";
import { describeSyncMark, type OpRow as QueuedOp, type PendingMarks } from "./pendingMarks";
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
  onAnswer,
  onDismiss,
}: {
  sync: SyncFacts | undefined;
  save: StatusSegment | null;
  pending: PendingMarks;
  onOpen: (path: string) => void;
  /** A person's answer to a parked op — `FileBrowser.answerOp`. */
  onAnswer?: (id: string, answer: "override" | "retry" | "discard") => void;
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
              <Section
                key={section.id}
                section={section}
                pending={pending}
                onOpen={onOpen}
                onAnswer={onAnswer}
              />
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
  onAnswer,
}: {
  section: SyncSheetSection;
  pending: PendingMarks;
  onOpen: (path: string) => void;
  onAnswer?: (id: string, answer: "override" | "retry" | "discard") => void;
}) {
  const styles = useThemedStyles(makeStyles);
  /*
    The queued renames, moves, deletes and new folders, in the block their
    state belongs to: waiting ones under "waiting to sync", parked ones under
    the block that says somebody is needed — with the answers right on the row,
    because a delete has no note to open and answer from.
  */
  const ops = (pending.operations ?? []).filter((op) =>
    section.id === "stuck" ? op.mark === "conflict" : section.id === "waiting" ? op.mark === "queued" : false,
  );
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
          label={pending.labelFor?.(path) ?? null}
          mark={pending.stateFor(path)}
          onPress={() => onOpen(path)}
        />
      ))}
      {ops.map((op) => (
        <OperationRow
          key={op.id}
          op={op}
          onOpen={op.open === undefined ? undefined : () => onOpen(op.open!)}
          onAnswer={onAnswer}
        />
      ))}
    </View>
  );
}

const ANSWER_LABELS = {
  override: "Do it anyway",
  retry: "Try again",
  discard: "Discard",
} as const;

/**
 * One queued op: "Rename plan → plan-2026 · waiting to sync". Pressing the text
 * opens what it left behind, where there is something; a parked one carries
 * its answers as buttons. Discard takes the op back — the note stays as the
 * bucket has it — and is never offered on one that is simply waiting: that is
 * the undo the toast offered, and a button here would be a way to cancel a
 * rename that is already on the wire.
 */
function OperationRow({
  op,
  onOpen,
  onAnswer,
}: {
  op: QueuedOp;
  onOpen?: () => void;
  onAnswer?: (id: string, answer: "override" | "retry" | "discard") => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const status = describeSyncMark(op.mark);
  return (
    <View style={styles.opRow} testID={`sync-op-${op.id}`}>
      <Pressable
        role={onOpen === undefined ? undefined : "button"}
        accessibilityLabel={`${op.text} · ${status}`}
        onPress={onOpen}
        disabled={onOpen === undefined}
        style={styles.opText}
      >
        <Icon name="file" size={17} color={colors.muted} />
        <View style={styles.rowText}>
          <Text variant="rowTitle" numberOfLines={2}>
            {`${op.text} · ${status}`}
          </Text>
          {op.detail === undefined ? null : (
            <Text variant="rowSub" numberOfLines={3}>
              {op.detail}
            </Text>
          )}
        </View>
        <SyncMarkDot mark={op.mark} />
      </Pressable>
      {onAnswer === undefined || op.answers.length === 0 ? null : (
        <View style={styles.answers}>
          {op.answers.map((answer) => (
            <Button
              key={answer}
              label={ANSWER_LABELS[answer]}
              variant={answer === "discard" ? "danger" : "mini"}
              accessibilityLabel={`${ANSWER_LABELS[answer]}: ${op.text}`}
              onPress={() => onAnswer(op.id, answer)}
              testID={`sync-op-${op.id}-${answer}`}
            />
          ))}
        </View>
      )}
    </View>
  );
}

/** One note the sheet is about. Pressing it opens it, which is the answer. */
function NoteRow({
  path,
  label,
  mark,
  onPress,
}: {
  path: string;
  /** "New note: Groceries" for a note that exists only on this device. */
  label: string | null;
  mark: ReturnType<PendingMarks["stateFor"]>;
  onPress: () => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const [focused, setFocused] = useState(false);
  const folder = parentPath(path);
  const name = label ?? displayName(baseName(path));

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
  opRow: { gap: 6, paddingVertical: 4 },
  opText: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 44,
    paddingHorizontal: 10,
  },
  answers: { flexDirection: "row", flexWrap: "wrap", gap: space.x2, paddingLeft: 37 },
});
