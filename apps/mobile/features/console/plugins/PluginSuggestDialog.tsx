import { useCallback, useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Text } from "../../design/components/Text";
import { fonts, layout, radii, space } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import type { RuntimeView } from "./runtime";

/**
 * The dialog a running plugin asked for, drawn by the console.
 *
 * ## Why this is not `Palette`
 *
 * It looks like one and deliberately so — same overlay, same shape, same
 * keyboard — but `Palette` ranks a fixed `items` array against the query
 * itself, and here **the plugin has already decided what matches and in what
 * order**. Running `rank` over its answer would quietly reorder somebody
 * else's results and drop the ones whose text does not contain the query, which
 * is most of them: Bible Reference answers `Gen 1:1` with the verse, and the
 * verse does not contain the string "Gen 1:1".
 *
 * So the query goes to the plugin and the rows come back in its order. What is
 * shared with `Palette` is the presentation, not the model.
 *
 * ## Nothing the plugin made is on screen
 *
 * The rows are strings. `renderSuggestion` ran in the sandbox, against an
 * element created in the sandbox, and only its `textContent` crossed — so a
 * plugin cannot put markup, an image, a link or a script in front of a reader.
 * That is the same inversion `registerEditorSuggest` uses and the reason both
 * exist at all; `docs/decisions/plugins.md` is the argument.
 *
 * The plugin's **name** is drawn because somebody is being asked to choose
 * something by third-party code, and "who is asking" is the first question that
 * deserves an answer.
 */
export function PluginSuggestDialog({ runtime }: { runtime?: RuntimeView }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  /*
    Optional, because the console renders this before it knows whether there is
    a runtime at all — a viewer who is not the owner has none, and neither does
    the landing page's demo. Absent is "no dialog", which is the same answer as
    no plugin having asked for one.
  */
  const modal = runtime?.modal ?? null;
  const ask = runtime?.actions?.askModalSuggestions;
  const pick = runtime?.actions?.pickModalSuggestion;
  const dismiss = runtime?.actions?.dismissModal;

  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<{ text: string }[]>([]);
  const [cursor, setCursor] = useState(0);
  /*
    Which query the rows on screen belong to. Typing outruns the round trip and
    the runtime already drops stale answers, but two queries can still resolve
    in the wrong order — this keeps the later one.
  */
  const asked = useRef(0);

  const key = modal === null ? null : `${modal.pluginId}:${modal.nonce}`;
  /*
    A new dialog starts empty, and this is keyed on the frame as well as the
    plugin: a restarted plugin opening a dialog is a different dialog, and
    carrying the previous one's typing into it would be answering a question
    nobody asked with somebody else's words.
  */
  useEffect(() => {
    setQuery("");
    setRows([]);
    setCursor(0);
  }, [key]);

  useEffect(() => {
    if (modal === null || ask === undefined) return;
    asked.current += 1;
    const mine = asked.current;
    void (async () => {
      const items = await ask(query);
      if (mine !== asked.current) return;
      setRows(items);
      setCursor(0);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask, key, query]);

  const choose = useCallback(
    (index: number) => {
      if (rows[index] === undefined) return;
      pick?.(index);
    },
    [pick, rows],
  );

  if (modal === null) return null;

  /*
    The same test `Palette` makes, for the same reason: the constraint is the
    room, not the input device, so a desktop browser dragged narrow gets the
    sheet too.
  */
  const touch = Platform.OS !== "web" || width < layout.narrowBreakpoint;

  return (
    <Modal
      transparent
      visible
      animationType="fade"
      onRequestClose={() => dismiss?.()}
      testID="plugin-suggest-dialog"
    >
      <Pressable
        style={styles.scrim}
        onPress={() => dismiss?.()}
        accessibilityLabel="Close"
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={[styles.centre, touch ? styles.centreTouch : styles.centrePointer]}
        >
          {/*
            The panel stops the scrim's press, so a press inside it is not a
            dismiss. `onStartShouldSetResponder` rather than another Pressable:
            nesting one inside a Pressable makes every row a double target.
          */}
          <View
            style={[styles.panel, { paddingBottom: touch ? insets.bottom : 0 }]}
            onStartShouldSetResponder={() => true}
          >
            <View style={styles.head}>
              <Text variant="treeMeta" style={styles.who}>
                {modal.pluginId}
              </Text>
            </View>
            <TextInput
              style={styles.input}
              value={query}
              onChangeText={setQuery}
              placeholder={modal.placeholder || "Search"}
              placeholderTextColor={colors.muted}
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              testID="plugin-suggest-query"
              onSubmitEditing={() => choose(cursor)}
              // Escape closes, and arrows walk — the same keys `Palette` binds,
              // because a reader should not have to learn a second dialog.
              onKeyPress={(event) => {
                const pressed = (event.nativeEvent as { key?: string }).key;
                if (pressed === "Escape") dismiss?.();
                else if (pressed === "ArrowDown") {
                  setCursor((at) => Math.min(rows.length - 1, at + 1));
                } else if (pressed === "ArrowUp") {
                  setCursor((at) => Math.max(0, at - 1));
                }
              }}
            />
            <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
              {rows.length === 0 ? (
                <Text variant="rowSub" style={styles.empty} testID="plugin-suggest-empty">
                  No suggestions.
                </Text>
              ) : (
                rows.map((row, index) => (
                  <Pressable
                    key={`${index}:${row.text}`}
                    style={[styles.row, index === cursor && styles.rowActive]}
                    onPress={() => choose(index)}
                    onHoverIn={() => setCursor(index)}
                    accessibilityRole="button"
                    testID={`plugin-suggest-row-${index}`}
                  >
                    <Text variant="rowTitle" numberOfLines={2}>
                      {row.text}
                    </Text>
                  </Pressable>
                ))
              )}
            </ScrollView>
            {modal.instructions.length > 0 ? (
              <View style={styles.foot}>
                {modal.instructions.map((row) => (
                  <Text key={`${row.command}:${row.purpose}`} variant="hint" style={styles.hint}>
                    {[row.command, row.purpose].filter(Boolean).join(" ")}
                  </Text>
                ))}
              </View>
            ) : null}
          </View>
        </KeyboardAvoidingView>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    // The literal the other four overlays here use rather than `colors.scrim`,
    // which no overlay in this codebase uses yet — see `Overlay`.
    scrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)" },
    centre: { flex: 1, alignItems: "center" },
    // Near the top third rather than centred: a centred box moves its own first
    // row every time the result count changes. `Palette`'s reasoning, kept.
    centrePointer: { paddingTop: "12%" },
    centreTouch: { justifyContent: "flex-end" },
    panel: {
      width: "100%",
      maxWidth: 560,
      backgroundColor: colors.surface,
      borderRadius: radii.card,
      borderWidth: 1,
      borderColor: colors.line,
      overflow: "hidden",
    },
    head: { paddingHorizontal: space.x3, paddingTop: space.x3 },
    who: { color: colors.muted },
    input: {
      fontFamily: fonts.body,
      fontSize: 16,
      color: colors.text,
      paddingHorizontal: space.x3,
      paddingVertical: space.x3,
      borderBottomWidth: 1,
      borderBottomColor: colors.line,
    },
    list: { maxHeight: 320 },
    row: { paddingHorizontal: space.x3, paddingVertical: space.x2 },
    rowActive: { backgroundColor: colors.accentDim },
    empty: { padding: space.x3, color: colors.muted },
    foot: {
      borderTopWidth: 1,
      borderTopColor: colors.line,
      paddingHorizontal: space.x3,
      paddingVertical: space.x2,
      gap: 2,
    },
    hint: { color: colors.muted },
  });
