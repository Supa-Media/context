/**
 * The Indexes view's table (`./IndexesView`): one row per workspace, a column
 * per index, and a row that opens to show the T0/T1/T2 split, what went wrong,
 * and that workspace's Refill and Restart. On a phone a row is the workspace,
 * three dots (tree, fast, meaning) and the reason under it; a tap opens the
 * same detail.
 */

import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Button, Dot, Text, space, useThemedStyles, type Colors, type DotTone } from "../design";
import { useCompact } from "./AdminKit";
import { TableHead, type Column } from "./AdminTable";
import { whenLabel } from "./agent";
import { canRestartMeaning } from "./meaningIndexes";
import { INDEXES, tierLabel, type IndexCell, type IndexHealth, type IndexKey, type WorkspaceIndexes } from "./searchIndexes";

export type IndexActions = {
  busy: string | null;
  fill: (workspaceId: string) => void;
  restart: (workspaceId: string) => void;
};

export function healthTone(health: IndexHealth): DotTone {
  return health === "ok" ? "ok" : health === "working" ? "warn" : health === "stuck" ? "crit" : "neutral";
}

const COLUMNS: readonly Column[] = [
  { label: "Workspace", flex: 1.1 },
  { label: "Sidebar tree", flex: 1.3 },
  { label: "Fast search", flex: 1.5 },
  { label: "Search by meaning", flex: 1.8 },
  { label: "Changed", flex: 0.8 },
  { label: "", width: 28, align: "right" },
];

const name = (row: WorkspaceIndexes) => (row.slug ? `@${row.slug}` : "a deleted workspace");

export function IndexRows({ rows, actions }: { rows: readonly WorkspaceIndexes[]; actions: IndexActions }) {
  const compact = useCompact();
  const [open, setOpen] = useState<string | null>(null);
  const toggle = (id: string) => setOpen((was) => (was === id ? null : id));
  return (
    <>
      {compact ? null : <TableHead columns={COLUMNS} />}
      {rows.map((row, index) => (
        <Row
          key={row.workspaceId}
          row={row}
          first={index === 0}
          open={open === row.workspaceId}
          onToggle={() => toggle(row.workspaceId)}
          actions={actions}
        />
      ))}
    </>
  );
}

function Row({
  row,
  first,
  open,
  onToggle,
  actions,
}: {
  row: WorkspaceIndexes;
  first: boolean;
  open: boolean;
  onToggle: () => void;
  actions: IndexActions;
}) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  const now = Date.now();
  const id = row.slug ?? row.workspaceId;
  return (
    <View style={[!first && styles.ruled, open && styles.openRow]} testID={`admin-indexes-row-${id}`}>
      <Pressable
        onPress={onToggle}
        role="button"
        aria-expanded={open}
        aria-label={`${name(row)}, ${open ? "hide" : "show"} details`}
        style={compact ? styles.compactHead : styles.tr}
        testID={`admin-indexes-open-${id}`}
      >
        {compact ? (
          <>
            <View style={styles.compactTop}>
              <Text variant="rowTitle" numberOfLines={1} style={styles.grow}>
                {name(row)}
              </Text>
              <View style={styles.dots} aria-label="Sidebar tree, fast search, search by meaning">
                <Dot tone={healthTone(row.tree.health)} />
                <Dot tone={healthTone(row.fast.health)} />
                <Dot tone={healthTone(row.meaning.health)} />
              </View>
            </View>
            <Text variant="meta">{compactLine(row)}</Text>
          </>
        ) : (
          <>
            <View style={[styles.td, { flex: 1.1 }]}>
              <Text variant="rowTitle" numberOfLines={1}>
                {name(row)}
              </Text>
            </View>
            <CellView cell={row.tree} flex={1.3} />
            <CellView cell={row.fast} flex={1.5} />
            <CellView cell={row.meaning} flex={1.8} />
            <View style={[styles.td, { flex: 0.8 }]}>
              <Text variant="rowSub">{row.changedAt === null ? "—" : whenLabel(row.changedAt, now)}</Text>
            </View>
            <View style={[styles.td, styles.chevBox]}>
              <Text variant="meta" aria-hidden>
                {open ? "▴" : "▾"}
              </Text>
            </View>
          </>
        )}
      </Pressable>
      {open ? <Detail row={row} actions={actions} /> : null}
    </View>
  );
}

function CellView({ cell, flex }: { cell: IndexCell; flex: number }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={[styles.td, styles.cell, { flex }]}>
      <View style={styles.cellTop}>
        {cell.health === "none" ? null : <Dot tone={healthTone(cell.health)} />}
        <Text variant="rowSub" style={styles.strong} numberOfLines={1}>
          {cell.label}
        </Text>
        {cell.figure ? (
          <Text variant="meta" style={styles.num} numberOfLines={1}>
            {cell.figure}
          </Text>
        ) : null}
      </View>
      {cell.progress ? <Bar done={cell.progress.done} total={cell.progress.total} tone={healthTone(cell.health)} /> : null}
      {cell.problem ? (
        <Text variant="meta" style={styles.problem} numberOfLines={1}>
          {cell.problem}
        </Text>
      ) : null}
    </View>
  );
}

/** A phone row's one line: what is not ready, in words, or that all three are. */
function compactLine(row: WorkspaceIndexes): string {
  const parts = INDEXES.filter((index) => row[index.key].health === "stuck" || row[index.key].health === "working").map(
    (index) => {
      const cell = row[index.key];
      const short = index.key === "tree" ? "Tree" : index.key === "fast" ? "Fast" : "Meaning";
      const said = `${short} ${cell.label.toLowerCase()}${cell.figure && cell.progress ? ` ${cell.figure}` : ""}`;
      return cell.problem ? `${said}: ${cell.problem}` : said;
    },
  );
  return parts.length === 0 ? "All ready" : parts.join(" · ");
}

function Detail({ row, actions }: { row: WorkspaceIndexes; actions: IndexActions }) {
  const styles = useThemedStyles(makeStyles);
  const id = row.slug ?? row.workspaceId;
  const now = Date.now();
  const tree = row.treeRow;
  const meaning = row.meaningRow;
  const canFill = tree !== null && tree.status !== "unsupported" && tree.status !== "unreachable";
  const canRestart = meaning !== null && canRestartMeaning(meaning);
  const button = (key: string, label: string, busyLabel: string, onPress: () => void, testID: string) => (
    <Button
      label={actions.busy === key ? busyLabel : label}
      disabled={actions.busy !== null}
      onPress={onPress}
      testID={testID}
    />
  );
  const columns: { key: IndexKey; action: ReactNode; note: string | null }[] = [
    {
      key: "tree",
      action: canFill
        ? button(
            `tree:${row.workspaceId}`,
            tree.status === "ready" ? "Refill" : "Fill",
            "Starting…",
            () => actions.fill(row.workspaceId),
            `admin-tree-fill-${id}`,
          )
        : null,
      note:
        tree === null
          ? "No sidebar tree yet. It lives in the workspace's fast search database."
          : [
              tree.rows === null ? null : `${tree.rows.toLocaleString("en-US")} notes and files.`,
              tree.sweptAt === null ? "Never filled." : `Last filled ${whenLabel(tree.sweptAt, now)}.`,
              tree.dirty ? "A big change is waiting for the next pass." : null,
            ]
              .filter(Boolean)
              .join(" "),
    },
    { key: "fast", action: null, note: row.fast.health === "none" ? "No fast search for this workspace." : null },
    {
      key: "meaning",
      action: canRestart
        ? button(`meaning:${row.workspaceId}`, "Restart", "Restarting…", () => actions.restart(row.workspaceId), `admin-meaning-restart-${id}`)
        : null,
      note:
        meaning === null
          ? "No search by meaning for this workspace yet."
          : !meaning.enabled
            ? "The owner turned search by meaning off."
            : null,
    },
  ];
  return (
    <View style={styles.detail} testID={`admin-indexes-detail-${id}`}>
      {columns.map((column) => {
        const cell = row[column.key];
        const label = INDEXES.find((index) => index.key === column.key)?.label ?? column.key;
        return (
          <View key={column.key} style={styles.dcol}>
            <View style={styles.dhead}>
              {cell.health === "none" ? null : <Dot tone={healthTone(cell.health)} />}
              <Text variant="rowTitle" style={styles.grow}>
                {label}
              </Text>
              {column.action}
            </View>
            {cell.tiers && cell.tiers.length > 0
              ? cell.tiers.map((tier) => (
                  <View key={tier.priority} style={styles.tier}>
                    <Text variant="meta" style={styles.tierName}>
                      {tierLabel(tier.priority)}
                    </Text>
                    <View style={styles.grow}>
                      <Bar done={tier.indexed} total={tier.indexed + tier.pending} tone={tier.pending > 0 ? "warn" : "ok"} wide />
                    </View>
                    <Text variant="meta" style={[styles.num, styles.tierCount]}>
                      {tier.indexed.toLocaleString("en-US")} / {(tier.indexed + tier.pending).toLocaleString("en-US")}
                    </Text>
                  </View>
                ))
              : cell.figure && column.key !== "tree"
                ? <Text variant="meta" style={styles.num}>{`${cell.label}, ${cell.figure} notes`}</Text>
                : null}
            {column.note ? <Text variant="meta">{column.note}</Text> : null}
            {cell.problem ? (
              <Text variant="meta" style={styles.problem}>
                {cell.problem}
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

function Bar({ done, total, tone, wide = false }: { done: number; total: number; tone: DotTone; wide?: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const share = total <= 0 ? 0 : Math.min(1, Math.max(0, done / total));
  return (
    <View
      style={[styles.bar, wide && styles.barWide]}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
    >
      <View style={[styles.fill, styles[tone], { width: `${Math.round(share * 100)}%` }]} />
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    ruled: { borderTopWidth: 1, borderTopColor: colors.line },
    openRow: { backgroundColor: colors.surface2 },
    tr: { flexDirection: "row", alignItems: "center", paddingHorizontal: space.x4, paddingVertical: space.x3, gap: space.x3 },
    td: { minWidth: 0 },
    cell: { gap: 4 },
    cellTop: { flexDirection: "row", alignItems: "center", gap: 6 },
    strong: { fontWeight: "600", color: colors.text },
    chevBox: { width: 28, alignItems: "flex-end" },
    compactHead: { paddingHorizontal: space.x4, paddingVertical: space.x3, gap: 4 },
    compactTop: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    dots: { flexDirection: "row", gap: 4 },
    grow: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
    problem: { color: colors.critText },
    detail: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: space.x3,
      paddingHorizontal: space.x4,
      paddingBottom: space.x4,
    },
    dcol: {
      flexGrow: 1,
      flexBasis: 240,
      gap: space.x2,
      padding: space.x3,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.surface,
    },
    dhead: { flexDirection: "row", alignItems: "center", gap: space.x2, minHeight: 28 },
    tier: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    tierName: { width: 64 },
    tierCount: { minWidth: 92, textAlign: "right" },
    bar: { height: 5, width: 120, maxWidth: "100%", borderRadius: 3, backgroundColor: colors.line, overflow: "hidden" },
    barWide: { width: "100%" },
    fill: { height: "100%", borderRadius: 3 },
    ok: { backgroundColor: colors.ok },
    warn: { backgroundColor: colors.warn },
    crit: { backgroundColor: colors.crit },
    neutral: { backgroundColor: colors.muted },
    num: { fontVariant: ["tabular-nums"] },
  });
