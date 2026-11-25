/**
 * New metric (boards 04 and 04b): a name, a formula drawn as chips and edited by hand with the columns this reader
 * has offered as they type, a period, how a value is shown, and the metric's last six periods worked out as it is
 * built, from the same sheets and the same engine its note will be read with. Save writes one metric note
 * (`metricDraft.ts`) and nothing else: no value is kept anywhere.
 *
 * "Describe it" and "Write it" (the formula written from a person's words) are the next stage and not drawn yet.
 */

import { useMemo, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, TextInput, View, useWindowDimensions, type NativeSyntheticEvent, type TextInputKeyPressEventData } from "react-native";
import { plainReading } from "../../../../../mcp/src/data/formula/index.js";
import { Button } from "../../../design/components/Button";
import { TextField } from "../../../design/components/Input";
import { Text } from "../../../design/components/Text";
import { useFieldFont } from "../../../design/fieldFont";
import { fonts, pointerType, radii } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { Shell } from "../DialogShell";
import { SourceMark } from "./Marks";
import {
  BUILDER_PERIODS,
  columnSuggestions,
  draftProblem,
  insertSuggestion,
  metricNoteText,
  metricPathFor,
  previewWords,
  wordAt,
  type BuilderPeriod,
  type ColumnSuggestion,
  type MetricDraft,
} from "./metricDraft";
import { metricOf } from "./metrics";
import { FormulaChips } from "./Parts";
import { ReadingsChart } from "./ReadingsChart";
import { sourceBySlug, type DataSource } from "./sources";
import { rowsReader } from "./useDataWorkspace";
import { periodLabel } from "./words";
import { formulaParts, workOut, type Sheet } from "./workOut";

const PERIODS = 6;
const PERIOD_NAMES: Readonly<Record<BuilderPeriod, string>> = { hour: "Hour", day: "Day", week: "Week", month: "Month" };

export function MetricBuilderDialog({
  metricsFolder,
  taken,
  sources,
  sheets,
  startFormula,
  initial,
  editing: startEditing = false,
  sheet,
  now,
  onSave,
  onClose,
}: {
  metricsFolder: string;
  /** Every path in the metrics folder now, so a new note never lands on one. */
  taken: ReadonlySet<string>;
  sources: readonly DataSource[];
  sheets: ReadonlyMap<string, Sheet | null>;
  startFormula: string;
  /** A draft to start from instead of an empty one: the boards' shots. */
  initial?: MetricDraft;
  /** Open with the formula typed by hand (board 04b). */
  editing?: boolean;
  /** A phone's sheet on the bottom of the glass. */
  sheet: boolean;
  now: number;
  /** Write the note; resolves to null once written, or to why not. */
  onSave: (path: string, text: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const frame = useWindowDimensions();
  const [draft, setDraft] = useState<MetricDraft>(initial ?? { name: "", formula: startFormula, every: "month", format: "" });
  const [editing, setEditing] = useState(startEditing);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saveProblem, setSaveProblem] = useState<string | null>(null);
  const formatFont = useFieldFont(pointerType.ui);
  const set = (patch: Partial<MetricDraft>) => setDraft((was) => ({ ...was, ...patch }));

  const path = metricPathFor(metricsFolder, draft.name, taken);
  const metric = useMemo(() => metricOf({ path, properties: { metric: draft.name, formula: draft.formula, every: draft.every, format: draft.format } }), [path, draft]);
  const rowsOf = useMemo(() => rowsReader(sources, sheets), [sources, sheets]);
  const worked = useMemo(() => workOut(metric, rowsOf, now, PERIODS), [metric, rowsOf, now]);
  const bySlug = useMemo(() => sourceBySlug(sources), [sources]);
  const parts = metric.parsed.ok ? formulaParts(metric.parsed.ast, (slug) => bySlug(slug)?.kind ?? "other") : [];
  const reading = metric.parsed.ok ? `${plainReading(metric.parsed.ast, draft.every) as string}.` : null;
  const problem = draftProblem(draft);
  const formulaProblem = draft.formula.trim() !== "" && !metric.parsed.ok ? metric.parsed.message : null;

  const save = async () => {
    setTried(true);
    if (problem !== null || busy) return;
    setBusy(true);
    setSaveProblem(null);
    const why = await onSave(path, metricNoteText(draft)).catch(() => "The metric could not be saved. Try again.");
    setBusy(false);
    if (why !== null) setSaveProblem(why);
  };

  const body = (
    <>
      <TextField label="Name" value={draft.name} onChangeText={(name) => set({ name })} placeholder="Such as Revenue per AI dollar" autoFocus testID="metric-name" />
      <View style={styles.formulaHead}>
        <Text variant="eyebrow">Formula</Text>
        {editing && !sheet ? <Text style={styles.hint}>Type to add a column, a function or + − × ÷</Text> : null}
        <Pressable onPress={() => setEditing((was) => !was)} accessibilityRole="button" style={styles.headLink} testID="metric-edit-toggle">
          <Text style={styles.link}>{editing ? "Done" : "Edit by hand"}</Text>
        </Pressable>
      </View>
      <View style={[styles.box, editing && { borderColor: colors.accent }]}>
        {editing ? (
          <FormulaInput formula={draft.formula} sources={sources} sheets={sheets} inline={sheet} onChange={(formula) => set({ formula })} />
        ) : (
          <Pressable onPress={() => setEditing(true)} accessibilityRole="button" accessibilityLabel="Edit the formula" style={styles.chipsArea} testID="metric-formula-chips">
            {parts.length > 0 ? <FormulaChips parts={parts} large /> : <Text style={styles.mono}>{draft.formula || "Write a formula"}</Text>}
            {reading === null ? null : <Text style={styles.reading}>{reading}</Text>}
          </Pressable>
        )}
        <View style={styles.settings}>
          <Text style={styles.settingLabel}>Each</Text>
          <View style={styles.track} role="radiogroup" aria-label="Each">
            {BUILDER_PERIODS.map((each) => {
              const on = draft.every === each;
              return (
                <Pressable
                  key={each}
                  role="radio"
                  aria-checked={on}
                  accessibilityState={{ checked: on, selected: on }}
                  onPress={() => set({ every: each })}
                  style={[styles.segment, on && styles.segmentOn]}
                  testID={`metric-every-${each}`}
                >
                  <Text style={[styles.segmentText, on && styles.segmentTextOn]}>{PERIOD_NAMES[each]}</Text>
                </Pressable>
              );
            })}
          </View>
          <View style={styles.shownAs}>
            <Text style={styles.settingLabel}>Shown as</Text>
            <TextInput
              value={draft.format}
              onChangeText={(format) => set({ format })}
              placeholder="0"
              placeholderTextColor={colors.muted}
              accessibilityLabel="Shown as"
              autoCapitalize="none"
              autoCorrect={false}
              style={[styles.formatInput, formatFont]}
              testID="metric-format"
            />
          </View>
        </View>
      </View>
      {formulaProblem !== null && (tried || !editing) ? (
        <Text variant="error" testID="metric-formula-problem">
          {formulaProblem}
        </Text>
      ) : null}
      <Preview metric={metric} worked={worked} every={draft.every} format={draft.format} parsed={metric.parsed.ok} />
    </>
  );

  return (
    <Shell title="New metric" onClose={onClose} sheet={sheet} width={680} closable>
      {sheet ? (
        // A phone's sheet scrolls; a window's card is short enough to stand whole, so the column list can spill over its edge.
        <ScrollView style={{ maxHeight: Math.max(240, frame.height - 220) }} contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          {body}
        </ScrollView>
      ) : (
        <View style={styles.scroll}>{body}</View>
      )}
      <View style={[styles.foot, sheet && styles.footSheet]}>
        <Text style={styles.lands} testID="metric-lands">
          Saved as <Text style={styles.path}>{path}</Text> · {worked.now ? "read right now" : "worked out as you read"}
        </Text>
        {tried && (problem ?? saveProblem) !== null ? (
          <Text variant="error" testID="metric-problem">
            {problem ?? saveProblem}
          </Text>
        ) : null}
        <Button label={busy ? "Saving…" : "Save metric"} variant="dialogPrimary" onPress={() => void save()} disabled={busy} testID="metric-save" {...(sheet ? { style: styles.saveSheet } : {})} />
      </View>
    </Shell>
  );
}

/** The preview card: the period so far, large, and the last six on a chart, as the note will draw them. */
function Preview({ metric, worked, every, format, parsed }: { metric: ReturnType<typeof metricOf>; worked: ReturnType<typeof workOut>; every: string; format: string; parsed: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const words = previewWords(every, PERIODS);
  const quiet = (text: string) => (
    <View style={styles.card} testID="metric-preview">
      <Text style={styles.quiet}>{text}</Text>
    </View>
  );
  if (!parsed) return quiet("The preview shows once the formula reads.");
  if (worked.latest.status === "hidden") return quiet("Hidden: one of its inputs is missing, or not shared with you.");
  if (worked.latest.status === "error") return quiet(worked.latest.note ?? "This formula can't be worked out.");
  if (worked.now) {
    return (
      <View style={styles.card} testID="metric-preview">
        <View style={styles.previewHead}>
          <Text style={styles.big}>{worked.shown}</Text>
          <Text style={styles.so}>right now</Text>
          <Text style={styles.span}>Its sheets have no dates: keep it every hour from its note</Text>
        </View>
      </View>
    );
  }
  const periods = worked.periods;
  return (
    <View style={styles.card} testID="metric-preview">
      <View style={styles.previewHead}>
        <Text style={styles.big}>{worked.shown}</Text>
        <Text style={styles.so}>{words.now}</Text>
        <Text style={styles.span}>{words.span}</Text>
      </View>
      <ReadingsChart
        values={periods.map((p) => (p.status === "ok" ? p.value : null))}
        labels={periods.map((p) => periodLabel(p, metric.every))}
        target={null}
        targetLabel={null}
        state="unknown"
        format={format}
        accent
      />
    </View>
  );
}

/** The formula typed by hand (board 04b), with the columns that fit the word at the caret offered under it. */
function FormulaInput({
  formula,
  sources,
  sheets,
  inline,
  onChange,
}: {
  formula: string;
  sources: readonly DataSource[];
  sheets: ReadonlyMap<string, Sheet | null>;
  /** The list under the field, in the flow, rather than over what follows: a phone's sheet, which scrolls and would clip it. */
  inline: boolean;
  onChange: (formula: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const input = useRef<TextInput>(null);
  const formulaFont = useFieldFont(pointerType.ui);
  const [caret, setCaret] = useState(formula.length);
  const [place, setPlace] = useState<{ start: number; end: number } | undefined>(undefined);
  const [focused, setFocused] = useState(true);
  const [highlight, setHighlight] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  // A pointer over the list keeps it open while the field blurs on the way to a press on one of its rows.
  const overList = useRef(false);
  const word = wordAt(formula, caret).word;
  const found = useMemo(() => columnSuggestions(sources, sheets, word), [sources, sheets, word]);
  const open = focused && found.length > 0 && dismissed !== `${caret}:${formula}`;
  const at = Math.min(highlight, Math.max(0, found.length - 1));

  const pick = (suggestion: ColumnSuggestion) => {
    const next = insertSuggestion(formula, caret, suggestion);
    onChange(next.formula);
    setCaret(next.caret);
    setPlace({ start: next.caret, end: next.caret });
    setHighlight(0);
    input.current?.focus();
  };

  const onKey = (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
    if (!open) return;
    const key = event.nativeEvent.key;
    const stop = () => (event as unknown as { preventDefault?: () => void }).preventDefault?.();
    if (key === "ArrowDown" || key === "ArrowUp") {
      stop();
      setHighlight((at + (key === "ArrowDown" ? 1 : found.length - 1)) % found.length);
    } else if (key === "Enter" || key === "Tab") {
      stop();
      pick(found[at]!);
    } else if (key === "Escape") {
      stop();
      setDismissed(`${caret}:${formula}`);
    }
  };

  const header = (() => {
    const first = found[0];
    if (first === undefined) return "Columns";
    const one = found.every((each) => each.source === first.source && each.dataset === first.dataset);
    return one ? `Columns in ${first.source.name} ${first.dataset}` : "Columns";
  })();

  return (
    <View style={styles.inputWrap}>
      <TextInput
        ref={input}
        value={formula}
        onChangeText={(next) => {
          onChange(next);
          setHighlight(0);
        }}
        {...(place === undefined ? {} : { selection: place })}
        onSelectionChange={(event) => {
          setCaret(event.nativeEvent.selection.start);
          if (place !== undefined) setPlace(undefined);
        }}
        onKeyPress={onKey}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          if (!overList.current) setFocused(false);
        }}
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        multiline={Platform.OS !== "web"}
        placeholder="sum(stripe/revenue.usd) ÷ sum(cloudflare/ai-spend.usd)"
        placeholderTextColor={colors.muted}
        accessibilityLabel="Formula"
        style={[styles.formulaInput, formulaFont]}
        testID="metric-formula"
      />
      {open ? (
        <View style={[styles.popover, inline && styles.popoverInline]} role="menu" aria-label={header} testID="metric-suggestions">
          <Text style={styles.popHead}>{header}</Text>
          {found.map((each, index) => (
            <Pressable
              key={each.insert}
              role="menuitem"
              aria-selected={index === at}
              onPress={() => {
                overList.current = false;
                pick(each);
              }}
              onHoverIn={() => {
                overList.current = true;
                setHighlight(index);
              }}
              onHoverOut={() => {
                overList.current = false;
              }}
              style={[styles.popRow, index === at && { backgroundColor: colors.chipFill }]}
              testID={`metric-suggestion-${index}`}
            >
              <SourceMark kind={each.source.kind} size={28} />
              <Text style={styles.popDataset} numberOfLines={1}>
                {each.dataset}
              </Text>
              <Text style={styles.popColumn} numberOfLines={1}>
                {each.column}
              </Text>
              <Text style={styles.popType}>{each.type}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    scroll: { gap: 12, paddingBottom: 4 },
    formulaHead: { flexDirection: "row", alignItems: "baseline", gap: 8, marginBottom: -4 },
    hint: { fontSize: pointerType.meta, lineHeight: 16, color: colors.muted, flexShrink: 1 },
    headLink: { marginLeft: "auto" },
    link: { fontSize: pointerType.meta, lineHeight: 16, color: colors.accentText, fontWeight: "500" },
    box: { borderWidth: 1, borderColor: colors.line, borderRadius: radii.card, backgroundColor: colors.surface, zIndex: 2 },
    chipsArea: { paddingHorizontal: 12, paddingVertical: 12, gap: 10 },
    mono: { fontFamily: fonts.mono, fontSize: pointerType.meta, lineHeight: 18, color: colors.text2 },
    reading: { fontSize: pointerType.ui, lineHeight: 19, color: colors.text2 },
    settings: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10, paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.line },
    settingLabel: { fontSize: pointerType.meta, lineHeight: 16, color: colors.muted },
    track: { flexDirection: "row", padding: 2, borderRadius: radii.md, backgroundColor: colors.chipFill, borderWidth: 1, borderColor: colors.line },
    segment: { paddingHorizontal: 12, height: 24, borderRadius: radii.xs, alignItems: "center", justifyContent: "center" },
    segmentOn: { backgroundColor: colors.surface2, boxShadow: "0 1px 2px rgba(0,0,0,.18)" },
    segmentText: { fontSize: pointerType.ui, lineHeight: 18, color: colors.text2 },
    segmentTextOn: { color: colors.text, fontWeight: "600" },
    shownAs: { marginLeft: "auto", flexDirection: "row", alignItems: "center", gap: 6 },
    formatInput: {
      width: 64,
      height: 28,
      paddingHorizontal: 8,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.xs,
      fontSize: pointerType.ui,
      color: colors.text,
      textAlign: "center",
    },
    inputWrap: { paddingHorizontal: 12, paddingVertical: 10, zIndex: 3 },
    formulaInput: { fontFamily: fonts.mono, fontSize: pointerType.ui, lineHeight: 20, color: colors.text, minHeight: 24, padding: 0, outlineStyle: "none" } as never,
    popover: {
      position: "absolute",
      top: 40,
      right: -8,
      width: 300,
      maxWidth: "100%",
      paddingVertical: 6,
      paddingHorizontal: 6,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.card,
      backgroundColor: colors.surface2,
      boxShadow: "0 18px 40px -16px rgba(0,0,0,.6)",
      zIndex: 10,
    },
    popoverInline: { position: "relative", top: 0, right: 0, width: "100%", marginTop: 8, boxShadow: "none" },
    popHead: { fontSize: pointerType.meta, lineHeight: 16, color: colors.muted, paddingHorizontal: 8, paddingTop: 4, paddingBottom: 6 },
    popRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 6, paddingVertical: 3, borderRadius: radii.xs },
    popDataset: { fontSize: pointerType.ui, lineHeight: 18, color: colors.text2, flexShrink: 1 },
    popColumn: { fontSize: pointerType.ui, lineHeight: 18, color: colors.text, fontWeight: "600", flexShrink: 1 },
    popType: { marginLeft: "auto", fontFamily: fonts.mono, fontSize: pointerType.meta, lineHeight: 16, color: colors.muted },
    card: { borderWidth: 1, borderColor: colors.line, borderRadius: radii.card, backgroundColor: colors.cardSurface, padding: 12, gap: 6 },
    previewHead: { flexDirection: "row", alignItems: "baseline", gap: 8, flexWrap: "wrap" },
    big: { fontSize: pointerType.h2, lineHeight: 28, fontWeight: "600", letterSpacing: -0.4, color: colors.text },
    so: { fontSize: pointerType.meta, lineHeight: 16, color: colors.text2 },
    span: { marginLeft: "auto", fontSize: pointerType.meta, lineHeight: 16, color: colors.muted },
    quiet: { fontSize: pointerType.ui, lineHeight: 19, color: colors.muted },
    foot: {
      flexDirection: "row",
      alignItems: "center",
      flexWrap: "wrap",
      gap: 12,
      marginHorizontal: -24,
      marginBottom: -22,
      marginTop: 4,
      paddingHorizontal: 24,
      paddingVertical: 16,
      borderTopWidth: 1,
      borderTopColor: colors.line,
    },
    footSheet: { flexDirection: "column", alignItems: "stretch", marginBottom: -34, paddingBottom: 34 },
    saveSheet: { alignSelf: "stretch", height: 48 },
    lands: { flex: 1, minWidth: 200, fontSize: pointerType.meta, lineHeight: 17, color: colors.muted },
    path: { fontFamily: fonts.mono, fontSize: pointerType.meta, color: colors.text2 },
  });
