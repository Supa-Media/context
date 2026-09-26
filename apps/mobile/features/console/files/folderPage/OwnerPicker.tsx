/**
 * The owner picker: a search field over the workspace's people and connected
 * agents, and nothing to type a new owner into.
 *
 * What it offers is `owners.ts`; who matches is asked of the server as the
 * field changes (`OwnerSearch`), a moment after the last keystroke, so a
 * workspace of a hundred people is searched where the people are and only the
 * best few come back. Before anything is typed it offers the owners this
 * folder already uses, then the reader, then everybody else.
 *
 * A popover under the value with room for one, a sheet from the bottom on a
 * phone — the rule `Menu` uses, and for the same reason: the room decides,
 * not the device. Arrows move, Enter chooses, Escape closes.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, TextInput, useWindowDimensions, type Role } from "react-native";
import { isolateForDisplay } from "@context/shared/src/displayText.cjs";
import { Text } from "../../../design/components/Text";
import { place } from "../../../design/components/popoverPlacement";
import { fonts, layout, pointerType, radii, space } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { ownerRows, type OwnerResults, type OwnerRow, type OwnerSearch } from "../owners";

/** How long the field waits for typing to pause before it asks. */
export const OWNER_SEARCH_DELAY_MS = 150;
const WIDTH = 280;
const HEIGHT = 340;
/** Missing from React Native's `Role` union, and forwarded to the DOM as-is (see `Palette`). */
const LISTBOX_ROLE = "listbox" as unknown as Role;

export function OwnerPicker({
  current,
  search,
  prefer,
  anchor,
  savesTo,
  onChoose,
  onDismiss,
}: {
  current: string;
  search: OwnerSearch;
  /** The owners this folder already uses, most used first. */
  prefer: readonly string[];
  anchor: { x: number; y: number } | null;
  savesTo: string | null;
  onChoose: (value: string | null) => void;
  onDismiss: () => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const view = useWindowDimensions();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<OwnerResults | null>(null);
  const [failed, setFailed] = useState(false);
  const [focus, setFocus] = useState(0);
  const asked = useRef(0);
  // The current owner is always preferred, so a hand-typed first name finds its member.
  const preferred = useMemo(() => (current === "" ? prefer : [current, ...prefer]), [current, prefer]);

  useEffect(() => {
    const ticket = ++asked.current;
    const timer = setTimeout(
      () => {
        search(query, preferred)
          .then((found) => {
            if (ticket !== asked.current) return;
            setResults(found);
            setFailed(false);
            setFocus(0);
          })
          .catch(() => {
            if (ticket === asked.current) setFailed(true);
          });
      },
      query === "" ? 0 : OWNER_SEARCH_DELAY_MS,
    );
    return () => clearTimeout(timer);
  }, [search, query, preferred]);

  const rows = ownerRows(query, current, results);
  const choices = rows.flatMap((row, index) => (row.kind === "choice" ? [index] : []));
  const choose = (row: OwnerRow | undefined) => {
    if (row === undefined || row.kind !== "choice") return;
    onDismiss();
    if (row.checked) return;
    onChoose(row.value);
  };

  const sheet = view.width < layout.narrowBreakpoint || anchor === null;
  const box = sheet ? null : place(anchor.x, anchor.y, { width: WIDTH, height: HEIGHT }, view, { minHeight: 120 });
  const note =
    failed ? "Couldn’t search just now. Try again in a moment."
    : results === null ? "Searching…"
    : choices.length === 0 ? "Nobody in this workspace matches."
    : results.truncated && query === "" ? "Type to find anybody else."
    : null;

  return (
    <Modal transparent visible animationType={sheet ? "slide" : "none"} onRequestClose={onDismiss}>
      <Pressable style={[styles.scrim, sheet && styles.scrimSheet]} accessibilityLabel="Close owner picker" onPress={onDismiss}>
        <Pressable
          onPress={() => {}}
          style={sheet ? styles.sheet : [styles.popover, box === null ? null : { left: box.left, top: box.top, width: box.width, maxHeight: box.height }]}
          accessibilityLabel="Owner"
          testID="owner-picker"
        >
          <TextInput
            autoFocus
            value={query}
            onChangeText={setQuery}
            placeholder="Search people and agents"
            placeholderTextColor={colors.chromeMuted}
            accessibilityLabel="Search people and agents"
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.field}
            testID="owner-picker-field"
            onKeyPress={(event) => {
              const key = event.nativeEvent.key;
              if (key === "Escape") onDismiss();
              else if (key === "ArrowDown" || key === "ArrowUp") {
                (event as unknown as { preventDefault?: () => void }).preventDefault?.();
                if (choices.length > 0) setFocus((at) => (at + (key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length);
              }
            }}
            onSubmitEditing={() => choose(rows[choices[focus] ?? -1])}
          />
          <ScrollView style={styles.list} keyboardShouldPersistTaps="handled" role={LISTBOX_ROLE} testID="owner-picker-list">
            {rows.map((row, index) =>
              row.kind === "heading" ? (
                <Text key={`h:${row.label}`} variant="treeMeta" style={styles.heading}>
                  {row.label}
                </Text>
              ) : (
                <Pressable
                  key={`c:${row.value ?? ""}:${index}`}
                  role="option"
                  aria-selected={row.checked}
                  accessibilityLabel={row.detail === undefined ? row.label : `${row.label}, ${row.detail}`}
                  onPress={() => choose(row)}
                  onHoverIn={() => setFocus(choices.indexOf(index))}
                  style={[styles.row, sheet && styles.rowTouch, choices[focus] === index && styles.rowLit]}
                  testID="owner-picker-option"
                >
                  <Text variant="tree" style={styles.check} aria-hidden>
                    {row.checked ? "✓" : ""}
                  </Text>
                  <Text variant="tree" numberOfLines={1} style={[styles.label, row.value === null && styles.muted]}>
                    {row.value === null ? row.label : isolateForDisplay(row.label)}
                  </Text>
                  {row.detail === undefined ? null : (
                    <Text variant="treeMeta" numberOfLines={1} style={styles.detail}>
                      {isolateForDisplay(row.detail)}
                    </Text>
                  )}
                </Pressable>
              ),
            )}
            {note === null ? null : (
              <Text variant="treeMeta" style={styles.note} role="status" testID="owner-picker-note">
                {note}
              </Text>
            )}
            {savesTo === null ? null : (
              <Text variant="treeMeta" style={styles.note}>
                {`Saves to ${savesTo}`}
              </Text>
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    scrim: { flex: 1 },
    scrimSheet: { backgroundColor: "rgba(3,3,4,.72)", justifyContent: "flex-end" },
    popover: {
      position: "absolute",
      padding: 6,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.xl,
      backgroundColor: colors.surface3,
      boxShadow: "0 24px 60px -18px rgba(0,0,0,.9)",
    },
    sheet: {
      maxHeight: "80%",
      padding: space.x3,
      paddingBottom: space.x6,
      borderTopLeftRadius: radii.floating,
      borderTopRightRadius: radii.floating,
      borderTopWidth: 1,
      borderColor: colors.lineStrong,
      backgroundColor: colors.surface2,
    },
    field: {
      fontFamily: fonts.body,
      fontSize: pointerType.ui,
      color: colors.text,
      height: 30,
      paddingHorizontal: 8,
      marginBottom: 4,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.sm,
      backgroundColor: "transparent",
    },
    list: { flexGrow: 0 },
    heading: { color: colors.chromeMuted, paddingHorizontal: 10, paddingTop: 8, paddingBottom: 2 },
    row: { flexDirection: "row", alignItems: "center", gap: space.x2, height: 28, paddingHorizontal: 10, borderRadius: radii.sm },
    rowTouch: { height: 44 },
    rowLit: { backgroundColor: colors.accentDim },
    check: { width: 12, color: colors.accentText },
    label: { flexShrink: 1, color: colors.text },
    muted: { color: colors.text2 },
    detail: { marginLeft: "auto", flexShrink: 1, color: colors.chromeMuted },
    note: { color: colors.chromeMuted, paddingHorizontal: 10, paddingVertical: 6 },
  });
