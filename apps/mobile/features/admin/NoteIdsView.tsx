/**
 * The Search tab's "Notes by id" view (`./SearchSection`): how far each
 * workspace's notes have been copied to their id-named keys, and the buttons
 * that start, pause, restart and check the copy. One card for the whole copy,
 * then a row per workspace, failed first and the least copied after.
 *
 * The figures and the words are `./noteIds`; the report is
 * `api.functions.noteIds.report`, and every button is one of its mutations.
 * Counts, handles and fixed labels only: a note's name never reaches this view.
 *
 * The footer's switch says which keys reads use and moves them: "Switch to
 * notes/" reads note bodies from their id copies, "Switch back to paths" reads
 * them from their paths again. Either one asks first, in plain words.
 */

import { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { Button, Card, Text, space, useThemedStyles, type Colors, type DotTone } from "../design";
import { pointerType } from "../design/tokens";
import { EmptyNote, NoticeLine, Panel, Skeleton } from "./AdminKit";
import { messageFor } from "./SecretDialogs";
import {
  barShare,
  countsLine,
  diagnosisLine,
  formatPercent,
  handleLabel,
  isFailing,
  modeLabel,
  nextMode,
  pauseLabel,
  sortWorkspaces,
  statusLabel,
  switchLabel,
  switchNote,
  type NoteIdsWorkspace,
} from "./noteIds";

type Said = { text: string; tone: "ok" | "crit" } | null;

export function NoteIdsView() {
  const styles = useThemedStyles(makeStyles);
  const report = useQuery(api.functions.noteIds.report, {});
  const startAll = useMutation(api.functions.noteIds.startAll);
  const restart = useMutation(api.functions.noteIds.restart);
  const setPaused = useMutation(api.functions.noteIds.setPaused);
  const diagnose = useMutation(api.functions.noteIds.diagnose);
  const diagnoseAll = useMutation(api.functions.noteIds.diagnoseAll);
  const setMode = useMutation(api.functions.noteIds.setMode);
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<Said>(null);
  const [confirmingSwitch, setConfirmingSwitch] = useState(false);

  const rows = useMemo(() => (report === undefined ? null : sortWorkspaces(report.workspaces)), [report]);

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

  if (report === undefined || rows === null) {
    return (
      <View style={styles.view} aria-busy testID="admin-noteids-loading">
        <Card style={styles.card}>
          <Skeleton width={140} height={14} />
          <Skeleton width={90} height={30} style={styles.gap} />
          <Skeleton width="100%" height={12} style={styles.gap} />
        </Card>
      </View>
    );
  }

  const percent = formatPercent(report.totals.copied, report.totals.files);
  const share = barShare(report.totals.copied, report.totals.files);
  const paused = report.paused;

  const togglePaused = () => {
    const next = !paused;
    return act("pause", async () => {
      await setPaused({ paused: next });
      return next ? "Copying paused. Each copy stops at its next pass." : "Copying again.";
    });
  };

  const startEverything = () =>
    act("start-all", async () => {
      await startAll({});
      return "Copying every workspace. Its row updates as it goes.";
    });

  const switchMode = () =>
    act("switch", async () => {
      const target = nextMode(report.mode);
      await setMode({ mode: target });
      setConfirmingSwitch(false);
      return target === "ids" ? "Reading from notes/ now." : "Reading from paths again.";
    });

  const diagnoseEverything = () =>
    act("diagnose-all", async () => {
      await diagnoseAll({});
      return "Checking every workspace against its bucket.";
    });

  const restartOne = (workspaceId: string) =>
    act(`restart:${workspaceId}`, async () => {
      await restart({ workspaceId: workspaceId as Id<"workspaces"> });
      return "Copying this workspace again.";
    });

  const diagnoseOne = (workspaceId: string) =>
    act(`diagnose:${workspaceId}`, async () => {
      await diagnose({ workspaceId: workspaceId as Id<"workspaces"> });
      return "Checking this workspace against its bucket.";
    });

  return (
    <View style={styles.view} testID="admin-noteids">
      <Card style={styles.card}>
        <Text variant="rowTitle" role="heading" aria-level={2}>
          Notes by id
        </Text>
        <Text variant="meta" testID="admin-noteids-mode">
          {paused ? "Paused · " : ""}
          {modeLabel(report.mode)}
        </Text>
        <View style={styles.overall}>
          <Text style={styles.big}>{percent}</Text>
          <View style={styles.overallBar}>
            <Bar share={share} tone={report.totals.failed > 0 ? "crit" : share >= 1 ? "ok" : "warn"} wide />
            <Text variant="meta">{countsLine(report.totals)}</Text>
          </View>
        </View>
        <View style={styles.actions}>
          <Button
            label={busy === "start-all" ? "Starting…" : "Start all"}
            disabled={busy !== null}
            onPress={() => void startEverything()}
            testID="admin-noteids-start-all"
          />
          <Button
            label={busy === "pause" ? "Saving…" : pauseLabel(paused)}
            disabled={busy !== null}
            onPress={() => void togglePaused()}
            testID="admin-noteids-pause"
          />
          <Button
            label={busy === "diagnose-all" ? "Checking…" : "Diagnose all"}
            disabled={busy !== null}
            onPress={() => void diagnoseEverything()}
            testID="admin-noteids-diagnose-all"
          />
          {confirmingSwitch ? null : (
            <View style={styles.switchCell}>
              <Button
                label={switchLabel(report.mode)}
                disabled={busy !== null}
                onPress={() => setConfirmingSwitch(true)}
                testID="admin-noteids-switch"
              />
            </View>
          )}
        </View>
        {confirmingSwitch ? (
          <View style={styles.inline} role="alert" testID="admin-noteids-switch-confirm">
            <Text variant="check">{switchNote(report.mode)}</Text>
            <View style={styles.actions}>
              <Button label="Cancel" disabled={busy !== null} onPress={() => setConfirmingSwitch(false)} />
              <Button
                label={busy === "switch" ? "Switching…" : switchLabel(report.mode)}
                disabled={busy !== null}
                onPress={() => void switchMode()}
                testID="admin-noteids-switch-go"
              />
            </View>
          </View>
        ) : null}
        {said ? (
          <NoticeLine mark={said.tone === "ok" ? "✓" : "!"} tone={said.tone}>
            {said.text}
          </NoticeLine>
        ) : null}
      </Card>

      <Panel flush testID="admin-noteids-table">
        {rows.length === 0 ? (
          <EmptyNote title="No workspaces yet" body="Each workspace's copy shows here once it has notes to copy." />
        ) : (
          rows.map((entry, index) => (
            <WorkspaceRow
              key={entry.workspaceId}
              row={entry}
              first={index === 0}
              busy={busy}
              onRestart={() => void restartOne(entry.workspaceId)}
              onDiagnose={() => void diagnoseOne(entry.workspaceId)}
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
  onRestart,
  onDiagnose,
}: {
  row: NoteIdsWorkspace;
  first: boolean;
  busy: string | null;
  onRestart: () => void;
  onDiagnose: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const failing = isFailing(row);
  const diagnosis = diagnosisLine(row.diagnosis);
  const share = barShare(row.copied, row.files);
  return (
    <View style={[styles.row, !first && styles.ruled]} testID={`admin-noteids-row-${row.workspaceId}`}>
      <View style={styles.name}>
        <Text variant="rowTitle" numberOfLines={1} style={row.handle === null ? styles.muted : null}>
          {handleLabel(row.handle)}
        </Text>
      </View>
      <View style={styles.progress}>
        <Text variant="rowSub" style={styles.num}>
          {formatPercent(row.copied, row.files)}
        </Text>
        <Bar share={share} tone={rowTone(row)} />
      </View>
      <View style={styles.failedCell}>
        <Text variant="rowSub" style={failing && row.failed > 0 ? styles.bad : null}>
          {row.failed > 0 ? `${row.failed.toLocaleString("en-US")} failed` : "0 failed"}
        </Text>
      </View>
      <View style={styles.status}>
        <Text variant="rowSub" style={row.status === "failed" ? styles.bad : null} numberOfLines={2}>
          {statusLabel(row)}
        </Text>
        {diagnosis ? (
          <Text variant="meta" style={styles.num}>
            {diagnosis}
          </Text>
        ) : null}
      </View>
      <View style={styles.rowActions}>
        <Button
          label={busy === `restart:${row.workspaceId}` ? "Restarting…" : "Restart"}
          disabled={busy !== null}
          onPress={onRestart}
          testID={`admin-noteids-restart-${row.workspaceId}`}
        />
        <Button
          label={busy === `diagnose:${row.workspaceId}` ? "Checking…" : "Diagnose"}
          disabled={busy !== null}
          onPress={onDiagnose}
          testID={`admin-noteids-diagnose-${row.workspaceId}`}
        />
      </View>
    </View>
  );
}

function rowTone(row: NoteIdsWorkspace): DotTone {
  if (isFailing(row)) return "crit";
  if (row.status === "done") return "ok";
  if (row.status === "copying") return "warn";
  return "neutral";
}

function Bar({ share, tone, wide = false }: { share: number; tone: DotTone; wide?: boolean }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View
      style={[styles.bar, wide && styles.barWide]}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(share * 100)}
    >
      <View style={[styles.fill, styles[tone], { width: `${Math.round(share * 100)}%` }]} />
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    view: { gap: space.x4 },
    card: { gap: space.x2 },
    gap: { marginTop: 14 },
    overall: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.x4, marginTop: space.x2 },
    big: { fontSize: pointerType.title, fontWeight: "600", letterSpacing: -0.9, color: colors.text, fontVariant: ["tabular-nums"] },
    overallBar: { flexGrow: 1, flexBasis: 220, gap: space.x2 },
    actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.x2, paddingTop: space.x2 },
    switchCell: { marginLeft: "auto" },
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
    progress: { flexGrow: 1, flexBasis: 170, gap: 4, minWidth: 0 },
    failedCell: { flexBasis: 80, flexGrow: 0 },
    status: { flexGrow: 2, flexBasis: 200, gap: 4, minWidth: 0 },
    rowActions: { flexDirection: "row", flexWrap: "wrap", gap: space.x2, marginLeft: "auto" },
    muted: { color: colors.muted },
    num: { fontVariant: ["tabular-nums"] },
    bad: { color: colors.critText },
    bar: { height: 5, width: 120, maxWidth: "100%", borderRadius: 3, backgroundColor: colors.line, overflow: "hidden" },
    barWide: { width: "100%" },
    fill: { height: "100%", borderRadius: 3 },
    ok: { backgroundColor: colors.ok },
    warn: { backgroundColor: colors.warn },
    crit: { backgroundColor: colors.crit },
    neutral: { backgroundColor: colors.muted },
  });
