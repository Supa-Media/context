/**
 * The Search tab's tree index panel: every workspace's tree table (what the
 * sidebar is drawn from), how full it is, and Fill.
 *
 * Asked for by the owner, 2026-10-08 ("I need to see this in the admin panel,
 * the health of everyone's tree index, also why can't we just run all of them
 * now"). Over `treeIndexes` and `fillTreeIndexesNow` (`functions/treeAdmin.ts`).
 * The state lives in each workspace's own database, so it is read on open and
 * on Refresh rather than live.
 */

import { useCallback, useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useAction } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { Button, Pill, Text, space, useThemedStyles, type Colors } from "../design";
import { EmptyNote, NoticeLine, Panel, useCompact } from "./AdminKit";
import { ListRow, TableHead, TableRow, type Column } from "./AdminTable";
import { messageFor } from "./SecretDialogs";
import { whenLabel } from "./agent";

type Row = {
  workspaceId: string;
  slug: string | null;
  status: "ready" | "filling" | "empty" | "unsupported" | "unreachable";
  rows: number | null;
  sweptAt: number | null;
  dirty: boolean;
  error: string | null;
};

const PILLS: Record<Row["status"], { label: string; tone: "ok" | "warn" | "crit" | "neutral" }> = {
  ready: { label: "Ready", tone: "ok" },
  filling: { label: "Filling", tone: "warn" },
  empty: { label: "Not filled", tone: "crit" },
  unsupported: { label: "Can't fill", tone: "neutral" },
  unreachable: { label: "Can't reach", tone: "crit" },
};

const COLUMNS: readonly Column[] = [
  { label: "Workspace", flex: 1.4 },
  { label: "State", flex: 1 },
  { label: "Notes and files", flex: 1.2 },
  { label: "Last filled", flex: 1 },
  { label: "", flex: 0.9, align: "right" },
];

/** The pill: a sweep whose last pass failed reads as stuck, whatever its state. */
function pillOf(row: Row): { label: string; tone: "ok" | "warn" | "crit" | "neutral" } {
  return row.error !== null && row.status !== "unreachable" ? { label: "Stuck", tone: "crit" } : PILLS[row.status];
}

function stuckLine(row: Row): string | null {
  return row.error === null ? null : `Last pass failed: ${row.error}`;
}

function countLine(row: Row): string {
  if (row.rows === null) return "—";
  const count = row.rows.toLocaleString("en-US");
  return row.dirty ? `${count}, catching up` : count;
}

export function TreeIndexPanel() {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  const read = useAction(api.functions.treeAdmin.treeIndexes);
  const fill = useAction(api.functions.treeAdmin.fillTreeIndexesNow);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<{ text: string; tone: "ok" | "crit" } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setRows((await read({})).rows);
    } catch (caught) {
      setSaid({ text: messageFor(caught, "Couldn't read the tree indexes. Try again."), tone: "crit" });
    }
  }, [read]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run(key: string, workspaceId?: string) {
    setBusy(key);
    setSaid(null);
    try {
      const { started } = await fill(workspaceId ? { workspaceId: workspaceId as Id<"workspaces"> } : {});
      setSaid({
        text: started === 1 ? "Filling 1 workspace. Refresh to see it move." : `Filling ${started} workspaces. Refresh to see them move.`,
        tone: "ok",
      });
      await refresh();
    } catch (caught) {
      setSaid({ text: messageFor(caught, "That didn't work. Try again."), tone: "crit" });
    } finally {
      setBusy(null);
    }
  }

  const fillButton = (row: Row) =>
    row.status === "unsupported" || row.status === "unreachable" ? null : (
      <Button
        label={busy === row.workspaceId ? "Starting…" : row.status === "ready" ? "Refill" : "Fill"}
        disabled={busy !== null}
        onPress={() => void run(row.workspaceId, row.workspaceId)}
        testID={`admin-tree-fill-${row.slug ?? row.workspaceId}`}
      />
    );

  const now = Date.now();
  const unfilled = (rows ?? []).filter((row) => row.status === "empty").length;
  const name = (row: Row) => (row.slug ? `@${row.slug}` : "a deleted workspace");

  return (
    <Panel flush title="Tree index" meta={rows ? `${rows.length} workspaces` : undefined} testID="admin-tree">
      <View style={styles.head}>
        <Text variant="meta" style={styles.grow}>
          The sidebar is drawn from this index instead of walking the workspace's storage. A workspace that isn't filled
          still works, just slower. Filling runs in the background and keeps itself current after that.
        </Text>
        <Button label="Refresh" disabled={busy !== null} onPress={() => void refresh()} testID="admin-tree-refresh" />
        <Button
          label={busy === "all" ? "Starting…" : `Fill all${unfilled > 0 ? ` (${unfilled} not filled)` : ""}`}
          disabled={busy !== null || rows === null || rows.length === 0}
          onPress={() => void run("all")}
          testID="admin-tree-fill-all"
        />
      </View>
      {said ? (
        <View style={styles.said}>
          <NoticeLine mark={said.tone === "ok" ? "✓" : "!"} tone={said.tone}>
            {said.text}
          </NoticeLine>
        </View>
      ) : null}
      {rows === null ? null : rows.length === 0 ? (
        <EmptyNote title="No workspace has fast search yet" body="The tree index lives in a workspace's fast search database." />
      ) : compact ? (
        rows.map((row, index) => (
          <ListRow
            key={row.workspaceId}
            first={index === 0}
            title={name(row)}
            sub={[countLine(row), row.sweptAt ? `Filled ${whenLabel(row.sweptAt, now)}` : null, stuckLine(row)]
              .filter(Boolean)
              .join("\n")}
            trailing={
              <View style={styles.trailing}>
                <Pill tone={pillOf(row).tone}>{pillOf(row).label}</Pill>
                {fillButton(row)}
              </View>
            }
            testID={`admin-tree-row-${row.slug ?? row.workspaceId}`}
          />
        ))
      ) : (
        <>
          <TableHead columns={COLUMNS} />
          {rows.map((row, index) => (
            <TableRow
              key={row.workspaceId}
              columns={COLUMNS}
              last={index === rows.length - 1}
              testID={`admin-tree-row-${row.slug ?? row.workspaceId}`}
              cells={[
                <Text key="ws" variant="rowTitle" numberOfLines={1}>
                  {name(row)}
                </Text>,
                <Pill key="state" tone={pillOf(row).tone}>
                  {pillOf(row).label}
                </Pill>,
                <View key="rows">
                  <Text variant="rowSub" style={styles.num}>
                    {countLine(row)}
                  </Text>
                  {row.error === null ? null : (
                    <Text variant="rowSub" numberOfLines={2}>
                      {stuckLine(row)}
                    </Text>
                  )}
                </View>,
                <Text key="when" variant="rowSub">
                  {row.sweptAt ? whenLabel(row.sweptAt, now) : "—"}
                </Text>,
                <View key="fill" style={styles.right}>
                  {fillButton(row)}
                </View>,
              ]}
            />
          ))}
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
