/**
 * The file tree's box in an Indexes row's detail (`./IndexRows`): the Convex
 * copy (what the app and AI clients list notes from), its facts behind Lists,
 * Boards, the map and the chaos score, and the folder moves still copying,
 * each with its buttons. The facts fill follows the copy, so Repair copies
 * again and the facts catch up after it; the D1 tables and their Fill left
 * in phase 7 of the tree migration. The moves used to be their own panel under the table; the
 * owner approved folding them into the workspace's row (2026-10-13).
 *
 * Seal again shows only while notes were saved unsealed into the sealed
 * bucket (`unreadableOf`): it walks the bucket once more, which seals them.
 *
 * Counts, times and fixed labels only: a workspace's handle, never a folder's
 * or a note's name.
 */

import { StyleSheet, View } from "react-native";
import { Button, Dot, Text, space, useThemedStyles, type Colors } from "../design";
import { whenLabel } from "./agent";
import { relativeTime } from "./report";
import { lateWords, timeLeftWords } from "./storageLag";
import { healthTone, parityWords, type IndexHealth, type MigrationRow, type MoveRow, type WorkspaceIndexes } from "./searchIndexes";
import type { IndexActions } from "./IndexRows";

export function FileTreeDetail({ row, actions }: { row: WorkspaceIndexes; actions: IndexActions }) {
  const styles = useThemedStyles(makeStyles);
  const id = row.slug ?? row.workspaceId;
  const now = Date.now();
  const copy = row.migrationRow;
  const canCopy = copy !== null && !actions.migrationPaused;
  const button = (key: string, label: string, busyLabel: string, onPress: () => void, testID: string, disabled = false) => (
    <Button
      label={actions.busy === key ? busyLabel : label}
      disabled={actions.busy !== null || disabled}
      onPress={onPress}
      testID={testID}
    />
  );
  return (
    <View style={styles.box} testID={`admin-files-detail-${id}`}>
      <View style={styles.head}>
        {row.files.health === "none" ? null : <Dot tone={healthTone(row.files.health)} />}
        <Text variant="rowTitle" style={styles.grow}>
          File tree
        </Text>
        {canCopy
          ? button(
              `repair:${row.workspaceId}`,
              "Repair",
              "Starting…",
              () => actions.repair(row.workspaceId),
              `admin-files-repair-${id}`,
            )
          : null}
        {copy === null
          ? null
          : button(`check:${row.workspaceId}`, "Check", "Checking…", () => actions.check(row.workspaceId), `admin-files-check-${id}`)}
        {row.unreadable?.kind === "unsealed"
          ? button(`reseal:${row.workspaceId}`, "Seal again", "Starting…", () => actions.reseal(row.workspaceId), `admin-files-reseal-${id}`)
          : null}
      </View>
      <Line tone={row.convex.health} label={row.convex.label} text={copyNote(copy, now)} problem={row.convex.problem} />
      <Line
        tone={row.details.health}
        label={row.details.label}
        text={`Lists, Boards and map details. ${factsNote(copy)}`}
        problem={row.details.problem}
      />
      {row.moves.map((move) => (
        <View key={move.id} style={styles.move} testID={`admin-move-${move.id}`}>
          <Dot tone={move.stuck ? "crit" : move.running ? "ok" : "neutral"} />
          <Text variant="meta" style={styles.grow}>
            {moveNote(move, now)}
          </Text>
          {button(`retry:${move.id}`, "Retry move", "Retrying…", () => actions.retryMove(move.id), `admin-move-retry-${move.id}`, move.running)}
          {move.stuck
            ? button(
                `undo:${move.id}`,
                "Undo move",
                "Undoing…",
                () => actions.undoMove(move.id),
                `admin-move-undo-${move.id}`,
                !move.canUndo || move.running,
              )
            : null}
        </View>
      ))}
    </View>
  );
}

function Line({ tone, label, text, problem }: { tone: IndexHealth; label: string; text: string; problem: string | null }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.line}>
      <View style={styles.lineTop}>
        {tone === "none" ? null : <Dot tone={healthTone(tone)} />}
        {tone === "none" ? null : (
          <Text variant="rowSub" style={styles.strong}>
            {label}
          </Text>
        )}
        <Text variant="meta" style={styles.grow}>
          {text}
        </Text>
      </View>
      {problem ? (
        <Text variant="meta" style={styles.problem}>
          {problem}
        </Text>
      ) : null}
    </View>
  );
}

/** One sentence for the Convex copy: the file count, when it was last copied, and what the check said. */
export function copyNote(copy: MigrationRow | null, now: number): string {
  if (copy === null) return "No file tree. This workspace has no storage to copy.";
  const files = `${copy.files.toLocaleString("en-US")} ${copy.files === 1 ? "file" : "files"}`;
  const copied = copy.sweptAt === null ? "Never copied" : `Last copied ${relativeTime(copy.sweptAt, now)}`;
  const dirty = copy.dirty ? " A change is waiting for the next copy." : "";
  return `${files}. ${copied}. ${parityWords(copy.parity)}.${dirty}`;
}

/** One sentence for the copy's facts: whether they have read every note. */
export function factsNote(copy: MigrationRow | null): string {
  const facts = copy?.facts ?? null;
  if (copy === null) return "None without a file tree.";
  if (facts === null) return "Not read yet.";
  if (!facts.ready) return facts.running ? "Reading every note once." : "Part way through reading every note once.";
  if (facts.retrying > 0) {
    return `Every note read; ${facts.retrying.toLocaleString("en-US")} ${facts.retrying === 1 ? "note" : "notes"} to read again.`;
  }
  return "Every note read, and kept current after each change.";
}

/** One sentence for a folder move still copying. */
export function moveNote(move: MoveRow, now: number): string {
  const head = move.undone ? "Folder move, undoing" : "Folder move";
  const failed = move.lastError === null ? "" : ` · ${move.lastError} (${move.attempts} tries)`;
  const late = lateWords(move.late);
  return `${head}: ${Math.min(move.moved, move.total)} of ${move.total} files copied${timeLeftWords(move.etaMs)} · started ${whenLabel(move.createdAt, now)}${failed}${late && move.late !== "stuck" ? ` · ${late}` : ""}`;
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    box: {
      flexGrow: 1,
      flexBasis: 240,
      gap: space.x2,
      padding: space.x3,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.surface,
    },
    head: { flexDirection: "row", alignItems: "center", gap: space.x2, minHeight: 28 },
    grow: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
    line: { gap: 2 },
    lineTop: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 },
    strong: { fontWeight: "600", color: colors.text },
    problem: { color: colors.critText },
    move: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.x2 },
  });
