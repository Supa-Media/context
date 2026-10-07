/**
 * The Search tab's indexing panel: every workspace's search-by-meaning index,
 * what went wrong with the ones that failed, and Restart.
 *
 * Asked for by the owner, 2026-10-07 ("make sure I can restart indexing from
 * admin tab"). Over `meaningIndexReport` and `restartMeaningIndexing`
 * (`apps/convex/functions/lib/adminFns/meaningIndexes.ts`); the words are
 * `./meaningIndexes`. A restart never turns on a workspace whose owner turned
 * search by meaning off, so those rows offer no button.
 */

import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { Button, Pill, Text, space, useThemedStyles, type Colors } from "../design";
import { EmptyNote, NoticeLine, Panel, useCompact } from "./AdminKit";
import { ListRow, TableHead, TableRow, type Column } from "./AdminTable";
import { messageFor } from "./SecretDialogs";
import { whenLabel } from "./agent";
import {
  canRestartMeaning,
  meaningFailureLine,
  meaningProgressLine,
  meaningStatePill,
  restartedLine,
  stuckMeaningCount,
  type MeaningIndexRow,
} from "./meaningIndexes";

const COLUMNS: readonly Column[] = [
  { label: "Workspace", flex: 1.4 },
  { label: "State", flex: 1.1 },
  { label: "Notes", flex: 1.2 },
  { label: "What went wrong", flex: 2 },
  { label: "Changed", flex: 0.9 },
  { label: "", flex: 0.9, align: "right" },
];

export function MeaningIndexPanel() {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  const report = useQuery(api.functions.admin.meaningIndexReport, {});
  const restart = useMutation(api.functions.admin.restartMeaningIndexing);
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<{ text: string; tone: "ok" | "crit" } | null>(null);

  async function run(key: string, workspaceId?: string) {
    setBusy(key);
    setSaid(null);
    try {
      const result = await restart(workspaceId ? { workspaceId: workspaceId as Id<"workspaces"> } : {});
      setSaid({ text: restartedLine(result.restarted, result.outcome), tone: "ok" });
    } catch (caught) {
      setSaid({ text: messageFor(caught, "That didn't work. Try again."), tone: "crit" });
    } finally {
      setBusy(null);
    }
  }

  if (report === undefined) return null;
  const stuck = stuckMeaningCount(report.rows);
  const now = Date.now();

  const restartButton = (row: MeaningIndexRow) =>
    canRestartMeaning(row) ? (
      <Button
        label={busy === row.workspaceId ? "Restarting…" : "Restart"}
        disabled={busy !== null}
        onPress={() => void run(row.workspaceId, row.workspaceId)}
        testID={`admin-meaning-restart-${row.slug ?? row.workspaceId}`}
      />
    ) : null;

  return (
    <Panel flush title="Search by meaning" meta={`${report.rows.length} workspaces`} testID="admin-meaning">
      <View style={styles.head}>
        <Text variant="meta" style={styles.grow}>
          Restart picks up where indexing stopped. It never turns on a workspace whose owner turned it off.
        </Text>
        <Button
          label={busy === "all" ? "Restarting…" : `Restart everything stuck (${stuck})`}
          disabled={busy !== null || stuck === 0}
          onPress={() => void run("all")}
          testID="admin-meaning-restart-all"
        />
      </View>
      {said ? (
        <View style={styles.said}>
          <NoticeLine mark={said.tone === "ok" ? "✓" : "!"} tone={said.tone}>
            {said.text}
          </NoticeLine>
        </View>
      ) : null}
      {report.truncated ? (
        <View style={styles.said}>
          <NoticeLine mark="!" tone="warn">
            There are more workspaces than the panel reads at once; the ones that need attention come first.
          </NoticeLine>
        </View>
      ) : null}
      {report.rows.length === 0 ? (
        <EmptyNote title="No workspace has an index yet" body="The rollout reaches every workspace with storage, a batch every 15 minutes." />
      ) : compact ? (
        report.rows.map((row, index) => {
          const pill = meaningStatePill(row);
          const failure = meaningFailureLine(row);
          return (
            <ListRow
              key={row.workspaceId}
              first={index === 0}
              title={row.slug ? `@${row.slug}` : "a deleted workspace"}
              sub={[meaningProgressLine(row), failure].filter(Boolean).join(" · ")}
              trailing={
                <View style={styles.trailing}>
                  <Pill tone={pill.tone}>{pill.label}</Pill>
                  {restartButton(row)}
                </View>
              }
              testID={`admin-meaning-row-${row.slug ?? row.workspaceId}`}
            />
          );
        })
      ) : (
        <>
          <TableHead columns={COLUMNS} />
          {report.rows.map((row, index) => {
            const pill = meaningStatePill(row);
            return (
              <TableRow
                key={row.workspaceId}
                columns={COLUMNS}
                last={index === report.rows.length - 1}
                testID={`admin-meaning-row-${row.slug ?? row.workspaceId}`}
                cells={[
                  <Text key="ws" variant="rowTitle" numberOfLines={1}>
                    {row.slug ? `@${row.slug}` : "a deleted workspace"}
                  </Text>,
                  <Pill key="state" tone={pill.tone}>
                    {pill.label}
                  </Pill>,
                  <Text key="notes" variant="rowSub" style={styles.num}>
                    {meaningProgressLine(row)}
                  </Text>,
                  <Text key="why" variant="rowSub" numberOfLines={2}>
                    {meaningFailureLine(row) ?? "—"}
                  </Text>,
                  <Text key="when" variant="rowSub">
                    {whenLabel(row.updatedAt, now)}
                  </Text>,
                  <View key="restart" style={styles.right}>
                    {restartButton(row)}
                  </View>,
                ]}
              />
            );
          })}
        </>
      )}
    </Panel>
  );
}

const makeStyles = (_colors: Colors) =>
  StyleSheet.create({
    head: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      gap: space.x3,
      paddingHorizontal: space.x4,
      paddingVertical: space.x3,
    },
    said: { paddingHorizontal: space.x4, paddingBottom: space.x3 },
    grow: { flexGrow: 1, flexShrink: 1, flexBasis: 240 },
    trailing: { alignItems: "flex-end", gap: 6 },
    right: { alignItems: "flex-end" },
    num: { fontVariant: ["tabular-nums"] },
  });
