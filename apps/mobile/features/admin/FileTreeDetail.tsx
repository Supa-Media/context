/**
 * The file tree's box in an Indexes row's detail (`./IndexRows`): its facts
 * behind Lists, Boards, the map and the chaos score. Repair and Check went
 * with the copy they acted on (#2116): notes are kept by id, so there is no
 * copy of the bucket to make again or compare, and the 15-minute round starts
 * a facts fill that is due.
 *
 * Seal again shows only while notes were saved unsealed into the sealed
 * bucket (`unreadableOf`): it walks the bucket once more, which seals them.
 *
 * Counts, times and fixed labels only: a workspace's handle, never a folder's
 * or a note's name.
 */

import { StyleSheet, View } from "react-native";
import { Button, Dot, Text, space, useThemedStyles, type Colors } from "../design";
import { healthTone, type IndexHealth, type MigrationRow, type WorkspaceIndexes } from "./searchIndexes";
import type { IndexActions } from "./IndexRows";

export function FileTreeDetail({ row, actions }: { row: WorkspaceIndexes; actions: IndexActions }) {
  const styles = useThemedStyles(makeStyles);
  const id = row.slug ?? row.workspaceId;
  const copy = row.migrationRow;
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
        {row.unreadable?.kind === "unsealed"
          ? button(`reseal:${row.workspaceId}`, "Seal again", "Starting…", () => actions.reseal(row.workspaceId), `admin-files-reseal-${id}`)
          : null}
      </View>
      <Line
        tone={row.files.health}
        label={row.files.label}
        text={`Lists, Boards and map details. ${factsNote(copy)}`}
        problem={row.files.problem}
      />
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

/** One sentence for the copy's facts: whether they have read every note. */
export function factsNote(copy: MigrationRow | null): string {
  const facts = copy?.facts ?? null;
  if (copy === null) return "None: this workspace has no storage.";
  if (facts === null) return "Not read yet.";
  if (!facts.ready) return facts.running ? "Reading every note once." : "Part way through reading every note once.";
  if (facts.retrying > 0) {
    return `Every note read; ${facts.retrying.toLocaleString("en-US")} ${facts.retrying === 1 ? "note" : "notes"} to read again.`;
  }
  return "Every note read, and kept current after each change.";
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
  });
