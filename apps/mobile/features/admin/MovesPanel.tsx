/**
 * Queued folder moves still copying (`functions/nodeMovesAdmin.ts`), under the
 * Indexes table: one line per move with how far the bucket has caught up, and
 * a Retry and an Undo for a move that keeps failing. Hidden when no move is
 * pending, which is nearly always.
 *
 * Counts, times and fixed labels only, as the migration card beside it: a
 * workspace's handle, never a folder's name.
 */

import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { Button, Dot, Text, space, useThemedStyles, type Colors } from "../design";
import { NoticeLine, Panel } from "./AdminKit";
import { messageFor } from "./SecretDialogs";
import { whenLabel } from "./agent";

export function MovesPanel() {
  const styles = useThemedStyles(makeStyles);
  const report = useQuery(api.functions.nodeMovesAdmin.report, {});
  const retry = useMutation(api.functions.nodeMovesAdmin.retry);
  const undo = useMutation(api.functions.nodeMovesAdmin.undo);
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<{ text: string; tone: "ok" | "crit" } | null>(null);

  if (report === undefined || report.rows.length === 0) return null;

  async function act(key: string, work: () => Promise<unknown>, done: string) {
    setBusy(key);
    setSaid(null);
    try {
      await work();
      setSaid({ text: done, tone: "ok" });
    } catch (error) {
      setSaid({ text: messageFor(error, "That did not work. Try again."), tone: "crit" });
    } finally {
      setBusy(null);
    }
  }

  const now = Date.now();
  return (
    <Panel title="Folder moves" meta={`${report.rows.length} copying`} testID="admin-moves">
      {said ? (
        <NoticeLine mark={said.tone === "ok" ? "✓" : "!"} tone={said.tone}>
          {said.text}
        </NoticeLine>
      ) : null}
      {report.rows.map((row) => (
        <View key={row.id} style={styles.row} testID={`admin-move-${row.id}`}>
          <Dot tone={row.stuck ? "crit" : row.running ? "ok" : "neutral"} />
          <View style={styles.grow}>
            <Text variant="rowTitle">
              {row.slug === null ? "Workspace" : `@${row.slug}`}
              {row.undone ? " · undoing" : ""}
            </Text>
            <Text variant="meta">
              {`${Math.min(row.moved, row.total)} of ${row.total} files copied · started ${whenLabel(row.createdAt, now)}`}
              {row.lastError === null ? "" : ` · ${row.lastError} (${row.attempts} tries)`}
            </Text>
          </View>
          <Button
            label={busy === `retry:${row.id}` ? "Retrying…" : "Retry"}
            disabled={busy !== null || row.running}
            onPress={() => void act(`retry:${row.id}`, () => retry({ id: row.id }), "The move will try again now.")}
            testID={`admin-move-retry-${row.id}`}
          />
          {row.stuck ? (
            <Button
              label={busy === `undo:${row.id}` ? "Undoing…" : "Undo"}
              disabled={busy !== null || !row.canUndo || row.running}
              onPress={() =>
                void act(`undo:${row.id}`, () => undo({ id: row.id }), "The folder is going back to where it was.")
              }
              testID={`admin-move-undo-${row.id}`}
            />
          ) : null}
        </View>
      ))}
    </Panel>
  );
}

const makeStyles = (_colors: Colors) =>
  StyleSheet.create({
    row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.x2, paddingVertical: space.x2 },
    grow: { flexGrow: 1, flexShrink: 1, flexBasis: 200, gap: 2 },
  });
