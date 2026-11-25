/**
 * An area picks its one metric (the data sources boards, 05; empty, 13b): the
 * workspace's metrics as radio rows, each with the sources it reads, the
 * areas that use it, its trend and its latest value worked out as it is
 * read; "New metric…"; and the area's own target, Over or Under a value, with
 * a line saying when it is drawn green. Save writes the seat's own line,
 * `metrics: [Revenue per AI dollar · target over $5]`, to the area's
 * `about.md` (`areaMetric.ts`, `pickedEdit`), and nothing else.
 *
 * A card in the middle of the window on a pointer; a sheet on a phone's
 * bottom edge, where the target's value has a line of its own beside Over
 * and Under so neither word is cut (the board clips "Under").
 */

import { useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { Button } from "../../../../design/components/Button";
import { Icon } from "../../../../design/components/Icon";
import { Text } from "../../../../design/components/Text";
import { fonts, pointerType, radii, touchType } from "../../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import { useFieldFont } from "../../../../design/fieldFont";
import { OwnerFace, type Face } from "../Glyphs";
import { optionMatches, splitTarget, targetHint, type MetricOption, type TargetMode } from "./areaMetric";
import { EmptyPicker, NewMetricRow, OptionRow, Segment } from "./MetricPickerParts";

export interface MetricPickerProps {
  /** The area as drawn: "Finance". */
  area: string;
  face: Face;
  /** Its owner as drawn, or null for none. */
  owner: string | null;
  /** The note Save writes: `areas/finance/about.md`. */
  aboutPath: string;
  options: readonly MetricOption[];
  /** The data folder's notes have come: an empty list is then "no metrics" rather than "not read yet". */
  known: boolean;
  /** The option the area's metric is now, by path; null for none or one only its `metrics.csv` reads. */
  current: string | null;
  /** The area's target as written, `over $5`, or null. */
  target: string | null;
  /** A phone's bottom sheet. */
  sheet: boolean;
  /** Makes a metric note and opens it; absent for someone who may not write. */
  onNewMetric?: () => void;
  /** Connect a source; absent for someone who may not. */
  onConnect?: () => void;
  /** Writes the seat line; resolves null once saved, or why not. */
  onSave: (option: MetricOption, mode: TargetMode, value: string) => Promise<string | null>;
  onClose: () => void;
}

export function MetricPicker(props: MetricPickerProps) {
  const { area, face, owner, aboutPath, options, known, current, sheet, onNewMetric, onConnect, onSave, onClose } = props;
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const fieldFont = useFieldFont();
  const start = splitTarget(props.target);
  const [picked, setPicked] = useState<string | null>(current);
  const [mode, setMode] = useState<TargetMode>(start.mode);
  const [value, setValue] = useState(start.value);
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const shown = useMemo(() => options.filter((option) => optionMatches(option, query)), [options, query]);
  const empty = known && options.length === 0;
  const choice = options.find((option) => option.path === picked && !option.duplicate) ?? null;

  const save = async () => {
    if (choice === null || busy) return;
    setBusy(true);
    setProblem(null);
    const why = await onSave(choice, mode, value).catch(() => "That change could not be saved.");
    setBusy(false);
    if (why === null) onClose();
    else setProblem(why);
  };

  const target = (
    <View style={styles.targetBlock}>
      <Text style={styles.label}>Target</Text>
      <View style={styles.targetRow}>
        <Segment mode={mode} phone={sheet} onChange={setMode} />
        <TextInput
          value={value}
          onChangeText={setValue}
          placeholder="$5"
          placeholderTextColor={colors.chromeMuted}
          accessibilityLabel="Target value"
          style={[styles.input, styles.valueInput, sheet && styles.valueInputPhone, fieldFont]}
          onSubmitEditing={() => void save()}
          testID="metric-target-value"
        />
        {sheet ? null : (
          <Text style={styles.hint} testID="metric-target-hint">
            {targetHint(mode, value)}
          </Text>
        )}
      </View>
      {sheet ? (
        <Text style={[styles.hint, styles.hintPhone]} testID="metric-target-hint">
          {targetHint(mode, value)}
        </Text>
      ) : null}
    </View>
  );

  return (
    <Modal transparent animationType="fade" onRequestClose={onClose} visible>
      <Pressable style={[styles.scrim, sheet && styles.scrimSheet]} accessibilityLabel="Close" onPress={onClose}>
        <Pressable style={[styles.card, sheet && styles.sheet]} onPress={() => {}} accessibilityLabel={`${area} metric`} testID="metric-picker">
          {sheet ? <View style={styles.grabber} /> : null}
          <View style={[styles.head, sheet && styles.headPhone]}>
            <View style={styles.headWords}>
              <Text variant="paneTitle" role="heading" aria-level={2} style={[styles.title, sheet && styles.titlePhone]} numberOfLines={1}>
                {`${area} metric`}
              </Text>
              <View style={styles.sub}>
                <OwnerFace face={face} size={14} />
                <Text style={[styles.subWords, sheet && styles.subWordsPhone]} numberOfLines={1}>{`${area} · ${owner ?? "No owner"}`}</Text>
              </View>
            </View>
            <Pressable onPress={onClose} role="button" accessibilityLabel="Close" hitSlop={8} style={styles.close} testID="metric-picker-close">
              <Icon name="close" size={13} color={colors.muted} />
            </Pressable>
          </View>

          <ScrollView style={styles.scroll} contentContainerStyle={[styles.body, sheet && styles.bodyPhone]} keyboardShouldPersistTaps="handled">
            {empty ? (
              <EmptyPicker phone={sheet} {...(onConnect === undefined ? {} : { onConnect })} />
            ) : (
              <>
                <View style={[styles.input, styles.search, sheet && styles.searchPhone, focused && styles.focus]}>
                  <Icon name="search" size={13} color={colors.text2} />
                  <TextInput
                    value={query}
                    onChangeText={setQuery}
                    placeholder="Search the workspace's metrics"
                    placeholderTextColor={colors.chromeMuted}
                    accessibilityLabel="Search the workspace's metrics"
                    onFocus={() => setFocused(true)}
                    onBlur={() => setFocused(false)}
                    style={[styles.searchField, sheet && styles.searchFieldPhone, fieldFont]}
                    testID="metric-picker-search"
                  />
                </View>
                <View style={styles.list} role="radiogroup" accessibilityLabel="Workspace metrics">
                  {!known ? <Text style={styles.waiting}>Reading the workspace's metrics…</Text> : null}
                  {known && shown.length === 0 ? <Text style={styles.waiting}>No metric has those words.</Text> : null}
                  {shown.map((option, at) => (
                    <OptionRow key={option.path} option={option} on={option.path === picked} first={at === 0} phone={sheet} onPick={() => setPicked(option.path)} />
                  ))}
                  {onNewMetric === undefined ? null : <NewMetricRow phone={sheet} onPress={onNewMetric} />}
                </View>
                {target}
              </>
            )}
            {problem === null ? null : (
              <Text variant="error" role="alert" testID="metric-picker-problem">
                {problem}
              </Text>
            )}
          </ScrollView>

          <View style={[styles.foot, sheet && styles.footPhone]}>
            {empty ? (
              <Text style={styles.note}>
                {onConnect === undefined ? "A metric is a note in the data folder's metrics folder." : (
                  <>
                    Connecting makes a <Text style={styles.noteStrong}>data</Text> folder in your workspace. You can rename or move it; Context finds it by what it holds.
                  </>
                )}
              </Text>
            ) : (
              <>
                <Text style={[styles.note, sheet && styles.notePhone]} numberOfLines={sheet ? 2 : 1}>{`Saved in ${aboutPath}`}</Text>
                <View style={[styles.buttons, sheet && styles.buttonsPhone]}>
                  <Button label="Cancel" variant="dialog" onPress={onClose} {...(sheet ? { style: styles.buttonPhone } : {})} testID="metric-picker-cancel" />
                  <Button
                    label={busy ? "Saving…" : "Save"}
                    variant="dialogPrimary"
                    disabled={choice === null || busy}
                    onPress={() => void save()}
                    {...(sheet ? { style: styles.buttonPhone } : {})}
                    testID="metric-picker-save"
                  />
                </View>
              </>
            )}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    scrim: { flex: 1, backgroundColor: "rgba(3,3,4,.42)", alignItems: "center", justifyContent: "center", padding: 24 },
    scrimSheet: { justifyContent: "flex-end", padding: 0 },
    card: {
      width: "100%",
      maxWidth: 520,
      maxHeight: "92%",
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.console,
      backgroundColor: colors.surface2,
      overflow: "hidden",
      boxShadow: "0 30px 80px -30px rgba(0,0,0,.55)",
    },
    sheet: { maxWidth: "100%", borderWidth: 0, borderTopWidth: 1, borderBottomLeftRadius: 0, borderBottomRightRadius: 0, borderTopLeftRadius: radii.sheet, borderTopRightRadius: radii.sheet },
    grabber: { alignSelf: "center", width: 36, height: 5, borderRadius: 3, backgroundColor: colors.lineStrong, marginTop: 8 },
    head: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingTop: 18, paddingHorizontal: 20 },
    headPhone: { paddingTop: 12, paddingHorizontal: 16 },
    headWords: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
    title: { fontSize: pointerType.lede, lineHeight: 22, fontWeight: "600" },
    titlePhone: { fontSize: touchType.lede, lineHeight: 22 },
    sub: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
    subWords: { fontSize: pointerType.meta, lineHeight: 17, color: colors.muted },
    subWordsPhone: { fontSize: pointerType.ui },
    close: { width: 26, height: 26, marginTop: -2, marginRight: -6, borderRadius: radii.sm, alignItems: "center", justifyContent: "center" },
    scroll: { flexGrow: 0, flexShrink: 1 },
    body: { gap: 14, paddingTop: 16, paddingBottom: 18, paddingHorizontal: 20 },
    bodyPhone: { paddingHorizontal: 16, gap: 14 },

    input: { height: 34, borderWidth: 1, borderColor: colors.lineStrong, borderRadius: radii.sm, backgroundColor: colors.cardSurface },
    search: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10 },
    searchPhone: { height: 40 },
    focus: { borderColor: colors.accent, boxShadow: `0 0 0 3px ${colors.accentDim}` },
    searchField: { flexGrow: 1, flexShrink: 1, minWidth: 0, height: "100%", fontFamily: fonts.body, fontSize: pointerType.ui, color: colors.text, outlineStyle: "none" } as never,
    searchFieldPhone: { fontSize: touchType.ui },
    list: { borderWidth: 1, borderColor: colors.line, borderRadius: radii.card, backgroundColor: colors.cardSurface, overflow: "hidden" },
    waiting: { fontSize: pointerType.meta, color: colors.muted, padding: 12 },

    targetBlock: { gap: 6 },
    label: { fontSize: pointerType.meta, lineHeight: 16, fontWeight: "600", color: colors.text2 },
    targetRow: { flexDirection: "row", alignItems: "center", gap: 10 },
    valueInput: { width: 112, paddingHorizontal: 10, fontFamily: fonts.body, fontSize: pointerType.ui, color: colors.text },
    valueInputPhone: { width: undefined, flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0, height: 44, fontSize: touchType.ui },
    hint: { flexShrink: 1, fontSize: pointerType.meta, lineHeight: 16, color: colors.muted },
    hintPhone: { fontSize: pointerType.ui, lineHeight: 18 },

    foot: { flexDirection: "row", alignItems: "center", gap: 10, borderTopWidth: 1, borderTopColor: colors.line, paddingVertical: 14, paddingHorizontal: 20 },
    footPhone: { flexDirection: "column", alignItems: "stretch", paddingHorizontal: 16, paddingBottom: 24, gap: 12 },
    note: { flexGrow: 1, flexShrink: 1, minWidth: 0, fontSize: pointerType.meta, lineHeight: 16, color: colors.muted },
    notePhone: { fontSize: pointerType.ui, lineHeight: 18 },
    noteStrong: { fontWeight: "600", color: colors.text2 },
    buttons: { flexDirection: "row", gap: 10 },
    buttonsPhone: { gap: 12 },
    buttonPhone: { flexGrow: 1, flexBasis: 0, height: 48 },
  });
