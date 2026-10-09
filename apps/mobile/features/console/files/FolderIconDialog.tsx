import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, TextInput, View, useWindowDimensions } from "react-native";
import { WORKSPACE_ICON_EMOJI, isSingleEmoji } from "@context/shared";
import { densityFor } from "../../app/frame";
import { Button } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { fonts, pointerType as t, radii, space } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { useFieldFont } from "../../design/fieldFont";
import { useCustomEmoji } from "../emoji/context";
import { EmojiGlyph } from "../emoji/EmojiGlyph";
import { toFileError } from "./browser";
import { Shell, type DialogAnchor } from "./DialogShell";
import { allStandardEmoji, searchStandardEmoji } from "./emoji/standardEmoji";
import { baseName, folderLabel } from "./paths";

/** How many of every emoji are drawn at first, and added each time the list is scrolled near its end. */
export const EMOJI_PAGE = 240;
/** The most a search shows: past this, the answer is a better word. */
const SEARCH_LIMIT = 160;

const NO_NAMES: readonly string[] = [];

interface Cell {
  /** What is stored: the character, or `:name:` for one of the workspace's own. */
  readonly icon: string;
  /** What a screen reader hears. */
  readonly label: string;
}

/**
 * "Set icon…" on a folder: any emoji, or one of the workspace's own.
 *
 * It started as the workspace icon's thirty-six (`WORKSPACE_ICON_EMOJI`), and
 * the owner found that too few (2026-10-08): a folder icon can be any emoji,
 * and the workspace's own emoji too, through the same list and the same Add
 * emoji dialog the editor's `:` menu uses (`CustomEmojiProvider`). So the
 * search here is the `:` menu's search, over the same table, and a workspace
 * emoji is stored the way a note writes it, `:name:`.
 *
 * With nothing typed it shows the workspace's own emoji, the thirty-six, and
 * then every emoji, drawn a page at a time as the list is scrolled, so opening
 * the dialog does not build two thousand buttons. An emoji pasted or typed
 * from the keyboard's own picker is offered as it is.
 *
 * A tap sets the icon and closes; the dialog stays open until the server has
 * answered, so a refusal is read here rather than lost behind a closed sheet.
 * "Remove icon" is there only when the folder has one.
 */
export function FolderIconDialog({
  path,
  current,
  onSet,
  onClose,
  anchor,
}: {
  path: string;
  /** The folder's icon now, or `null`. */
  current: string | null;
  /** Rejects with the server's refusal, which is shown here. */
  onSet: (icon: string | null) => Promise<void>;
  onClose: () => void;
  /** Opened from the folder's icon in the tree: a popover there rather than a dialog in the middle. */
  anchor?: DialogAnchor;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const fieldFont = useFieldFont();
  const host = useCustomEmoji();
  const sheet = densityFor(useWindowDimensions().width) === "compact";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [shown, setShown] = useState(EMOJI_PAGE);

  const custom = host?.names ?? NO_NAMES;
  const sections = useMemo(() => sectionsFor(query, custom, shown), [query, custom, shown]);

  async function choose(icon: string | null) {
    setBusy(true);
    setError(null);
    try {
      await onSet(icon);
      onClose();
    } catch (failure) {
      setError(toFileError(failure).message);
      setBusy(false);
    }
  }

  async function addOwn() {
    if (host?.openAdd === undefined) return;
    const name = await host.openAdd({ query: query.trim().replace(/^:|:$/g, ""), tab: "upload" });
    if (name !== null) await choose(`:${name}:`);
  }

  return (
    <Shell title="Folder icon" onClose={onClose} sheet={sheet} anchor={anchor}>
      <Text variant="paneSub" testID="folder-icon-name">
        {folderLabel(baseName(path))}
      </Text>
      <TextInput
        value={query}
        onChangeText={(next) => {
          setQuery(next);
          setShown(EMOJI_PAGE);
        }}
        autoFocus={!sheet}
        placeholder="Search emoji"
        placeholderTextColor={colors.muted}
        accessibilityLabel="Search emoji"
        style={[styles.input, focused && styles.inputFocused, fieldFont]}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        testID="folder-icon-search"
      />
      <ScrollView
        style={styles.scroll}
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={64}
        onScroll={({ nativeEvent: { layoutMeasurement, contentOffset, contentSize } }) => {
          if (layoutMeasurement.height + contentOffset.y >= contentSize.height - 120) {
            setShown((value) => value + EMOJI_PAGE);
          }
        }}
        testID="folder-icon-scroll"
      >
        {sections.length === 0 ? (
          <Text variant="meta" style={styles.empty} testID="folder-icon-none">
            No emoji called that.
          </Text>
        ) : (
          sections.map((section) => (
            <View key={section.title} style={styles.section}>
              <Text variant="eyebrow" style={styles.sectionTitle}>
                {section.title}
              </Text>
              <View style={styles.grid}>
                {section.cells.map((cell) => {
                  const chosen = current === cell.icon;
                  return (
                    <Pressable
                      key={cell.icon}
                      role="button"
                      accessibilityLabel={`Use ${cell.label} as this folder’s icon`}
                      accessibilityState={{ selected: chosen, disabled: busy }}
                      disabled={busy}
                      onPress={() => void choose(cell.icon)}
                      style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [
                        styles.cell,
                        hovered && styles.cellHover,
                        chosen && styles.cellChosen,
                      ]}
                      testID={`folder-icon-emoji-${cell.icon}`}
                    >
                      <EmojiGlyph
                        emoji={cell.icon}
                        size={26}
                        textStyle={styles.glyph}
                        fallback={<Text variant="meta">?</Text>}
                      />
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ))
        )}
      </ScrollView>
      <View style={styles.actions}>
        <Button label="Cancel" variant="dialog" onPress={onClose} disabled={busy} />
        {host?.openAdd === undefined ? null : (
          <Button
            label="Add emoji…"
            variant="dialog"
            onPress={() => void addOwn()}
            disabled={busy}
            testID="folder-icon-add"
          />
        )}
        {current === null ? null : (
          <Button
            label="Remove icon"
            variant="dialog"
            onPress={() => void choose(null)}
            disabled={busy}
            testID="folder-icon-remove"
          />
        )}
      </View>
      {error === null ? null : (
        <Text variant="rowSub" style={styles.error} testID="folder-icon-error">
          {error}
        </Text>
      )}
    </Shell>
  );
}

/**
 * What the grid shows for `query`: the sections, each a title and its cells,
 * empty ones left out. Exported for its tests.
 */
export function sectionsFor(
  query: string,
  custom: readonly string[],
  shown: number,
): Array<{ title: string; cells: Cell[] }> {
  const typed = query.trim();
  const own = (names: readonly string[]): Cell[] => names.map((name) => ({ icon: `:${name}:`, label: `:${name}:` }));
  if (typed === "") {
    const seen = new Set<string>(WORKSPACE_ICON_EMOJI);
    return [
      { title: "This workspace", cells: own(custom) },
      { title: "Suggested", cells: WORKSPACE_ICON_EMOJI.map((char) => ({ icon: char, label: char })) },
      {
        title: "All emoji",
        cells: allStandardEmoji()
          .filter((emoji) => !seen.has(emoji.char))
          .slice(0, shown)
          .map((emoji) => ({ icon: emoji.char, label: emoji.names[0] ?? emoji.char })),
      },
    ].filter((section) => section.cells.length > 0);
  }
  // Something pasted from the keyboard's own picker is used as it is.
  if (isSingleEmoji(typed)) return [{ title: "Emoji", cells: [{ icon: typed, label: typed }] }];
  const needle = typed.replace(/^:|:$/g, "").toLowerCase();
  if (needle === "") return [];
  const found: Cell[] = [];
  const taken = new Set<string>();
  for (const { emoji } of searchStandardEmoji(needle, SEARCH_LIMIT)) {
    if (taken.has(emoji.char)) continue;
    taken.add(emoji.char);
    found.push({ icon: emoji.char, label: emoji.names[0] ?? emoji.char });
  }
  return [
    { title: "This workspace", cells: own(custom.filter((name) => name.includes(needle))) },
    { title: "Emoji", cells: found },
  ].filter((section) => section.cells.length > 0);
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    input: {
      fontFamily: fonts.body,
      fontSize: t.ui,
      color: colors.text,
      paddingVertical: 8,
      paddingHorizontal: 12,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.lg,
    },
    inputFocused: { borderColor: colors.accent },
    /* A fixed window onto the grid: the dialog is not itself a scroller, so this is the only one. */
    scroll: { maxHeight: 300, minHeight: 120 },
    section: { gap: space.x1, marginBottom: space.x3 },
    sectionTitle: { color: colors.muted },
    grid: { flexDirection: "row", flexWrap: "wrap", gap: 2 },
    cell: {
      width: 40,
      height: 40,
      borderRadius: radii.sm,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: "transparent",
    },
    cellHover: { backgroundColor: colors.rowSelected },
    cellChosen: { borderColor: colors.accent, backgroundColor: colors.accentDim },
    glyph: { fontSize: t.title, lineHeight: 32 },
    empty: { paddingVertical: space.x3 },
    actions: { flexDirection: "row", gap: space.x2, flexWrap: "wrap", marginTop: space.x2 },
    error: { color: colors.crit },
  });
