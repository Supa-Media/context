/**
 * The Features tab's small parts, sized like settings rather than like a form (the owner, 2026-11-11, on the first
 * draft: oversized buttons, a full-width field always open, an empty box a third of the screen tall). A section is a
 * heading over hairline rows, never a tinted box; a choice is one segmented switch whose three parts are the same
 * size; people are small chips with an ×; a field opens only on "+ Add".
 */

import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { fonts, leading, radii, space, useColors, useThemedStyles, Text, type Colors } from "../design";
import { pointerType } from "../design/tokens";
import { useFieldFont } from "../design/fieldFont";
import { useCompact } from "./AdminKit";
import { messageFor } from "./SecretDialogs";

/** One change at a time, with the server's refusal in words. */
export function useAct() {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  async function act(run: () => Promise<unknown>, fallback: string): Promise<boolean> {
    setBusy(true);
    setProblem(null);
    try {
      await run();
      return true;
    } catch (error: unknown) {
      setProblem(messageFor(error, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, problem, act };
}

export type Act = ReturnType<typeof useAct>["act"];

/** A section: its heading, and on the right a quiet sentence or an action. */
export function Section({ title, aside, children, testID }: { title: string; aside?: ReactNode; children: ReactNode; testID?: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.section} testID={testID}>
      <View style={styles.sectionHead}>
        <Text variant="rowTitle" role="heading" aria-level={2} style={styles.sectionTitle}>
          {title}
        </Text>
        {typeof aside === "string" ? <Text variant="meta">{aside}</Text> : aside}
      </View>
      <View style={styles.rows}>{children}</View>
    </View>
  );
}

/** A row under a section heading: a hairline above it, nothing around it. */
export function Row({ children, testID }: { children: ReactNode; testID?: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.row} testID={testID}>
      {children}
    </View>
  );
}

/** A blue word that does something, such as "+ New group". */
export function LinkButton({ label, onPress, disabled = false, quiet = false, testID }: { label: string; onPress: () => void; disabled?: boolean; quiet?: boolean; testID?: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable role="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} testID={testID} style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.link, hovered && styles.linkHover, disabled && styles.disabled]}>
      <Text variant="meta" style={quiet ? styles.quietText : styles.linkText}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Off, Testers, Everyone: one control, every part the same size, blue only on the one that is on. */
export function ModeSwitch<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled,
  testID,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  disabled: boolean;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  return (
    <View style={[styles.switch, compact && styles.switchWide]} role="radiogroup" aria-label={label}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            role="radio"
            aria-checked={on}
            accessibilityLabel={o.label}
            disabled={disabled}
            onPress={() => (on ? undefined : onChange(o.value))}
            testID={`${testID}-${o.value}`}
            style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.segment, compact && styles.segmentWide, on ? styles.segmentOn : hovered && styles.segmentHover]}
          >
            <Text variant="meta" style={on ? styles.segmentOnText : styles.segmentText}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export type ChipSpec = { key: string; name: string; count?: number; onRemove: () => Promise<unknown> };

/** One removable name: "@seyi ×", or a group with its head count, "Dogfood 4 ×". */
function Chip({ chip, act, busy, testID }: { chip: ChipSpec; act: Act; busy: boolean; testID: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.chip}>
      <Text variant="meta" style={styles.chipText} numberOfLines={1}>
        {chip.name}
        {chip.count === undefined ? null : <Text variant="meta"> {chip.count}</Text>}
      </Text>
      <Pressable
        role="button"
        accessibilityLabel={`Remove ${chip.name}`}
        disabled={busy}
        onPress={() => void act(chip.onRemove, "That was not removed. Try again.")}
        testID={`${testID}-remove-${chip.name}`}
        style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.chipX, hovered && styles.chipXHover]}
      >
        <Text variant="meta" style={styles.chipXText}>
          ×
        </Text>
      </Pressable>
    </View>
  );
}

export type Suggestion = { key: string; name: string; note: string; onPick: () => Promise<unknown> };

/**
 * A line of chips ending in "+ Add", which turns into a small field in place. Typing narrows `suggestions` (groups),
 * a tap on one adds it; Enter adds what was typed, as the matching suggestion when the words are its name.
 */
export function ChipLine({
  label,
  chips,
  suggestions = [],
  addLabel,
  placeholder,
  onAdd,
  act,
  busy,
  testID,
}: {
  label?: string;
  chips: ChipSpec[];
  suggestions?: Suggestion[];
  addLabel: string;
  placeholder: string;
  onAdd: (typed: string) => Promise<boolean>;
  act: Act;
  busy: boolean;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const fieldFont = useFieldFont(pointerType.ui);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const words = typed.trim().toLowerCase();
  const shown = suggestions.filter((s) => words === "" || s.name.toLowerCase().includes(words));
  const close = () => {
    setOpen(false);
    setTyped("");
  };
  async function submit() {
    if (words === "") return;
    const exact = suggestions.find((s) => s.name.toLowerCase() === words);
    const done = exact ? await act(exact.onPick, "That group was not added. Try again.") : await onAdd(typed.trim());
    if (done) close();
  }
  return (
    <View style={styles.chipLine} testID={testID}>
      {label === undefined ? null : (
        <Text variant="meta" style={styles.lineLabel}>
          {label}
        </Text>
      )}
      {chips.map((c) => (
        <Chip key={c.key} chip={c} act={act} busy={busy} testID={testID} />
      ))}
      {open ? (
        <View style={styles.addWrap}>
          <View style={styles.addRow}>
            <TextInput
              accessibilityLabel={addLabel}
              autoFocus
              value={typed}
              onChangeText={setTyped}
              onSubmitEditing={() => void submit()}
              onKeyPress={(e) => (e.nativeEvent.key === "Escape" ? close() : undefined)}
              placeholder={placeholder}
              placeholderTextColor={colors.muted}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!busy}
              style={[styles.field, fieldFont]}
              testID={`${testID}-field`}
            />
            <LinkButton label="Add" disabled={busy || words === ""} onPress={() => void submit()} testID={`${testID}-button`} />
            <LinkButton label="Cancel" quiet onPress={close} testID={`${testID}-cancel`} />
          </View>
          {shown.length === 0 ? null : (
            <View style={styles.suggestions}>
              {shown.map((s) => (
                <Pressable
                  key={s.key}
                  role="button"
                  accessibilityLabel={`Add ${s.name}`}
                  disabled={busy}
                  onPress={() => void act(s.onPick, "That group was not added. Try again.").then((done) => (done ? close() : undefined))}
                  testID={`${testID}-pick-${s.name}`}
                  style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.suggestion, hovered && styles.suggestionHover]}
                >
                  <Text variant="meta" style={styles.chipText}>
                    {s.name}
                  </Text>
                  <Text variant="meta">{s.note}</Text>
                </Pressable>
              ))}
            </View>
          )}
        </View>
      ) : (
        <Pressable role="button" accessibilityLabel={addLabel} disabled={busy} onPress={() => setOpen(true)} testID={`${testID}-open`} style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.addChip, hovered && styles.linkHover]}>
          <Text variant="meta" style={styles.linkText}>
            + Add
          </Text>
        </Pressable>
      )}
    </View>
  );
}

const CHIP = 28;

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    section: { marginBottom: space.x5 * 2, minWidth: 0 },
    sectionHead: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", justifyContent: "space-between", columnGap: space.x4, rowGap: 2, paddingBottom: space.x2 },
    sectionTitle: { fontSize: pointerType.lede, lineHeight: leading(pointerType.lede, 1.4), fontWeight: "700" },
    rows: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
    row: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, paddingVertical: space.x4, gap: space.x3, minWidth: 0 },
    link: { paddingHorizontal: 4, paddingVertical: 2, borderRadius: radii.sm },
    linkHover: { backgroundColor: colors.surface3 },
    linkText: { color: colors.accent, fontWeight: "500" },
    quietText: { color: colors.muted },
    disabled: { opacity: 0.45 },
    switch: { flexDirection: "row", alignSelf: "flex-start", borderWidth: 1, borderColor: colors.lineStrong, borderRadius: 8, padding: 2, gap: 2 },
    switchWide: { alignSelf: "stretch" },
    segment: { height: 28, paddingHorizontal: 14, borderRadius: 6, alignItems: "center", justifyContent: "center" },
    segmentWide: { flex: 1, height: 32 },
    segmentHover: { backgroundColor: colors.surface3 },
    segmentOn: { backgroundColor: colors.accent },
    segmentText: { color: colors.text2, fontWeight: "500" },
    segmentOnText: { color: colors.ink, fontWeight: "600" },
    chipLine: { flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start", gap: 6, minWidth: 0 },
    lineLabel: { marginRight: 4, lineHeight: CHIP },
    chip: { height: CHIP, maxWidth: "100%", flexDirection: "row", alignItems: "center", gap: 2, paddingLeft: 10, paddingRight: 3, borderWidth: 1, borderColor: colors.lineStrong, borderRadius: radii.pill },
    chipText: { color: colors.text, flexShrink: 1 },
    chipX: { width: 20, height: 20, borderRadius: radii.pill, alignItems: "center", justifyContent: "center" },
    chipXHover: { backgroundColor: colors.surface3 },
    chipXText: { color: colors.muted, fontSize: pointerType.ui, lineHeight: 16 },
    addChip: { height: CHIP, paddingHorizontal: 10, justifyContent: "center", borderWidth: 1, borderStyle: "dashed", borderColor: colors.lineStrong, borderRadius: radii.pill },
    addWrap: { position: "relative", zIndex: 5, flexShrink: 1, minWidth: 0 },
    addRow: { flexDirection: "row", alignItems: "center", gap: space.x1, height: CHIP },
    field: {
      height: 28,
      width: 220,
      maxWidth: "100%",
      flexShrink: 1,
      paddingHorizontal: 10,
      borderWidth: 1,
      borderColor: colors.accent,
      borderRadius: 7,
      fontFamily: fonts.body,
      fontSize: pointerType.ui,
      color: colors.text,
      outlineStyle: "none",
    } as object,
    suggestions: {
      marginTop: 4,
      width: 220,
      maxWidth: "100%",
      padding: 4,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: 9,
      backgroundColor: colors.ground,
      gap: 2,
    },
    suggestion: { flexDirection: "row", justifyContent: "space-between", gap: space.x2, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6 },
    suggestionHover: { backgroundColor: colors.surface3 },
  });
