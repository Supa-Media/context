/**
 * The pieces of the area metric picker (`MetricPicker.tsx`; the data sources
 * boards, 05 and 13b): a metric's radio row, the "New metric…" row, Over and
 * Under, and the empty picker of a workspace with no metrics yet.
 */

import { Pressable, StyleSheet, Text as RNText, View } from "react-native";
import { Text } from "../../../../design/components/Text";
import { pointerType, radii, touchType } from "../../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import { DatabaseGlyph, PlusGlyph } from "../../data/Marks";
import { DataButton, Spark } from "../../data/Parts";
import type { MetricOption, TargetMode } from "./areaMetric";

/** One metric as the picker lists it: a radio, its name over its sources and users, its trend and latest value. */
export function OptionRow({ option, on, first, phone, onPick }: { option: MetricOption; on: boolean; first: boolean; phone: boolean; onPick: () => void }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      role="radio"
      aria-checked={on}
      accessibilityState={{ checked: on, disabled: option.duplicate }}
      accessibilityLabel={`${option.name}, ${option.shown}`}
      disabled={option.duplicate}
      onPress={onPick}
      style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [
        styles.row,
        phone && styles.rowPhone,
        !first && styles.rowRule,
        on && styles.rowOn,
        hovered && !on && !option.duplicate && styles.rowHover,
      ]}
      testID={`metric-option-${option.path}`}
    >
      <View style={[styles.radio, on && styles.radioOn]}>{on ? <View style={styles.radioDot} /> : null}</View>
      <View style={styles.words}>
        <Text style={[styles.name, phone && styles.namePhone, option.duplicate && styles.muted]} numberOfLines={1}>
          {option.name}
        </Text>
        {option.line === "" ? null : (
          <Text style={[styles.line, phone && styles.linePhone]} numberOfLines={1}>
            {option.line}
          </Text>
        )}
      </View>
      <Spark series={option.series} target={null} state="unknown" compact={phone} />
      <Text style={[styles.value, phone && styles.valuePhone, (option.shown === "Hidden" || option.shown === "—" || option.shown === "…") && styles.quietValue]} numberOfLines={1}>
        {option.shown}
      </Text>
    </Pressable>
  );
}

export function NewMetricRow({ phone, onPress }: { phone: boolean; onPress: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <Pressable role="button" accessibilityLabel="New metric" onPress={onPress} style={[styles.row, phone && styles.rowPhone, styles.rowRule]} testID="metric-picker-new">
      <PlusGlyph size={14} color={colors.accentText} />
      <Text style={[styles.newWord, phone && styles.namePhone]}>New metric…</Text>
    </Pressable>
  );
}

/** Over or Under, the board's segmented control: each word sized to itself, so neither is ever cut. */
export function Segment({ mode, phone, onChange }: { mode: TargetMode; phone: boolean; onChange: (mode: TargetMode) => void }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={[styles.seg, phone && styles.segPhone]} role="radiogroup" accessibilityLabel="Target direction">
      {(["over", "under"] as const).map((each) => (
        <Pressable
          key={each}
          role="radio"
          aria-checked={mode === each}
          accessibilityState={{ checked: mode === each }}
          onPress={() => onChange(each)}
          style={[styles.segItem, phone && styles.segItemPhone, mode === each && styles.segOn]}
          testID={`metric-target-${each}`}
        >
          <RNText style={[styles.segWord, phone && styles.segWordPhone, mode === each && styles.segWordOn]} numberOfLines={1}>
            {each === "over" ? "Over" : "Under"}
          </RNText>
        </Pressable>
      ))}
    </View>
  );
}

/** A workspace with no metrics yet (board 13b): what a metric is made from, and Connect a source. */
export function EmptyPicker({ phone, onConnect, onNewMetric }: { phone: boolean; onConnect?: () => void; onNewMetric?: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <View style={styles.empty} testID="metric-picker-empty">
      <View style={styles.emptyTile}>
        <DatabaseGlyph size={22} color={colors.accentText} />
      </View>
      <Text style={[styles.emptyTitle, phone && styles.emptyTitlePhone]}>No metrics in this workspace yet</Text>
      <Text style={[styles.emptyLine, phone && styles.emptyLinePhone]}>
        A metric is worked out from data: GitHub, Stripe or Cloudflare, Context’s own notes, or rows you send from code.
      </Text>
      <View style={styles.emptyButtons}>
        {onConnect === undefined ? null : (
          <DataButton label="Connect a source" kind="pri" leading={<PlusGlyph size={12} color={colors.ink} />} onPress={onConnect} testID="metric-picker-connect" />
        )}
        {onNewMetric === undefined ? null : (
          <DataButton label="New metric" leading={<PlusGlyph size={12} color={colors.text} />} onPress={onNewMetric} testID="metric-picker-empty-new" />
        )}
      </View>
      {onConnect === undefined && onNewMetric === undefined ? (
        <Text style={styles.emptyLine}>Someone who can edit this workspace connects one from its data folder.</Text>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    row: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 46, paddingHorizontal: 12, paddingVertical: 6 },
    rowPhone: { minHeight: 52 },
    rowRule: { borderTopWidth: 1, borderTopColor: colors.line },
    rowOn: { backgroundColor: colors.hintWash },
    rowHover: { backgroundColor: colors.chipFill },
    radio: { width: 16, height: 16, borderRadius: 8, borderWidth: 1.5, borderColor: colors.lineStrong, alignItems: "center", justifyContent: "center", flexShrink: 0 },
    radioOn: { borderColor: colors.accent },
    radioDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accent },
    words: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 },
    name: { fontSize: pointerType.ui, lineHeight: 17, fontWeight: "600", color: colors.text },
    namePhone: { fontSize: pointerType.lede, lineHeight: 20 },
    muted: { color: colors.muted },
    line: { fontSize: pointerType.meta, lineHeight: 15, color: colors.muted },
    linePhone: { fontSize: pointerType.ui, lineHeight: 17 },
    value: { width: 64, textAlign: "right", fontSize: pointerType.ui, fontWeight: "600", color: colors.text, flexShrink: 0 },
    valuePhone: { width: 72, fontSize: pointerType.lede },
    quietValue: { color: colors.muted, fontWeight: "500" },
    newWord: { fontSize: pointerType.ui, fontWeight: "600", color: colors.accentText },

    seg: { flexDirection: "row", padding: 2, height: 34, borderRadius: radii.sm + 2, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.chipFill, flexShrink: 0 },
    segPhone: { height: 44 },
    segItem: { paddingHorizontal: 12, borderRadius: radii.sm, alignItems: "center", justifyContent: "center", flexShrink: 0 },
    segItemPhone: { paddingHorizontal: 16 },
    segOn: { backgroundColor: colors.cardSurface, boxShadow: "0 1px 2px rgba(0,0,0,.08)" },
    segWord: { fontSize: pointerType.ui, fontWeight: "500", color: colors.muted },
    segWordPhone: { fontSize: touchType.ui },
    segWordOn: { fontWeight: "600", color: colors.text },

    empty: { alignItems: "center", gap: 8, paddingTop: 18, paddingHorizontal: 10, paddingBottom: 8 },
    emptyTile: { width: 44, height: 44, borderRadius: radii.card, backgroundColor: colors.surface3, alignItems: "center", justifyContent: "center" },
    emptyTitle: { fontSize: pointerType.lede, lineHeight: 20, fontWeight: "600", color: colors.text, textAlign: "center" },
    emptyTitlePhone: { fontSize: touchType.lede, lineHeight: 22 },
    emptyLine: { fontSize: pointerType.ui, lineHeight: 19, color: colors.muted, textAlign: "center", maxWidth: 360 },
    emptyLinePhone: { fontSize: pointerType.lede, lineHeight: 21 },
    emptyButtons: { flexDirection: "row", gap: 8, marginTop: 8 },
  });
