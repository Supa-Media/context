/**
 * An area's details beside the Areas list: one click on an area opens it here,
 * a double click opens the area's own page (the owner, 2026-11-24: "one click
 * open up the right panel, double click to get into more details"). It is the
 * side-panel prototype the owner tried, built: the name and its owner, the one
 * headline metric with its latest reading, trend and goal, the owner and their
 * agent with how to reach them, the modes, and the sub-areas.
 *
 * Everything is edited in place, with no pop-up (the owner, 2026-11-24: "why
 * cant I make changes inline?"): the metric's name and goal, then Owner and
 * Helper as dropdowns, the modes, and the holder's phone, email and whether
 * Tex answers for them (`PanelSeatFields.tsx`), the approval rules, the
 * sub-areas and the area's notes. Each change is the seat's own lines in its
 * `about.md`, or a holder's card, written through the same save the seat
 * pop-up uses, so it is drawn at once and taken back if refused.
 */

import { useEffect, useState } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import { Circle, Line, Polyline, Svg } from "react-native-svg";
import { Icon } from "../../../../design/components/Icon";
import { Text } from "../../../../design/components/Text";
import { fonts, pointerType, radii, space, touchType } from "../../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import { folderLabel } from "../../paths";
import { OwnerFace, type Face } from "../Glyphs";
import { headlineOf } from "./headline";
import { InlineField, PanelNotes, PanelOwnerRows, PanelRules, type PanelSeatTools } from "./PanelSeatFields";
import type { Reading } from "./readings";
import { readingSource, type AreaReading } from "./areaMetric";
import { areaTitle, type AreaNode, type Card, type Seat, type SeatEdit } from "./seat";
import type { TrendGeometry } from "./Trend";

export interface AreaPanelProps {
  node: AreaNode;
  /** The top of the page, named as its row is (the workspace's name); open already, so no Open area. */
  top?: string;
  /** The panel's inner width, from `PanelBeside`. */
  width: number;
  canEdit: boolean;
  faceOf: (owner: string | null) => Face;
  readingOf: (seat: Seat) => Reading | AreaReading | undefined;
  /** Opens the metric picker for this area; absent for a reader. */
  onPick?: (seat: Seat) => void;
  /** Writes the seat's lines and any changed cards; resolves a problem sentence, or null when saved. */
  onSave: (seat: Seat, edit: SeatEdit, cards: readonly Card[]) => Promise<string | null>;
  /** The owner pickers' people, agents and cards. */
  tools: PanelSeatTools;
  /** Shows another area here. */
  onPeek: (folder: string) => void;
  /** Opens an area's own page. */
  onOpen: (folder: string) => void;
  onClose: () => void;
}

/** The seat as an edit, with one change laid over it. */
function editOf(seat: Seat, patch: Partial<SeatEdit>): SeatEdit {
  return { owner: seat.ownOwner, helper: seat.helper, modes: seat.modes, metrics: seat.metrics, approvals: seat.approvals, ...patch };
}

export function AreaPanel({ node, top, width, canEdit, faceOf, readingOf, onPick, onSave, tools, onPeek, onOpen, onClose }: AreaPanelProps) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const { seat } = node;
  const reading = readingOf(seat);
  const headline = headlineOf(seat, reading);
  const metric = seat.metrics[0];
  const [problem, setProblem] = useState<string | null>(null);
  const write = async (patch: Partial<SeatEdit>, cards: readonly Card[] = []) => setProblem(await onSave(seat, editOf(seat, patch), cards));
  const setGoal = (target: string) => {
    if (metric === undefined || (target.trim() || null) === metric.target) return;
    void write({ metrics: [{ name: metric.name, target: target.trim() === "" ? null : target.trim() }, ...seat.metrics.slice(1)] });
  };

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const doc = (globalThis as unknown as { document?: Document }).document;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onClose();
    };
    doc?.addEventListener("keydown", onKey);
    return () => doc?.removeEventListener("keydown", onKey);
  }, [onClose]);

  const quiet = headline?.status === "hidden" || headline?.status === "loading";
  const ink = quiet ? colors.muted : headline?.state === "met" ? colors.okText : headline?.state === "missed" ? colors.warnText : colors.text;
  const owner = seat.owner;
  const trail = seat.folder.split("/").slice(0, -1).map(folderLabel).join(" / ");
  return (
    <View style={styles.panel} testID="area-panel">
      <View style={styles.headBlock}>
        <View style={styles.head}>
          <OwnerFace face={faceOf(owner)} size={22} />
          <Text variant="paneTitle" style={styles.title} numberOfLines={1} role="heading" aria-level={2}>
            {top ?? areaTitle(seat.name)}
          </Text>
          <Pressable onPress={onClose} role="button" accessibilityLabel="Close" hitSlop={6} style={styles.close} testID="area-panel-close">
            <Icon name="close" size={13} color={colors.chromeMuted} />
          </Pressable>
        </View>
        {top !== undefined || trail === "" ? null : (
          <Text variant="treeMeta" style={[styles.muted, styles.trail]} numberOfLines={1}>{`${trail} / ${areaTitle(seat.name)}`}</Text>
        )}
        {top !== undefined ? null : (
          <Pressable onPress={() => onOpen(seat.folder)} role="button" accessibilityLabel={`Open ${areaTitle(seat.name)}`} style={styles.openButton} testID="area-panel-open">
            <Text variant="treeMeta" style={styles.openWord}>Open area</Text>
          </Pressable>
        )}
      </View>
      {problem === null ? null : (
        <Text variant="treeMeta" role="alert" style={styles.problem}>
          {problem}
        </Text>
      )}

      <Section title="Metric">
        <View style={styles.metricHead}>
          <Text variant="tree" style={[styles.metricName, metric === undefined && styles.muted]} numberOfLines={2} testID="area-panel-metric">
            {metric?.name ?? (onPick === undefined ? "No metric yet" : "No metric")}
          </Text>
          {onPick === undefined ? null : (
            <Pressable onPress={() => onPick(seat)} role="button" accessibilityLabel={metric === undefined ? "Pick a metric" : "Change metric"} style={styles.pick} testID="area-panel-pick">
              <Text variant="treeMeta" style={styles.pickWord}>{metric === undefined ? "Pick a metric" : "Change"}</Text>
            </Pressable>
          )}
        </View>
        {metric === undefined ? null : (
          <View style={styles.valueLine}>
            {headline?.value != null ? (
              <Text style={[styles.value, { color: ink }]} testID="area-panel-value">
                {headline.value}
              </Text>
            ) : (
              <Text variant="tree" style={styles.noData}>No data yet</Text>
            )}
            <View style={styles.goal}>
              <Text variant="treeMeta" style={styles.muted}>Goal</Text>
              <InlineField
                value={metric.target ?? ""}
                label="Goal"
                placeholder={canEdit ? "Set one" : "None"}
                editable={canEdit}
                onCommit={setGoal}
                style={styles.goalField}
                testID="area-panel-goal"
              />
            </View>
            {headline?.state == null || headline.state === "unknown" || headline.value == null ? null : (
              <View style={[styles.state, headline.state === "met" ? styles.stateMet : styles.stateMissed]}>
                <Text variant="treeMeta" style={{ color: ink }}>{headline.state === "met" ? "On target" : "Off target"}</Text>
              </View>
            )}
          </View>
        )}
        {headline?.trend == null ? null : (
          <PanelTrend geometry={headline.trend} ink={headline.state === "met" ? colors.ok : headline.state === "missed" ? colors.warn : colors.muted} width={Math.max(160, width)} height={64} />
        )}
        {metric === undefined ? null : (
          <Text variant="treeMeta" style={styles.muted}>
            {headline?.date ? `Latest ${headline.date}. ` : ""}
            {readingSource(metric, fromWorkspace(reading))}
            {headline?.source ? sourceSentence(headline.source) : ""}
          </Text>
        )}
      </Section>

      <Section title="Owner">
        <PanelOwnerRows
          seat={seat}
          tools={tools}
          canEdit={canEdit}
          faceOf={faceOf}
          inherited={seat.ownerFrom === null ? null : `Held through ${folderLabel(seat.ownerFrom)}`}
          write={(patch, cards) => void write(patch, cards)}
        />
      </Section>

      {seat.approvals.length === 0 && !canEdit ? null : (
        <Section title="Needs approval">
          <PanelRules seat={seat} canEdit={canEdit} write={(patch) => void write(patch)} />
        </Section>
      )}

      {node.areas.length === 0 ? null : (
        <Section title="Sub-areas">
          {node.areas.map((sub) => {
            const subLine = headlineOf(sub.seat, readingOf(sub.seat));
            return (
              <Pressable key={sub.seat.folder} onPress={() => onPeek(sub.seat.folder)} role="button" accessibilityLabel={`Show ${areaTitle(sub.seat.name)}`} style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.sub, hovered && styles.subHover]} testID={`area-panel-sub-${sub.seat.folder}`}>
                <OwnerFace face={faceOf(sub.seat.owner)} size={16} />
                <Text variant="tree" style={styles.subName} numberOfLines={1}>{areaTitle(sub.seat.name)}</Text>
                <Text variant="treeMeta" style={subLine?.state === "met" ? styles.subMet : subLine?.state === "missed" ? styles.subMissed : styles.muted} numberOfLines={1}>{subLine === null ? "" : (subLine.value ?? "")}</Text>
              </Pressable>
            );
          })}
        </Section>
      )}

      {node.files.length === 0 ? null : (
        <Section title="Notes">
          <PanelNotes files={node.files} onOpen={onOpen} />
        </Section>
      )}
    </View>
  );
}

function fromWorkspace(reading: Reading | AreaReading | undefined): AreaReading | undefined {
  return reading !== undefined && "from" in reading ? reading : undefined;
}

/** The when of "Stripe + Cloudflare · last row 1h ago", as a sentence after the panel's: its sources are said before it. */
function sourceSentence(source: string): string {
  const when = source.split(" · ").find((part) => part.startsWith("last row "));
  return when === undefined ? "" : ` ${when.charAt(0).toUpperCase()}${when.slice(1)}.`;
}

/**
 * The trend at the panel's width. `Trend` stretches its small box to the size
 * asked for, which is right for the list's 56 but would smear the line, the
 * dashes and the dot across a panel; this lays the same points out in the
 * panel's own pixels instead.
 */
function PanelTrend({ geometry, ink, width, height }: { geometry: TrendGeometry; ink: string; width: number; height: number }) {
  const colors = useColors();
  // `Trend`'s box: 56×20 seen through a viewBox 3 wider each side.
  const x = (value: number) => ((value + 3) / 62) * width;
  const y = (value: number) => ((value + 3) / 26) * height;
  const points = geometry.points
    .split(" ")
    .map((pair) => pair.split(",").map(Number))
    .map(([px, py]) => `${x(px ?? 0).toFixed(1)},${y(py ?? 0).toFixed(1)}`)
    .join(" ");
  return (
    <Svg width={width} height={height} aria-hidden testID="area-panel-trend">
      {geometry.targetY === null ? null : (
        <Line x1={0} x2={width} y1={y(geometry.targetY)} y2={y(geometry.targetY)} stroke={colors.muted} strokeWidth={1} strokeDasharray="4 4" />
      )}
      <Polyline points={points} fill="none" stroke={ink} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <Circle cx={x(geometry.lastX)} cy={y(geometry.lastY)} r={3.5} fill={ink} />
    </Svg>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.section}>
      <Text variant="eyebrow" style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    panel: { gap: 18 },
    headBlock: { gap: space.x3, paddingBottom: 18, borderBottomWidth: 1, borderBottomColor: colors.line },
    head: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    title: { flexGrow: 1, flexShrink: 1, minWidth: 0, fontSize: pointerType.lede, lineHeight: 20, fontWeight: "600" },
    // Under the name, as the prototype draws it.
    openButton: { alignSelf: "flex-start", marginLeft: 30, paddingVertical: space.x1, paddingHorizontal: space.x3, borderRadius: radii.sm, backgroundColor: colors.text },
    openWord: { color: colors.surface, fontWeight: "600" },
    close: { padding: space.x1, borderRadius: radii.sm },
    problem: { color: colors.critText },
    // A hairline between sections, as the prototype draws them.
    section: { gap: space.x2, paddingBottom: 18, borderBottomWidth: 1, borderBottomColor: colors.line },
    sectionTitle: { color: colors.muted },
    muted: { color: colors.muted },
    trail: { marginLeft: 30, marginTop: -space.x2 },
    metricHead: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    metricName: { flexGrow: 1, flexShrink: 1, minWidth: 0, fontSize: pointerType.ui, fontWeight: "600", color: colors.text },
    pick: { paddingVertical: 2, paddingHorizontal: space.x2, borderRadius: radii.sm, backgroundColor: colors.accentDim },
    pickWord: { color: colors.accentText, fontWeight: "600" },
    noData: { color: colors.muted },
    valueLine: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    value: { fontFamily: fonts.body, fontSize: touchType.h3, lineHeight: 26, fontWeight: "600" },
    state: { paddingHorizontal: space.x2, paddingVertical: 1, borderRadius: radii.pill },
    stateMet: { backgroundColor: colors.okWash },
    stateMissed: { backgroundColor: colors.warnWash },
    goal: { flexDirection: "row", alignItems: "center", gap: space.x1, paddingLeft: space.x2, paddingRight: space.x1, borderRadius: radii.pill, backgroundColor: colors.chipFill },
    goalField: { fontSize: pointerType.meta, minWidth: 80, marginLeft: 0 },
    subMet: { color: colors.okText },
    subMissed: { color: colors.warnText },
    sub: { flexDirection: "row", alignItems: "center", gap: space.x2, minHeight: 30, paddingHorizontal: space.x1, marginHorizontal: -space.x1, borderRadius: radii.sm },
    subHover: { backgroundColor: colors.chipFill },
    subName: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
  });
