/**
 * The AI tab's own furniture, shared by every screen of boards 8-16: the page
 * head with its crumbs, the "Next:" line, the stat strip, a status pill for a
 * setup, the one quiet button, and a table whose cells never overflow (the
 * owner, 2026-10-16: "in a lot of pages, the text overflows"). Every cell is
 * one line, or two with the second clamped; columns have fixed widths or a
 * flex weight, never their content's width.
 */

import type { ReactNode } from "react";
import { Pressable, StyleSheet, View, type ViewStyle } from "react-native";
import { Pill, Text, space, useThemedStyles, type Colors, type PillTone } from "../design";
import { useCompact } from "./AdminKit";
import { ListRow, TableHead, TableRow, type Column } from "./AdminTable";
import type { SetupStatus } from "./aiModel";

export { Primary } from "./AiViews";
export type { Column } from "./AdminTable";

/** The page's head: crumbs that go back, a one-line title, a short line beside it, and buttons on the right. */
export function PageHead({ crumbs = [], title, sub, actions, testID }: {
  crumbs?: readonly { label: string; onPress: () => void }[];
  title: string;
  sub?: string;
  actions?: ReactNode;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.head} testID={testID}>
      <View style={styles.headLeft}>
        {crumbs.map((crumb) => (
          <Pressable key={crumb.label} role="link" onPress={crumb.onPress} hitSlop={6}>
            <Text variant="meta" numberOfLines={1}>{`${crumb.label} ›`}</Text>
          </Pressable>
        ))}
        <Text variant="paneTitle" role="heading" aria-level={1} numberOfLines={1} style={styles.title}>{title}</Text>
        {sub ? <Text variant="meta" numberOfLines={1} style={styles.headSub}>{sub}</Text> : null}
      </View>
      {actions ? <View style={styles.actions}>{actions}</View> : null}
    </View>
  );
}

/** The quiet, outlined button beside a `Primary`. */
export function Quiet({ label, onPress, disabled = false, tone = "neutral", testID }: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  /** `crit` for the one-way step's own button, drawn in bold red per the console's rule. */
  tone?: "neutral" | "crit";
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      role="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.quiet, tone === "crit" && styles.quietCrit, disabled && styles.off]}
      testID={testID}
    >
      <Text variant="mini" numberOfLines={1} style={tone === "crit" ? styles.critStrong : styles.strong}>{label}</Text>
    </Pressable>
  );
}

/** A link in running text or a cell: the accent, one line. */
export function LinkText({ label, onPress, testID }: { label: string; onPress: () => void; testID?: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable role="link" onPress={onPress} hitSlop={4} testID={testID}>
      <Text variant="meta" numberOfLines={1} style={styles.link}>{label}</Text>
    </Pressable>
  );
}

/** Board 9's "Next:" line: a rule on the left, the step, and where to do it. */
export function NextLine({ children, action, onAction, testID }: { children: ReactNode; action?: string; onAction?: () => void; testID?: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.next} testID={testID}>
      <Text variant="meta" numberOfLines={2} style={styles.nextText}>
        <Text variant="meta" style={styles.strong}>Next: </Text>
        {children}
      </Text>
      {action && onAction ? <LinkText label={`${action} ›`} onPress={onAction} testID={testID ? `${testID}-go` : undefined} /> : null}
    </View>
  );
}

export interface Stat {
  label: string;
  value: string;
  sub?: string;
  tone?: "ok" | "warn" | "crit" | "neutral";
}

/** A strip of figures with a line under each, as the job page's head draws it. */
export function StatStrip({ stats, testID }: { stats: readonly Stat[]; testID?: string }) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  return (
    <View style={[styles.strip, compact && styles.stripCompact]} testID={testID}>
      {stats.map((stat, index) => (
        <View key={stat.label} style={[styles.stat, index > 0 && !compact && styles.statRule]}>
          <Text variant="eyebrow" numberOfLines={1}>{stat.label}</Text>
          <Text variant="statValue" numberOfLines={1} style={stat.tone ? styles[stat.tone] : null}>{stat.value}</Text>
          {stat.sub ? <Text variant="meta" numberOfLines={2}>{stat.sub}</Text> : null}
        </View>
      ))}
    </View>
  );
}

const STATUS: Record<SetupStatus, { label: string; tone: PillTone }> = {
  live: { label: "Live", tone: "ok" },
  "beat live": { label: "Beat live · needs yes", tone: "warn" },
  tied: { label: "Tied", tone: "neutral" },
  lost: { label: "Lost", tone: "neutral" },
  "not run": { label: "Not run", tone: "neutral" },
  draft: { label: "Draft", tone: "neutral" },
  retired: { label: "Retired", tone: "neutral" },
};

export function StatusPill({ status, cheaper = false }: { status: SetupStatus; cheaper?: boolean }) {
  const shown = STATUS[status];
  return <Pill tone={shown.tone}>{status === "tied" && cheaper ? "Tied · smaller" : shown.label}</Pill>;
}

/** A cell's text: a title on one line and, under it, a second line clamped to one. */
export function Cell({ title, sub, strong = false, tone, align }: { title: string; sub?: string | null; strong?: boolean; tone?: "ok" | "warn" | "crit"; align?: "right" }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.cell}>
      <Text variant={strong ? "rowTitle" : "meta"} numberOfLines={1} style={[tone ? styles[tone] : null, align === "right" && styles.right]}>{title}</Text>
      {sub ? <Text variant="meta" numberOfLines={1} style={align === "right" ? styles.right : null}>{sub}</Text> : null}
    </View>
  );
}

/** One table row that may open something: a table row on a pointer, a two-line row on a phone. */
export function TableLine({ columns, cells, title, sub, trailing, first, last, selected = false, onPress, testID }: {
  columns: readonly Column[];
  cells: readonly ReactNode[];
  title: string;
  sub?: string;
  trailing?: ReactNode;
  first: boolean;
  last: boolean;
  selected?: boolean;
  onPress?: () => void;
  testID: string;
}) {
  const compact = useCompact();
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      role={onPress ? "button" : undefined}
      disabled={!onPress}
      onPress={onPress}
      style={(state) => [selected && styles.selected, (state as { hovered?: boolean }).hovered && onPress ? styles.hover : null]}
      testID={testID}
    >
      {compact ? <ListRow first={first} title={title} sub={sub} trailing={trailing} /> : <TableRow columns={columns} cells={cells} last={last} />}
    </Pressable>
  );
}

/** A table's header, on a pointer only. */
export function Head({ columns }: { columns: readonly Column[] }) {
  const compact = useCompact();
  return compact ? null : <TableHead columns={columns} />;
}

/** A titled box with something on its right, for the panels inside a page. */
export function Box({ title, right, children, style, testID }: { title?: string; right?: ReactNode; children: ReactNode; style?: ViewStyle; testID?: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={[styles.box, style]} testID={testID}>
      {title || right ? (
        <View style={styles.boxHead}>
          {title ? <Text variant="rowTitle" numberOfLines={1} style={styles.boxTitle}>{title}</Text> : <View />}
          {right}
        </View>
      ) : null}
      {children}
    </View>
  );
}

/** A plain line of quiet text, for an empty table or a footnote. */
export function Quietly({ children, testID }: { children: ReactNode; testID?: string }) {
  const styles = useThemedStyles(makeStyles);
  return <Text variant="meta" style={styles.quietly} testID={testID}>{children}</Text>;
}

/** A one-way door's warning, bold red and inline (no tinted box: the console's rule). */
export function OneWay({ children, testID }: { children: ReactNode; testID?: string }) {
  const styles = useThemedStyles(makeStyles);
  return <Text variant="meta" style={styles.critStrong} testID={testID}>{children}</Text>;
}

/** Two boxes side by side above the phone breakpoint; `weights` share the row. */
export function Columns({ children, weights = [] }: { children: ReactNode[]; weights?: readonly number[] }) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  return (
    <View style={compact ? styles.stack : styles.columns}>
      {children.map((child, index) => (
        <View key={index} style={compact ? null : { flex: weights[index] ?? 1, minWidth: 0 }}>{child}</View>
      ))}
    </View>
  );
}

/** `when` as a short day: "Oct 14", or the time today. */
export function shortDay(at: number | null, now = Date.now()): string {
  if (at === null || at === 0) return "";
  const date = new Date(at);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (date.toDateString() === new Date(now - 86_400_000).toDateString()) return "Yesterday";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** A percentage as a cell shows it: `93%`, `93.3%` kept to one place, `—` for none. */
export function pct(score: number | null): string {
  return score === null ? "—" : `${Number(score.toFixed(1))}%`;
}

/** Dollars a question as cents: `0.9¢`. */
export function cents(dollars: number | null): string {
  if (dollars === null) return "—";
  const value = dollars * 100;
  return `${value >= 10 ? Math.round(value) : Number(value.toFixed(value >= 1 ? 1 : 2))}¢`;
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.x3, flexWrap: "wrap" },
    headLeft: { flexDirection: "row", alignItems: "center", gap: space.x2, flexShrink: 1, minWidth: 0 },
    title: { flexShrink: 1 },
    headSub: { flexShrink: 1 },
    actions: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    quiet: { borderRadius: 8, borderWidth: 1, borderColor: colors.line, paddingVertical: 7, paddingHorizontal: 12, backgroundColor: colors.surface },
    quietCrit: { borderColor: colors.crit },
    off: { opacity: 0.4 },
    strong: { color: colors.text, fontWeight: "600" },
    critStrong: { color: colors.critText, fontWeight: "700" },
    link: { color: colors.accentText, fontWeight: "600" },
    next: {
      flexDirection: "row",
      alignItems: "center",
      flexWrap: "wrap",
      gap: space.x3,
      paddingLeft: space.x3,
      paddingVertical: space.x1,
      borderLeftWidth: 3,
      borderLeftColor: colors.accent,
    },
    nextText: { flexShrink: 1, color: colors.text },
    strip: { flexDirection: "row", borderWidth: 1, borderColor: colors.line, borderRadius: 10, backgroundColor: colors.surface },
    stripCompact: { flexDirection: "column" },
    stat: { flex: 1, minWidth: 0, gap: space.x1, paddingVertical: space.x3, paddingHorizontal: space.x4 },
    statRule: { borderLeftWidth: 1, borderLeftColor: colors.line },
    ok: { color: colors.okText },
    warn: { color: colors.warnText },
    crit: { color: colors.critText },
    neutral: {},
    cell: { gap: 2, minWidth: 0 },
    right: { textAlign: "right" },
    selected: { backgroundColor: colors.rowSelected },
    hover: { backgroundColor: colors.chipFill },
    box: { borderWidth: 1, borderColor: colors.line, borderRadius: 10, backgroundColor: colors.surface, padding: space.x4, gap: space.x3, minWidth: 0 },
    boxHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.x3 },
    boxTitle: { flexShrink: 1 },
    quietly: { paddingVertical: space.x2 },
    columns: { flexDirection: "row", gap: space.x4, alignItems: "flex-start" },
    stack: { gap: space.x4 },
  });
