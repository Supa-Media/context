/**
 * The staff console's small furniture: a titled panel, the quiet `?` that
 * holds what used to be a paragraph, two panels side by side, the notices,
 * skeleton blocks and the "nothing yet" note. Tables are in `./AdminTable`.
 *
 * Everything is built from the design system's tokens and `Card`; nothing here
 * is a new colour or a new shape. It exists so the four tabs draw a panel and
 * an empty state the same way rather than four times.
 */

import { Children, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, useWindowDimensions, View, type ViewStyle } from "react-native";
import { densityFor } from "../app/frame";
import {
  Card,
  Notice,
  Text,
  leading,
  radii,
  space,
  useThemedStyles,
  type Colors,
} from "../design";
import { pointerType, touchType } from "../design/tokens";
import { formatSigned } from "./report";

/**
 * Phone or not. The console lays out as tables and two columns above the
 * app's narrow breakpoint and as stacked rows below it — the same test every
 * other surface makes, so a tablet in portrait gets what the app gives it
 * everywhere else.
 */
export function useCompact(): boolean {
  return densityFor(useWindowDimensions().width) === "compact";
}

/** Card padding, so a table or a fact row can bleed to the card's edge. */
export function usePanelPad(): { x: number; y: number } {
  return useCompact() ? { x: space.x4, y: space.x4 } : { x: space.x5, y: 18 };
}

/**
 * Two panels side by side above the phone breakpoint, stacked below it.
 *
 * Each child gets `flexBasis: 0` and an equal share of a *row*, which is the
 * one place a basis means a width. The old page put `flexBasis: 320` on every
 * panel, including the ones in a column — see `Panel`.
 */
export function TwoUp({ children }: { children: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  return (
    <View style={compact ? styles.stack : styles.twoUp}>
      {Children.map(children, (child) =>
        child === null || child === undefined || child === false ? null : (
          <View style={compact ? null : styles.half}>{child}</View>
        ),
      )}
    </View>
  );
}

/** A signed change, coloured by direction: `+5`, `−2`, `±0`. */
export function DeltaText({ change }: { change: number }) {
  const styles = useThemedStyles(makeStyles);
  const tone = change > 0 ? styles.up : change < 0 ? styles.down : styles.flat;
  // A size of its own: `Text` without a variant is the 16pt body voice, and
  // this sits inside 12pt captions.
  return <Text style={[styles.delta, tone]}>{formatSigned(change)}</Text>;
}

/**
 * The one sentence that has to appear when the census stopped counting.
 *
 * Every figure below it is then a floor, and the trend curves are **withheld
 * rather than drawn**, because a cumulative line missing an arbitrary slice of
 * its rows is not a less precise chart — it is a different and wrong shape.
 * Same rule the storage card follows for a note count it could not finish.
 */
export function TruncatedNotice({ truncated }: { truncated: boolean }) {
  const styles = useThemedStyles(makeStyles);
  if (!truncated) return null;
  return (
    <Notice tone="warn" testID="admin-census-truncated">
      <View style={styles.noticeRow}>
        <Text style={[styles.noticeMark, styles.warnMark]}>!</Text>
        <Text variant="check" style={styles.noticeText}>
          <Text variant="check" style={styles.strong}>
            The census hit its page limit.
          </Text>{" "}
          Figures are floors, and the growth curves are hidden until counting is
          replaced with maintained totals.
        </Text>
      </View>
    </Notice>
  );
}

/** A notice's leading mark and sentence, laid out the way `TruncatedNotice` is. */
export function NoticeLine({
  mark,
  tone,
  children,
}: {
  mark: string;
  tone: "ok" | "warn" | "crit" | "neutral";
  children: ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  const markTone =
    tone === "ok" ? styles.okMark : tone === "warn" ? styles.warnMark : tone === "crit" ? styles.critMark : null;
  return (
    <View style={styles.noticeRow}>
      <Text style={[styles.noticeMark, markTone]}>{mark}</Text>
      <Text variant="check" style={styles.noticeText}>
        {children}
      </Text>
    </View>
  );
}

/**
 * A panel: a `Card` with a heading, an optional note on the right, and an
 * optional `?` whose explanation opens under the heading.
 *
 * `flush` drops the card's padding for a panel whose body is a table or a
 * list of rows running edge to edge; the heading keeps its inset.
 */
export function Panel({
  title,
  meta,
  metaWide = false,
  help,
  flush = false,
  children,
  style,
  testID,
}: {
  title?: string;
  meta?: string;
  /** Show `meta` only above the phone breakpoint, where it has room. */
  metaWide?: boolean;
  help?: string;
  flush?: boolean;
  children: ReactNode;
  style?: ViewStyle;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  return (
    <Card
      style={StyleSheet.flatten([
        styles.panel,
        compact && styles.panelCompact,
        flush && styles.flush,
        style,
      ])}
      testID={testID}
    >
      {title ? (
        <PanelHead
          title={title}
          meta={metaWide && compact ? undefined : meta}
          help={help}
          inset={flush}
        />
      ) : null}
      {children}
    </Card>
  );
}

function PanelHead({
  title,
  meta,
  help,
  inset,
}: {
  title: string;
  meta?: string;
  help?: string;
  inset: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  const [open, setOpen] = useState(false);
  return (
    <View style={[styles.headWrap, inset && (compact ? styles.insetCompact : styles.inset)]}>
      <View style={styles.head}>
        <View style={styles.headTitle}>
          <Text
            variant="rowTitle"
            role="heading"
            aria-level={2}
            style={compact ? styles.titleCompact : styles.title}
          >
            {title}
          </Text>
          {help ? <HelpMark open={open} onToggle={() => setOpen((was) => !was)} label={title} /> : null}
        </View>
        {meta && !(compact && open) ? (
          <Text variant="meta" style={styles.meta} numberOfLines={1}>
            {meta}
          </Text>
        ) : null}
      </View>
      {help && open ? (
        <Text variant="rowSub" style={styles.helpText}>
          {help}
        </Text>
      ) : null}
    </View>
  );
}

/** The `?`. A press rather than a hover, so it works under a thumb. */
function HelpMark({
  open,
  onToggle,
  label,
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      role="button"
      accessibilityLabel={`About ${label}`}
      aria-expanded={open}
      onPress={onToggle}
      hitSlop={10}
      style={[styles.help, open && styles.helpOn]}
    >
      <Text style={styles.helpGlyph} aria-hidden>
        ?
      </Text>
    </Pressable>
  );
}

// -- states ---------------------------------------------------------------

/** "Nothing here yet", centred, with an optional action under it. */
export function EmptyNote({
  title,
  body,
  action,
  tall = false,
  testID,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
  tall?: boolean;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={[styles.empty, tall && styles.emptyTall]} testID={testID}>
      <Text variant="rowTitle">{title}</Text>
      {body ? (
        <Text variant="paneSub" style={styles.emptyBody}>
          {body}
        </Text>
      ) : null}
      {action ? <View style={styles.emptyAction}>{action}</View> : null}
    </View>
  );
}

/** A grey block the shape of what is loading. */
export function Skeleton({ width, height, style }: { width: number | `${number}%`; height: number; style?: ViewStyle }) {
  const styles = useThemedStyles(makeStyles);
  return <View style={[styles.skeleton, { width, height }, style]} aria-hidden />;
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    /*
      No `flexBasis` here, and that is the bug this replaced: the old panel
      carried `flexBasis: 320` so two could share a row, but most panels sat
      in a *column*, where the basis is a height — every panel was 320 tall,
      short content floated in empty space and long content (the roster, the
      provider list, the client list) spilled out over the card below. Two-up
      rows now size their own children (`TwoUp`).
    */
    panel: { paddingVertical: 18, paddingHorizontal: space.x5, minWidth: 0 },
    panelCompact: { paddingHorizontal: space.x4, paddingVertical: space.x4 },
    flush: { paddingVertical: 0, paddingHorizontal: 0, overflow: "hidden" },
    headWrap: { marginBottom: space.x3 + 2 },
    inset: { paddingHorizontal: space.x5, paddingTop: space.x4, marginBottom: space.x2 },
    insetCompact: { paddingHorizontal: space.x4, paddingTop: space.x4, marginBottom: space.x2 },
    head: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "baseline",
      justifyContent: "space-between",
      columnGap: space.x3,
    },
    headTitle: { flexDirection: "row", alignItems: "center", gap: 6 },
    title: { fontSize: pointerType.lede, lineHeight: leading(pointerType.lede, 1.4) },
    titleCompact: { fontSize: touchType.lede, lineHeight: leading(touchType.lede, 1.4) },
    meta: { flexShrink: 1 },
    helpText: { marginTop: space.x1, maxWidth: 560 },
    help: {
      width: 16,
      height: 16,
      borderRadius: radii.pill,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      alignItems: "center",
      justifyContent: "center",
    },
    helpOn: { borderColor: colors.accent, backgroundColor: colors.accentDim },
    helpGlyph: { fontSize: pointerType.label, lineHeight: pointerType.label + 1, fontWeight: "700", color: colors.muted },

    empty: { alignItems: "center", paddingVertical: space.x7, paddingHorizontal: space.x5 },
    emptyTall: { paddingVertical: 48 },
    emptyBody: { textAlign: "center", marginTop: 2, maxWidth: 420 },
    emptyAction: { marginTop: space.x4 },
    skeleton: { borderRadius: radii.xs, backgroundColor: colors.surface3 },

    stack: { gap: space.x3 },
    twoUp: { flexDirection: "row", gap: space.x4, alignItems: "stretch" },
    half: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 },

    delta: {
      fontSize: pointerType.meta,
      lineHeight: leading(pointerType.meta, 1.55),
      fontWeight: "600",
      fontVariant: ["tabular-nums"],
    },
    up: { color: colors.okText },
    down: { color: colors.critText },
    flat: { color: colors.muted },

    noticeRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
    noticeMark: { fontWeight: "700", fontSize: pointerType.ui, lineHeight: leading(pointerType.ui, 1.55) },
    okMark: { color: colors.ok },
    warnMark: { color: colors.warn },
    critMark: { color: colors.crit },
    noticeText: { flex: 1, minWidth: 0 },
    strong: { color: colors.text, fontWeight: "600" },
  });
