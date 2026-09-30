import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import type { CastActor, CastStep } from "@context/shared";
import { Icon } from "../design/components/Icon";
import { Text } from "../design/components/Text";
import { radii, space } from "../design/tokens";
import { useThemedStyles, type Colors } from "../design/theme";
import { StudioCastStrip } from "./StudioCastStrip";
import { StudioScriptRow } from "./StudioScriptRow";
import { StudioStepEditor } from "./StudioStepEditor";
import type { OutsideChange } from "./scriptChanges";
import type { ScriptEdits } from "./scriptEdits";
import type { ScriptRow } from "./studioScript";

/**
 * The script, one row a step: when it starts, who does it, what they do.
 * ▶ on a row plays the scene from there; the row playing now is marked.
 *
 * Where the note can be changed, the script is changed here (Dev2,
 * 2026-09-30, approved on the "Edit the script in the studio" artboard): a
 * row's words are typed over where they stand, pressing a row opens who does
 * it and what, and the cast above renames people everywhere at once. Every
 * change is written into the note's cast block, which stays the only copy of
 * the script. A change somebody else makes while the studio is open, an
 * agent through its tools most of all, is marked on the rows it touched.
 */
export function StudioScriptRail({
  rows,
  current,
  colors: memberColors,
  problems,
  onJump,
  cast,
  edits,
  change,
  moved,
}: {
  rows: readonly ScriptRow[];
  current: number;
  colors: ReadonlyMap<string, string>;
  problems: readonly string[];
  onJump: (index: number) => void;
  cast: readonly CastActor[];
  /** Absent where the note cannot be changed: the rail only reads. */
  edits?: ScriptEdits;
  /** The latest change made from outside the studio, while it is marked. */
  change: OutsideChange | null;
  /** Rows whose start moved because of an edit made here. */
  moved: ReadonlySet<number>;
}) {
  const styles = useThemedStyles(makeStyles);
  const [open, setOpen] = useState<number | null>(null);
  const [removed, setRemoved] = useState<{ index: number; step: CastStep } | null>(null);
  const changed = new Set(change?.changed ?? []);
  const addStep = () => {
    if (edits === undefined) return;
    const last = [...rows].reverse().find((row) => row.actor !== null)?.actor ?? cast[0] ?? { name: "@you", kind: "person" as const };
    edits.insert(rows.length, { kind: "line", actor: last, text: "…", at: 0 });
    setOpen(rows.length);
  };
  return (
    <View style={styles.rail}>
      <StudioCastStrip cast={cast} colors={memberColors} onRename={edits?.rename} />
      <View style={styles.headRow}>
        <Text variant="eyebrow" style={styles.head}>
          Script
        </Text>
        {edits === undefined ? null : (
          <Text variant="rowSub" style={styles.muted}>
            Changes save to the note
          </Text>
        )}
      </View>
      {change !== null ? (
        <View style={styles.notice} testID="studio-outside-change" accessibilityLiveRegion="polite">
          <Icon name={change.by === null ? "pencil" : "robot"} size={14} />
          <Text variant="rowSub" style={styles.noticeText}>
            {outsideChangeLine(change)}
          </Text>
        </View>
      ) : null}
      {removed !== null && edits !== undefined ? (
        <View style={styles.notice}>
          <Text variant="rowSub" style={styles.noticeText}>
            Step deleted.
          </Text>
          <Pressable
            onPress={() => {
              edits.insert(removed.index, removed.step);
              setRemoved(null);
            }}
            accessibilityRole="button"
            style={styles.undo}
            testID="studio-undo-delete"
          >
            <Icon name="undo" size={13} />
            <Text variant="rowSub" style={styles.undoText}>
              Undo
            </Text>
          </Pressable>
        </View>
      ) : null}
      <ScrollView contentContainerStyle={styles.list}>
        {rows.map((row) => (
          <View key={row.index}>
            <StudioScriptRow
              row={row}
              now={row.index === current}
              done={row.index < current}
              open={row.index === open}
              face={row.actor === null ? null : memberColors.get(row.actor.name) ?? null}
              changedBy={changed.has(row.index) ? change!.by : undefined}
              moved={moved.has(row.index)}
              onPlay={() => onJump(row.index)}
              onOpen={edits === undefined ? undefined : () => setOpen(open === row.index ? null : row.index)}
              onWords={edits === undefined ? undefined : (words) => edits.words(row.index, words)}
            />
            {row.index === open && edits !== undefined ? (
              <StudioStepEditor
                index={row.index}
                step={row.step}
                count={rows.length}
                cast={cast}
                edits={{
                  ...edits,
                  move: (from, to) => {
                    edits.move(from, to);
                    setOpen(to);
                  },
                  insert: (index, step) => {
                    edits.insert(index, step);
                    if (index <= row.index) setOpen(row.index + 1);
                  },
                }}
                onRemoved={(index, step) => {
                  setRemoved({ index, step });
                  setOpen(null);
                }}
                onClose={() => setOpen(null)}
              />
            ) : null}
          </View>
        ))}
        {rows.length === 0 ? (
          <Text variant="rowSub" style={styles.empty}>
            This note has no cast yet. Add a ```cast block to it to make a scene.
          </Text>
        ) : null}
        {edits !== undefined && rows.length > 0 ? (
          <Pressable onPress={addStep} accessibilityRole="button" style={styles.add} testID="studio-add-step">
            <Icon name="plus" size={13} />
            <Text variant="rowSub" style={styles.addText}>
              Add a step
            </Text>
          </Pressable>
        ) : null}
        {problems.map((problem) => (
          <Text key={problem} variant="rowSub" style={styles.problem}>
            {`Skipped, not understood: ${problem}`}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}

/** "Claude changed 2 steps just now", in words. */
export function outsideChangeLine(change: Pick<OutsideChange, "by" | "changed" | "removed">): string {
  const parts: string[] = [];
  if (change.changed.length > 0) parts.push(`changed ${change.changed.length} ${change.changed.length === 1 ? "step" : "steps"}`);
  if (change.removed > 0) parts.push(`took out ${change.removed} ${change.removed === 1 ? "step" : "steps"}`);
  const what = parts.join(" and ");
  return `${change.by ?? "Someone"} ${what} just now.`;
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    rail: { width: 380, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: colors.line, backgroundColor: colors.chromeSurface },
    headRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: space.x4, paddingTop: space.x3, paddingBottom: space.x2 },
    head: { color: colors.muted },
    muted: { color: colors.muted },
    notice: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      marginHorizontal: space.x3,
      marginBottom: space.x2,
      paddingHorizontal: space.x3,
      paddingVertical: space.x2,
      borderRadius: radii.xl,
      backgroundColor: colors.accentDim,
    },
    noticeText: { flex: 1, color: colors.text },
    undo: { flexDirection: "row", alignItems: "center", gap: space.x1, minHeight: 32, paddingHorizontal: space.x2 },
    undoText: { color: colors.accentText, fontWeight: "600" },
    list: { paddingHorizontal: space.x2, paddingBottom: space.x5, gap: 2 },
    add: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: space.x1,
      minHeight: 40,
      marginTop: space.x2,
      marginHorizontal: space.x2,
      borderRadius: radii.xl,
      borderWidth: 1,
      borderStyle: "dashed",
      borderColor: colors.muted,
    },
    addText: { color: colors.text },
    empty: { padding: space.x4, color: colors.muted },
    problem: { paddingHorizontal: space.x3, paddingTop: space.x2, color: colors.crit },
  });
