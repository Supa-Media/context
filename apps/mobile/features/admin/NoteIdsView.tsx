/**
 * The Search tab's "Notes by id" view (`./SearchSection`): each workspace's
 * last diagnosis of its id copies, the check that runs it again, and the
 * old-copy cleanup (count, then delete). One card for the check, then a row per
 * workspace with its own buttons.
 *
 * The figures and the words are `./noteIds`; the report is
 * `api.functions.noteIds.report`, and every button is one of its mutations.
 * Counts, handles and fixed labels only: a note's name never reaches this view.
 */

import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { Button, Card, Text, space, useThemedStyles, type Colors } from "../design";
import { EmptyNote, NoticeLine, Panel, Skeleton } from "./AdminKit";
import { messageFor } from "./SecretDialogs";
import { SharedIdsCheck } from "./SharedIdsCheck";
import {
  cleanupButtons,
  cleanupSummary,
  countLabel,
  deleteLabel,
  diagnosisLine,
  handleLabel,
  type NoteIdsWorkspace,
} from "./noteIds";

type Said = { text: string; tone: "ok" | "crit" } | null;

export function NoteIdsView() {
  const styles = useThemedStyles(makeStyles);
  const report = useQuery(api.functions.noteIds.report, {});
  const countOld = useMutation(api.functions.noteIdsCleanup.countOld);
  const deleteOld = useMutation(api.functions.noteIdsCleanup.deleteOld);
  const diagnose = useMutation(api.functions.noteIds.diagnose);
  const diagnoseAll = useMutation(api.functions.noteIds.diagnoseAll);
  /** The workspace whose delete is waiting for its second, explicit press. */
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<Said>(null);

  async function act(key: string, work: () => Promise<string>) {
    setBusy(key);
    setSaid(null);
    try {
      setSaid({ text: await work(), tone: "ok" });
    } catch (caught) {
      setSaid({ text: messageFor(caught, "That didn't work. Try again."), tone: "crit" });
    } finally {
      setBusy(null);
    }
  }

  if (report === undefined) {
    return (
      <View style={styles.view} aria-busy testID="admin-noteids-loading">
        <Card style={styles.card}>
          <Skeleton width={140} height={14} />
          <Skeleton width="100%" height={12} style={styles.gap} />
        </Card>
      </View>
    );
  }

  const diagnoseEverything = () =>
    act("diagnose-all", async () => {
      await diagnoseAll({});
      return "Checking every workspace against its bucket.";
    });

  const diagnoseOne = (workspaceId: string) =>
    act(`diagnose:${workspaceId}`, async () => {
      await diagnose({ workspaceId: workspaceId as Id<"workspaces"> });
      return "Checking this workspace against its bucket.";
    });

  const countOneWorkspace = (workspaceId: string) =>
    act(`count:${workspaceId}`, async () => {
      await countOld({ workspaceId: workspaceId as Id<"workspaces"> });
      return "Counting this workspace's old copies. Its row updates as it goes.";
    });

  const deleteOneWorkspace = (workspaceId: string) =>
    act(`delete:${workspaceId}`, async () => {
      await deleteOld({ workspaceId: workspaceId as Id<"workspaces"> });
      setConfirmingDelete(null);
      return "Deleting this workspace's old copies. Its row updates as it goes.";
    });

  return (
    <View style={styles.view} testID="admin-noteids">
      <Card style={styles.card}>
        <Text variant="rowTitle" role="heading" aria-level={2}>
          Notes by id
        </Text>
        <Text variant="meta">Every workspace keeps its notes under their ids. Check a workspace's copies against its bucket.</Text>
        <View style={styles.actions}>
          <Button
            label={busy === "diagnose-all" ? "Checking…" : "Diagnose all"}
            disabled={busy !== null}
            onPress={() => void diagnoseEverything()}
            testID="admin-noteids-diagnose-all"
          />
        </View>
        {said ? (
          <NoticeLine mark={said.tone === "ok" ? "✓" : "!"} tone={said.tone}>
            {said.text}
          </NoticeLine>
        ) : null}
      </Card>

      <Panel flush testID="admin-noteids-table">
        {report.workspaces.length === 0 ? (
          <EmptyNote title="No workspaces yet" body="Each workspace shows here once it has storage." />
        ) : (
          report.workspaces.map((entry, index) => (
            <WorkspaceRow
              key={entry.workspaceId}
              row={entry}
              first={index === 0}
              busy={busy}
              onDiagnose={() => void diagnoseOne(entry.workspaceId)}
              onCount={() => void countOneWorkspace(entry.workspaceId)}
              confirmingDelete={confirmingDelete === entry.workspaceId}
              onAskDelete={() => setConfirmingDelete(entry.workspaceId)}
              onCancelDelete={() => setConfirmingDelete(null)}
              onDelete={() => void deleteOneWorkspace(entry.workspaceId)}
            />
          ))
        )}
      </Panel>
    </View>
  );
}

function WorkspaceRow({
  row,
  first,
  busy,
  onDiagnose,
  onCount,
  confirmingDelete,
  onAskDelete,
  onCancelDelete,
  onDelete,
}: {
  row: NoteIdsWorkspace;
  first: boolean;
  busy: string | null;
  onDiagnose: () => void;
  onCount: () => void;
  confirmingDelete: boolean;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const diagnosis = diagnosisLine(row.diagnosis);
  const cleanup = row.cleanup ?? null;
  const buttons = cleanup === null ? null : cleanupButtons(cleanup);
  return (
    <View style={[styles.row, !first && styles.ruled]} testID={`admin-noteids-row-${row.workspaceId}`}>
      <View style={styles.name}>
        <Text variant="rowTitle" numberOfLines={1} style={row.handle === null ? styles.muted : null}>
          {handleLabel(row.handle)}
        </Text>
      </View>
      <View style={styles.status}>
        {diagnosis ? (
          <Text variant="meta" style={styles.num}>
            {diagnosis}
          </Text>
        ) : (
          <Text variant="meta" style={styles.muted}>
            Not checked yet
          </Text>
        )}
        {cleanup === null
          ? null
          : cleanupSummary(cleanup).map((line) => (
              <Text key={line} variant="meta" style={styles.num} testID={`admin-noteids-cleanup-${row.workspaceId}`}>
                {line}
              </Text>
            ))}
      </View>
      <View style={styles.rowActions}>
        <Button
          label={busy === `diagnose:${row.workspaceId}` ? "Checking…" : "Diagnose"}
          disabled={busy !== null}
          onPress={onDiagnose}
          testID={`admin-noteids-diagnose-${row.workspaceId}`}
        />
      </View>
      {buttons === null ? null : (
        <View style={styles.cleanupCell}>
          <Button
            label={busy === `count:${row.workspaceId}` ? "Counting…" : countLabel()}
            disabled={busy !== null || !buttons.count.enabled}
            onPress={onCount}
            testID={`admin-noteids-count-${row.workspaceId}`}
          />
          {buttons.count.reason ? <Text variant="meta">{buttons.count.reason}</Text> : null}
          {confirmingDelete ? (
            <View style={styles.inline} role="alert" testID={`admin-noteids-delete-confirm-${row.workspaceId}`}>
              <Text variant="check">
                {`Delete ${(cleanup?.toDelete ?? 0).toLocaleString("en-US")} old copies? Only the old path copies go. notes/, files/ and the collaboration history stay. This can't be undone.`}
              </Text>
              <View style={styles.actions}>
                <Button label="Cancel" disabled={busy !== null} onPress={onCancelDelete} />
                <Button
                  label={busy === `delete:${row.workspaceId}` ? "Deleting…" : "Delete"}
                  variant="danger"
                  disabled={busy !== null || !buttons.delete.enabled}
                  onPress={onDelete}
                  testID={`admin-noteids-delete-go-${row.workspaceId}`}
                />
              </View>
            </View>
          ) : (
            <>
              <Pressable
                accessibilityRole="button"
                disabled={busy !== null || !buttons.delete.enabled}
                onPress={onAskDelete}
                testID={`admin-noteids-delete-${row.workspaceId}`}
              >
                <Text style={buttons.delete.enabled ? styles.deleteWord : styles.muted}>{deleteLabel()}</Text>
              </Pressable>
              {buttons.delete.reason ? <Text variant="meta">{buttons.delete.reason}</Text> : null}
            </>
          )}
        </View>
      )}
      <SharedIdsCheck workspaceId={row.workspaceId} />
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    view: { gap: space.x4 },
    card: { gap: space.x2 },
    gap: { marginTop: 14 },
    actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.x2, paddingTop: space.x2 },
    inline: { gap: space.x2, paddingTop: space.x2 },
    row: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      gap: space.x3,
      paddingHorizontal: space.x4,
      paddingVertical: space.x3,
    },
    ruled: { borderTopWidth: 1, borderTopColor: colors.line },
    name: { flexGrow: 1, flexBasis: 140, minWidth: 0 },
    status: { flexGrow: 2, flexBasis: 200, gap: 4, minWidth: 0 },
    rowActions: { flexDirection: "row", flexWrap: "wrap", gap: space.x2, marginLeft: "auto" },
    cleanupCell: { flexBasis: "100%", gap: space.x1, alignItems: "flex-start" },
    /** The one-way door: bold red, inline, not a button-shaped control. */
    deleteWord: { color: colors.critText, fontWeight: "700" },
    muted: { color: colors.muted },
    num: { fontVariant: ["tabular-nums"] },
  });
