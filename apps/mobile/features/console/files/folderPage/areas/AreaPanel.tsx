/**
 * An area's details beside the Areas list: one click on an area opens it here,
 * a double click opens the area's own page (the owner, 2026-11-24: "one click
 * open up the right panel, double click to get into more details"). It is the
 * side-panel prototype the owner tried, built: the name and its owner, the one
 * headline metric with its latest reading, trend and goal, the owner and their
 * agent with how to reach them, the modes, and the sub-areas.
 *
 * The metric's name and goal and the modes are edited in place: each change is
 * the seat's own lines in its `about.md`, written through the same save the
 * seat pop-up uses, so it is drawn at once and taken back if refused. Who
 * holds the seat and how to reach them stay in the pop-up ("Change…"), which
 * owns the owner picker and the cards.
 */

import { useEffect, useState } from "react";
import { Platform, Pressable, StyleSheet, TextInput, View, type TextStyle } from "react-native";
import { Circle, Line, Polyline, Svg } from "react-native-svg";
import { Icon } from "../../../../design/components/Icon";
import { Text } from "../../../../design/components/Text";
import { useFieldFont } from "../../../../design/fieldFont";
import { areasType, fonts, pointerType, radii, space, touchType } from "../../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import { folderLabel } from "../../paths";
import { OwnerFace, type Face } from "../Glyphs";
import { headlineOf } from "./headline";
import type { Reading } from "./readings";
import { MODES, areaTitle, type AreaNode, type Mode, type Seat, type SeatEdit } from "./seat";
import type { TrendGeometry } from "./Trend";

export interface AreaPanelProps {
  node: AreaNode;
  /** The top of the page, named as its row is (the workspace's name); open already, so no Open area. */
  top?: string;
  /** The panel's inner width, from `PanelBeside`. */
  width: number;
  canEdit: boolean;
  faceOf: (owner: string | null) => Face;
  label: (owner: string) => string;
  /** One line saying how to reach a holder, "" if unknown. */
  reach: (owner: string) => string;
  readingOf: (seat: Seat) => Reading | undefined;
  /** Writes the seat's lines; resolves a problem sentence, or null when saved. */
  onSave: (seat: Seat, edit: SeatEdit) => Promise<string | null>;
  /** Opens the seat pop-up, for the owner, the agent and how to reach them. */
  onEditSeat: (seat: Seat) => void;
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

export function AreaPanel({ node, top, width, canEdit, faceOf, label, reach, readingOf, onSave, onEditSeat, onPeek, onOpen, onClose }: AreaPanelProps) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const { seat } = node;
  const reading = readingOf(seat);
  const headline = headlineOf(seat, reading);
  const metric = seat.metrics[0];
  const [problem, setProblem] = useState<string | null>(null);
  const write = async (patch: Partial<SeatEdit>) => setProblem(await onSave(seat, editOf(seat, patch)));
  const setMetric = (name: string, target: string) => {
    const was = metric ?? { name: "", target: null };
    if (name.trim() === was.name && (target.trim() || null) === was.target) return;
    void write({ metrics: name.trim() === "" ? [] : [{ name: name.trim(), target: target.trim() === "" ? null : target.trim() }, ...seat.metrics.slice(1)] });
  };
  const toggleMode = (mode: Mode) =>
    void write({ modes: seat.modes.includes(mode) ? seat.modes.filter((each) => each !== mode) : [...seat.modes, mode] });

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const doc = (globalThis as unknown as { document?: Document }).document;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onClose();
    };
    doc?.addEventListener("keydown", onKey);
    return () => doc?.removeEventListener("keydown", onKey);
  }, [onClose]);

  const ink = headline?.state === "met" ? colors.okText : headline?.state === "missed" ? colors.warnText : colors.text;
  const owner = seat.owner;
  const reachLine = owner === null ? "" : reach(owner);
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
        <InlineField
          value={metric?.name ?? ""}
          label="Metric name"
          placeholder={canEdit ? "Name what this area measures" : "No metric yet"}
          editable={canEdit}
          onCommit={(name) => setMetric(name, metric?.target ?? "")}
          style={styles.metricName}
          testID="area-panel-metric"
        />
        {headline?.value != null ? (
          <View style={styles.valueLine}>
            <Text style={[styles.value, { color: ink }]} testID="area-panel-value">
              {headline.value}
            </Text>
            {headline.state === "unknown" ? null : (
              <View style={[styles.state, headline.state === "met" ? styles.stateMet : styles.stateMissed]}>
                <Text variant="treeMeta" style={{ color: ink }}>{headline.state === "met" ? "On target" : "Off target"}</Text>
              </View>
            )}
          </View>
        ) : metric === undefined ? null : (
          <Text variant="treeMeta" style={styles.muted}>No readings yet. They come from this area's metrics.csv.</Text>
        )}
        {headline?.trend == null ? null : (
          <PanelTrend geometry={headline.trend} ink={headline.state === "met" ? colors.ok : headline.state === "missed" ? colors.warn : colors.muted} width={Math.max(160, width)} height={64} />
        )}
        {metric === undefined ? null : (
          <View style={styles.goal}>
            <Text variant="treeMeta" style={styles.muted}>Goal</Text>
            <InlineField
              value={metric.target ?? ""}
              label="Goal"
              placeholder={canEdit ? "Set one" : "None"}
              editable={canEdit}
              onCommit={(target) => setMetric(metric.name, target)}
              style={styles.goalField}
              testID="area-panel-goal"
            />
            {headline?.date ? <Text variant="treeMeta" style={styles.date}>{`Latest ${headline.date}`}</Text> : null}
          </View>
        )}
      </Section>

      <Section title="Owner">
        <View style={styles.ownerLine}>
          <OwnerFace face={faceOf(owner)} size={18} />
          <Text variant="tree" style={styles.ownerName} numberOfLines={1}>
            {owner === null ? "Nobody yet" : label(owner)}
            {seat.helper === null ? "" : ` + ${label(seat.helper)}`}
          </Text>
          {canEdit ? (
            <Pressable onPress={() => onEditSeat(seat)} role="button" style={styles.change} testID="area-panel-change">
              <Text variant="treeMeta" style={styles.link}>Change…</Text>
            </Pressable>
          ) : null}
        </View>
        {seat.ownerFrom === null ? null : (
          <Text variant="treeMeta" style={styles.muted}>{`Held through ${folderLabel(seat.ownerFrom)}`}</Text>
        )}
        {reachLine === "" ? null : <Text variant="treeMeta" style={styles.muted}>{reachLine}</Text>}
        <View style={styles.modes} role="group" aria-label="Modes">
          {MODES.map((mode) => {
            const on = seat.modes.includes(mode);
            return (
              <Pressable
                key={mode}
                onPress={canEdit ? () => toggleMode(mode) : undefined}
                disabled={!canEdit}
                aria-pressed={on}
                role="button"
                accessibilityLabel={`${mode} mode`}
                style={[styles.mode, on && styles.modeOn]}
                testID={`area-panel-mode-${mode}`}
              >
                <Text variant="treeMeta" style={on ? styles.modeWordOn : styles.modeWord}>{mode}</Text>
              </Pressable>
            );
          })}
        </View>
      </Section>

      {node.areas.length === 0 ? null : (
        <Section title={`${node.areas.length} ${node.areas.length === 1 ? "area" : "areas"} inside`}>
          {node.areas.map((sub) => {
            const subLine = headlineOf(sub.seat, readingOf(sub.seat));
            return (
              <Pressable key={sub.seat.folder} onPress={() => onPeek(sub.seat.folder)} role="button" accessibilityLabel={`Show ${areaTitle(sub.seat.name)}`} style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.sub, hovered && styles.subHover]} testID={`area-panel-sub-${sub.seat.folder}`}>
                <OwnerFace face={faceOf(sub.seat.owner)} size={16} />
                <Text variant="tree" style={styles.subName} numberOfLines={1}>{areaTitle(sub.seat.name)}</Text>
                <Text variant="treeMeta" style={styles.muted} numberOfLines={1}>{subLine === null ? "" : (subLine.value ?? "No data")}</Text>
              </Pressable>
            );
          })}
        </Section>
      )}
    </View>
  );
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

/** Text that is edited where it is drawn, written when it loses focus or on Enter. */
function InlineField({ value, label, placeholder, editable, onCommit, style, testID }: { value: string; label: string; placeholder: string; editable: boolean; onCommit: (text: string) => void; style: TextStyle; testID: string }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [text, setText] = useState(value);
  const [focused, setFocused] = useState(false);
  useEffect(() => setText(value), [value]);
  const fieldFont = useFieldFont(style.fontSize);
  const commit = () => {
    if (text !== value) onCommit(text);
  };
  return (
    <TextInput
      value={text}
      onChangeText={setText}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onSubmitEditing={commit}
      editable={editable}
      accessibilityLabel={label}
      placeholder={placeholder}
      placeholderTextColor={colors.muted}
      style={[styles.field, editable && styles.fieldEditable, focused && styles.fieldFocused, style, fieldFont]}
      testID={testID}
    />
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
    field: {
      fontFamily: fonts.body,
      color: colors.text,
      paddingVertical: 3,
      paddingHorizontal: 6,
      marginLeft: -6,
      borderWidth: 1,
      borderColor: "transparent",
      borderRadius: radii.sm,
    },
    // Says it can be typed in without a box around every value.
    fieldEditable: { borderBottomColor: colors.line, borderStyle: "dashed" },
    fieldFocused: { borderColor: colors.accent, borderStyle: "solid", backgroundColor: colors.surface },
    metricName: { fontSize: pointerType.ui, fontWeight: "500" },
    valueLine: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    value: { fontFamily: fonts.body, fontSize: touchType.h3, lineHeight: 26, fontWeight: "600" },
    state: { paddingHorizontal: space.x2, paddingVertical: 1, borderRadius: radii.pill },
    stateMet: { backgroundColor: colors.okWash },
    stateMissed: { backgroundColor: colors.warnWash },
    goal: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    goalField: { fontSize: pointerType.meta, minWidth: 96 },
    date: { color: colors.muted, marginLeft: "auto" as never },
    ownerLine: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    ownerName: { flexGrow: 1, flexShrink: 1, minWidth: 0, fontSize: areasType.value },
    change: { paddingVertical: 2, paddingHorizontal: space.x1, borderRadius: radii.sm },
    link: { color: colors.accent },
    modes: { flexDirection: "row", flexWrap: "wrap", gap: space.x1 },
    mode: { paddingVertical: 2, paddingHorizontal: space.x3, borderRadius: radii.pill, borderWidth: 1, borderColor: colors.muted },
    modeOn: { backgroundColor: colors.text, borderColor: colors.text },
    modeWord: { color: colors.text2 },
    modeWordOn: { color: colors.surface },
    sub: { flexDirection: "row", alignItems: "center", gap: space.x2, minHeight: 30, paddingHorizontal: space.x1, marginHorizontal: -space.x1, borderRadius: radii.sm },
    subHover: { backgroundColor: colors.chipFill },
    subName: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
  });
