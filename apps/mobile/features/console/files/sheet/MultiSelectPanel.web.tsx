/**
 * A multi-select cell being edited in the browser: a panel over the cell with
 * the chosen options as chips (each with a ✕), a field after them, and below,
 * the options not yet chosen, ending in Create when the typed word names none.
 * A pick adds a chip and keeps the panel open; Enter adds what is highlighted,
 * or saves and moves down when the field is empty; a comma adds too;
 * Backspace in an empty field takes the last chip off; Esc saves; Tab saves
 * and moves across. Pressing anywhere else saves.
 *
 * Drawn into the page's body at the cell's place, like the suggestion menu, so
 * the rows below and the grid's scrolling list neither cover nor cut it.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { Text } from "../../../design/components/Text";
import { pointerType, radii, space } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { CHOICE_BLUR_MS } from "./CellEditor";
import { addOption, chosenOf, draftOf, optionFor, pickerList } from "./multiSelect";
import { useFieldFont } from "../../../design/fieldFont";
import { OptionChip, type MultiSelectEditorProps } from "./multiSelectParts";

const PANEL_MIN = 300;
const LIST_MAX = 248;

export function MultiSelectPanel({ label, draft, options, anchor, initialTyped = "", onDraft, onFinish }: MultiSelectEditorProps) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const fieldFont = useFieldFont(pointerType.ui);
  const field = useRef<TextInput | null>(null);
  const [typed, setTyped] = useState(initialTyped);
  const [at, setAt] = useState<{ left: number; top: number; width: number } | null>(null);
  const chosen = chosenOf(draft);
  const list = pickerList(options, chosen, typed);
  const [highlight, setHighlight] = useState(list.highlight);
  useEffect(() => setHighlight(pickerList(options, chosenOf(draft), typed).highlight), [typed, draft, options]);

  useEffect(() => {
    let frame = 0;
    const measure = () => {
      const node = anchor.current as unknown as HTMLElement | null;
      if (!node || typeof node.getBoundingClientRect !== "function") return;
      const box = node.getBoundingClientRect();
      setAt((old) =>
        old && old.left === box.left && old.top === box.top && old.width === box.width ? old : { left: box.left, top: box.top, width: box.width },
      );
    };
    const follow = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
    };
  }, [anchor]);

  // Leaving the panel saves; a press inside it never takes focus from the field, so only a real leave gets here.
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (blurTimer.current !== null) clearTimeout(blurTimer.current);
  }, []);
  const keep = () => {
    if (blurTimer.current !== null) clearTimeout(blurTimer.current);
    blurTimer.current = null;
  };

  /** What the cell will hold with the typed word added, so a save never drops it. */
  const withTyped = (base: string[]) => (typed.trim() === "" ? base : addOption(base, optionFor(options, typed)));
  const set = (next: string[]) => onDraft(draftOf(next));
  const add = (value: string) => {
    keep();
    set(addOption(chosen, value));
    setTyped("");
    field.current?.focus();
  };
  const remove = (value: string) => {
    keep();
    set(chosen.filter((c) => c !== value));
    field.current?.focus();
  };
  const finish = (how: Parameters<MultiSelectEditorProps["onFinish"]>[0]) => {
    keep();
    const next = withTyped(chosen);
    if (next.length !== chosen.length) set(next);
    onFinish(how);
  };

  const rowCount = list.rows.length + (list.create === null ? 0 : 1);
  const onKeyDown = (event: KeyboardEvent) => {
    const k = event.key;
    if (k === "ArrowDown" || k === "ArrowUp") {
      event.preventDefault();
      if (rowCount > 0) setHighlight((h) => Math.max(0, Math.min(rowCount - 1, h + (k === "ArrowDown" ? 1 : -1))));
    } else if (k === "Enter") {
      event.preventDefault();
      if (typed.trim() === "" && highlight < 0) return finish("enter");
      if (highlight >= 0 && highlight < list.rows.length) add(list.rows[highlight]);
      else if (list.create !== null && (highlight === list.rows.length || highlight < 0)) add(list.create);
      else setTyped("");
    } else if (k === "Escape") {
      event.preventDefault();
      finish("save");
    } else if (k === "Tab") {
      event.preventDefault();
      finish(event.shiftKey ? "backtab" : "tab");
    } else if (k === "Backspace" && typed === "" && chosen.length > 0) {
      event.preventDefault();
      set(chosen.slice(0, -1));
    }
  };
  // Read in the capture phase, as the grid reads its keys: the field itself stops a key from bubbling.
  const keyRef = useRef(onKeyDown);
  keyRef.current = onKeyDown;
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const node = field.current as unknown as HTMLElement | null;
      if (!node || event.target !== node) return;
      keyRef.current(event);
      event.stopPropagation();
    };
    document.addEventListener("keydown", listener, true);
    return () => document.removeEventListener("keydown", listener, true);
  }, []);

  const onType = (value: string) => {
    if (!value.includes(",")) return setTyped(value);
    // A comma does Enter's job: what is before it becomes a chip.
    const parts = value.split(",");
    let next = chosen;
    for (const part of parts.slice(0, -1)) if (part.trim() !== "") next = addOption(next, optionFor(options, part));
    set(next);
    setTyped(parts[parts.length - 1].trimStart());
  };

  if (typeof document === "undefined") return null;
  const width = Math.max(PANEL_MIN, at?.width ?? 0);
  return createPortal(
    <div
      onMouseDown={(event) => {
        if (event.target !== (field.current as unknown as HTMLElement | null)) event.preventDefault();
      }}
    >
      <View
        style={[styles.panel, { left: at?.left ?? 0, top: at?.top ?? 0, width, opacity: at === null ? 0 : 1 }]}
        testID="sheet-multiselect-panel"
      >
        <View style={[styles.top, { borderColor: colors.accent }]}>
          {chosen.map((word) => (
            <OptionChip key={word} word={word} options={options}>
              <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${word}`} onPress={() => remove(word)} style={styles.remove} testID="sheet-chip-remove">
                <Text variant="meta" style={styles.removeText}>
                  ✕
                </Text>
              </Pressable>
            </OptionChip>
          ))}
          <TextInput
            ref={field}
            autoFocus
            accessibilityLabel={label}
            value={typed}
            onChangeText={onType}
            onFocus={keep}
            onBlur={() => {
              keep();
              blurTimer.current = setTimeout(() => {
                blurTimer.current = null;
                finish("blur");
              }, CHOICE_BLUR_MS);
            }}
            placeholder={chosen.length === 0 ? "Pick or type an option" : undefined}
            placeholderTextColor={colors.chromeMuted}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            style={[styles.field, fieldFont]}
            testID="sheet-cell-editor"
          />
        </View>
        {rowCount === 0 ? null : (
          <ScrollView style={styles.list} keyboardShouldPersistTaps="always" testID="sheet-cell-suggestions">
            {list.rows.map((word, i) => (
              <Pressable
                key={word}
                accessibilityRole="button"
                accessibilityState={{ selected: i === highlight }}
                onPress={() => add(word)}
                style={(state) => [styles.row, (i === highlight || (state as { hovered?: boolean }).hovered) && styles.rowOn]}
              >
                <OptionChip word={word} options={options} />
              </Pressable>
            ))}
            {list.create === null ? null : (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: highlight === list.rows.length }}
                onPress={() => add(list.create as string)}
                style={(state) => [styles.row, (highlight === list.rows.length || (state as { hovered?: boolean }).hovered) && styles.rowOn]}
                testID="sheet-option-create"
              >
                <Text variant="meta" style={styles.muted}>
                  Create
                </Text>
                <OptionChip word={list.create} options={options} />
                <Text variant="meta" style={[styles.muted, styles.enter]}>
                  ↵
                </Text>
              </Pressable>
            )}
          </ScrollView>
        )}
      </View>
    </div>,
    document.body,
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    panel: {
      position: "fixed" as "absolute",
      zIndex: 1000,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.xl,
      backgroundColor: colors.ground,
      boxShadow: "0 24px 60px -18px rgba(0,0,0,.45)",
      overflow: "hidden",
    } as object,
    top: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      gap: 4,
      minHeight: 34,
      padding: 4,
      paddingLeft: space.x1,
      borderWidth: 2,
      borderTopLeftRadius: radii.xl,
      borderTopRightRadius: radii.xl,
    },
    remove: { width: 16, height: 16, alignItems: "center", justifyContent: "center", marginRight: -4 },
    removeText: { color: colors.muted, fontSize: pointerType.label, lineHeight: 12 },
    field: {
      flexGrow: 1,
      minWidth: 80,
      height: 24,
      padding: 0,
      borderWidth: 0,
      color: colors.text,
      backgroundColor: "transparent",
      fontSize: pointerType.ui,
      outlineStyle: "none",
    } as object,
    list: { maxHeight: LIST_MAX, padding: space.x1 },
    row: { height: 30, flexDirection: "row", alignItems: "center", gap: space.x2, paddingHorizontal: space.x1, borderRadius: radii.sm },
    rowOn: { backgroundColor: colors.surface3 },
    muted: { color: colors.muted },
    enter: { marginLeft: "auto" },
  });
