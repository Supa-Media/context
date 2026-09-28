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
 * On Premium it also asks, once, who the note names (`suggest`), and shows
 * the answer above everybody else under "Suggested". Only when the search
 * said `suggests`: elsewhere the answer is always nobody, so nobody is asked.
 *
 * An agent opens a second step, "Whose Claude?", in the same box: just the
 * agent, or somebody's (`agents.ts`). A name the agent list lacks is offered
 * to be added when `onAddAgent` is given, and then asks whose, the same way.
 *
 * A popover under the value with room for one, a sheet from the bottom on a
 * phone — the rule `Menu` uses, and for the same reason: the room decides,
 * not the device. Arrows move, Enter chooses, Escape closes.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, TextInput, View, useWindowDimensions, type Role } from "react-native";
import { isolateForDisplay } from "@context/shared/src/displayText.cjs";
import { Text } from "../../../design/components/Text";
import { place } from "../../../design/components/popoverPlacement";
import { fonts, layout, pointerType, radii, space } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { ownerRows, whoseRows, type OwnerResults, type OwnerRow, type OwnerSearch } from "../owners";
import { useFieldFont } from "../../../design/fieldFont";

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
  suggest,
  anchor,
  savesTo,
  onChoose,
  onDismiss,
  onAddAgent,
}: {
  current: string;
  search: OwnerSearch;
  /** The owners this folder already uses, most used first. */
  prefer: readonly string[];
  /** Who this note names as its owner, or null; see `owners.ts`. */
  suggest?: (prefer: readonly string[]) => Promise<string | null>;
  anchor: { x: number; y: number } | null;
  savesTo: string | null;
  onChoose: (value: string | null) => void;
  onDismiss: () => void;
  /** Add a name to the workspace's agents; resolves to why not, or null. Absent where the list can't change. */
  onAddAgent?: (name: string) => Promise<string | null>;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const fieldFont = useFieldFont();
  const view = useWindowDimensions();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<OwnerResults | null>(null);
  const [failed, setFailed] = useState(false);
  const [focus, setFocus] = useState(0);
  const asked = useRef(0);
  const [suggested, setSuggested] = useState<string | null>(null);
  const suggesting = useRef(false);
  /** The agent whose owner is being asked, or null on the first step. */
  const [whose, setWhose] = useState<string | null>(null);
  const [addProblem, setAddProblem] = useState<string | null>(null);
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

  // Asked once, after a search says it is worth asking; a failure is no suggestion.
  const offered = results?.suggests === true;
  // The latest `suggest`, read when asking: its caller may rebuild it each render.
  const suggestNow = useRef(suggest);
  suggestNow.current = suggest;
  const open = useRef(true);
  useEffect(
    () => () => {
      open.current = false;
    },
    [],
  );
  useEffect(() => {
    const ask = suggestNow.current;
    if (!offered || ask === undefined || suggesting.current) return;
    suggesting.current = true;
    ask(preferred)
      .then((found) => {
        if (open.current) setSuggested(found);
      })
      .catch(() => {});
  }, [offered, preferred]);

  const rows = whose !== null ? whoseRows(whose, current, results) : ownerRows(query, current, results, suggested, { canAdd: onAddAgent !== undefined });
  const choices = rows.flatMap((row, index) => (row.kind === "heading" ? [] : [index]));
  const ask = (agent: string) => {
    setWhose(agent);
    setQuery("");
    setFocus(0);
    setAddProblem(null);
  };
  const choose = (row: OwnerRow | undefined) => {
    if (row === undefined || row.kind === "heading") return;
    if (row.kind === "add") {
      onAddAgent?.(row.name)
        .then((problem) => (problem === null ? ask(row.name) : setAddProblem(problem)))
        .catch(() => setAddProblem("Couldn’t add that agent just now."));
      return;
    }
    if (whose === null && row.agent !== undefined) {
      ask(row.agent);
      return;
    }
    onDismiss();
    if (row.checked) return;
    onChoose(row.value);
  };

  const sheet = view.width < layout.narrowBreakpoint || anchor === null;
  const box = sheet ? null : place(anchor.x, anchor.y, { width: WIDTH, height: HEIGHT }, view, { minHeight: 120 });
  const note =
    addProblem !== null ? addProblem
    : failed ? "Couldn’t search just now. Try again in a moment."
    : results === null ? "Searching…"
    : choices.length === 0 ? "Nobody in this workspace matches."
    : results.truncated && query === "" ? "Type to find anybody else."
    : null;
  const placeholder = whose === null ? "Search people and agents" : "Search people";

  return (
    <Modal transparent visible animationType={sheet ? "slide" : "none"} onRequestClose={onDismiss}>
      <Pressable style={[styles.scrim, sheet && styles.scrimSheet]} accessibilityLabel="Close owner picker" onPress={onDismiss}>
        <Pressable
          onPress={() => {}}
          style={sheet ? styles.sheet : [styles.popover, box === null ? null : { left: box.left, top: box.top, width: box.width, maxHeight: box.height }]}
          accessibilityLabel="Owner"
          testID="owner-picker"
        >
          {whose === null ? null : (
            <View style={styles.step}>
              <Pressable
                onPress={() => {
                  setWhose(null);
                  setQuery("");
                  setFocus(0);
                }}
                accessibilityLabel="Back to all owners"
                role="button"
                style={styles.back}
                testID="owner-picker-back"
              >
                <Text variant="tree" style={styles.muted} aria-hidden>
                  ‹
                </Text>
              </Pressable>
              <Text variant="tree" style={styles.title} role="heading" testID="owner-picker-step">
                {`Whose ${isolateForDisplay(whose)}?`}
              </Text>
            </View>
          )}
          <TextInput
            key={whose ?? ""}
            autoFocus
            value={query}
            onChangeText={(text) => {
              setQuery(text);
              setAddProblem(null);
            }}
            placeholder={placeholder}
            placeholderTextColor={colors.chromeMuted}
            accessibilityLabel={placeholder}
            autoCapitalize="none"
            autoCorrect={false}
            style={[styles.field, fieldFont]}
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
              ) : row.kind === "add" ? (
                <Pressable
                  key={`a:${row.name}`}
                  role="option"
                  aria-selected={false}
                  accessibilityLabel={row.label}
                  onPress={() => choose(row)}
                  onHoverIn={() => setFocus(choices.indexOf(index))}
                  style={[styles.row, sheet && styles.rowTouch, choices[focus] === index && styles.rowLit]}
                  testID="owner-picker-add"
                >
                  <Text variant="tree" style={[styles.check, styles.accent]} aria-hidden>
                    +
                  </Text>
                  <Text variant="tree" numberOfLines={1} style={[styles.label, styles.accent]}>
                    {isolateForDisplay(row.label)}
                  </Text>
                </Pressable>
              ) : (
                <Pressable
                  key={`c:${row.value ?? ""}:${index}`}
                  role="option"
                  aria-selected={row.checked}
                  accessibilityLabel={
                    (row.detail === undefined ? row.label : `${row.label}, ${row.detail}`) +
                    (whose === null && row.agent !== undefined ? ", choose whose" : "")
                  }
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
                  {whose === null && row.agent !== undefined ? (
                    <Text variant="tree" style={[styles.muted, row.detail === undefined && styles.push]} aria-hidden>
                      ›
                    </Text>
                  ) : null}
                </Pressable>
              ),
            )}
            {note === null ? null : (
              <Text variant="treeMeta" style={styles.note} role="status" testID="owner-picker-note">
                {note}
              </Text>
            )}
            {onAddAgent === undefined || whose !== null || query !== "" || results === null ? null : (
              <Text variant="treeMeta" style={styles.note} testID="owner-picker-add-hint">
                Type a name to add an agent.
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
    accent: { color: colors.accentText },
    push: { marginLeft: "auto" },
    step: { flexDirection: "row", alignItems: "center", gap: space.x1, marginBottom: 4 },
    back: { width: 28, height: 28, alignItems: "center", justifyContent: "center", borderRadius: radii.sm },
    title: { color: colors.text, fontWeight: "600" },
  });
