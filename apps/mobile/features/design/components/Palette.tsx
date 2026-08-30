import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type Role,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { rank, type Match, type PaletteItem } from "../../console/files/palette";
import { resolve } from "../keymap";
import { colors, fonts, layout, radii, space } from "../tokens";
import { Button } from "./Button";
import { Icon } from "./Icon";
import { Text } from "./Text";

/**
 * One filterable, keyboard-driven list, behind every surface that needs one.
 *
 * `features/console/files/palette.ts` is the settled model: it turns a query
 * and an array of `PaletteItem` into ranked `Match`es. This file is its only
 * presentation, and it is deliberately the *only* one, because the console
 * needs the same widget three times:
 *
 *  - the **⌘K command palette**;
 *  - the **⌘O quick switcher** over loaded note paths;
 *  - **"Move to…"**, which replaces the scrolling `MovePicker` — a list you
 *    cannot read at thirty folders and cannot use at three hundred.
 *
 * They differ in where the items come from and what the placeholder says.
 * Nothing else about them differs, so nothing else about them is a prop.
 *
 * ## Two presentations, one row
 *
 * Web and touch are equal targets here, not one degraded into the other, and
 * they genuinely want different chrome:
 *
 *  - **Pointer** — a panel that hangs near the top third of the window. Not
 *    vertically centred: a centred box moves its own first row every time the
 *    result count changes, so the thing your eye is already on slides out from
 *    under it between keystrokes. Anchored at the top, the list grows downward
 *    and the first result never moves.
 *  - **Touch** — full screen, input at the *top* with Cancel beside it. A
 *    phone has no room for a floating panel, and the software keyboard eats
 *    the bottom half of the viewport: a centred panel would be behind it, and
 *    an input at the bottom would be pushed off the top of its own sheet.
 *
 * What must **not** differ is the row, because the row is where the ranking
 * becomes visible. So there is exactly one `PaletteRow`, used by both, taking
 * a `touch` flag that changes its density and nothing else. Two row components
 * would drift, and the drift would be silent — a highlight that stopped
 * rendering on one platform looks like a design choice.
 *
 * ## The highlight is the point
 *
 * `Match.ranges` exists so the list can show *why* a row matched. `tfm`
 * finding `together-financial-management.md` is only obviously correct when
 * the three initials are lit up; without that it looks like a guess. So the
 * matched runs are drawn in `colors.text` at semibold against `colors.text2`
 * for everything else, and dropping that would quietly turn a legible ranking
 * into an arbitrary one.
 *
 * ## Row height is a constant, not a measurement
 *
 * Keeping the selected row on screen means scrolling to it, and scrolling to
 * it means knowing where it is. Measuring each row with `onLayout` gives an
 * answer one frame late — which is exactly one keystroke late — so a held
 * arrow key drifts away from the highlight. Fixed heights, declared here and
 * applied to the row style, mean position is arithmetic. That is also why the
 * touch row is a flat 56pt whether or not it has a detail line: a list whose
 * rows are different heights cannot be scrolled by index.
 *
 * ## The software keyboard
 *
 * `KeyboardAvoidingView` here is React Native's own, not the one in
 * `react-native-keyboard-controller` — even though this app mounts that
 * library's `KeyboardProvider` at the root and its version is the nicer of the
 * two. The library's animated views import `react-native-reanimated`, which is
 * a peer dependency `apps/mobile` does not declare, so reaching for it would
 * add a dependency to get a smoother transition on one overlay. The provider
 * stays where it is and the plain avoider is enough: with the field at the top
 * of the sheet, all the keyboard can cover is the tail of the results.
 *
 * ## Keyboard shortcuts
 *
 * Key handling goes through `keymap.resolve` in the `"overlay"` scope rather
 * than a local `switch`. That scope is what makes an overlay's bare keys fire
 * even though the caret is in a text field, and — more importantly — what
 * stops everything *behind* the palette from firing at all. Re-implementing
 * the decision here would be a second copy of a rule that already exists, and
 * the copy would be the one that forgets ⌘N must be inert over a modal.
 */

/* -------------------------------------------------------------------------- */
/*                                  measures                                  */
/* -------------------------------------------------------------------------- */

/** A pointer row: one line, detail right-aligned. */
export const POINTER_ROW_HEIGHT = 38;

/**
 * A touch row: label over detail, and never below the 44pt minimum target.
 * 56 rather than exactly 44 because this list is scrolled with the same thumb
 * that taps it, and 44 back-to-back rows are 44 chances to open the wrong note.
 */
export const TOUCH_ROW_HEIGHT = 56;

/** Roughly nine rows before the pointer panel starts scrolling. */
const POINTER_LIST_MAX_HEIGHT = POINTER_ROW_HEIGHT * 9;

/** The panel hangs from here, clamped so it neither hugs the chrome nor sinks. */
const PANEL_TOP_FRACTION = 0.14;
const PANEL_TOP_MIN = 56;
const PANEL_TOP_MAX = 180;

/**
 * `listbox` is missing from React Native's `Role` union, which is a gap in the
 * types rather than in the platforms: RN-Web forwards `role` to the DOM
 * untouched, and the native bridge passes roles it does not special-case
 * through as-is. `option` — which *is* in the union, and is what each row
 * carries — only means anything inside a `listbox`, so the pair has to be
 * spelled out even though only half of it typechecks.
 */
const LISTBOX_ROLE = "listbox" as unknown as Role;

/** `kind` as one character. Cheaper than an icon set and legible at 10px. */
const GLYPHS: Readonly<Record<PaletteItem["kind"], string>> = {
  note: "▢",
  folder: "▸",
  command: "⌘",
};

/* -------------------------------------------------------------------------- */
/*                                    props                                   */
/* -------------------------------------------------------------------------- */

export interface PaletteProps {
  items: PaletteItem[];
  placeholder: string;
  /** Rendered above the list when the query is empty (e.g. "Recent"). */
  emptyHeading?: string;
  /**
   * What this search actually covers, shown above the results in every state.
   *
   * Not a heading and not an empty state: a palette that only admits its reach
   * when it finds nothing is a palette that lies whenever it finds something.
   * Four results out of six hundred notes look like a complete answer.
   */
  scopeNote?: string;
  /** Shown when the query matches nothing. Must say what to do next. */
  noMatchMessage?: string;
  onChoose: (item: PaletteItem) => void;
  onDismiss: () => void;
}

/* -------------------------------------------------------------------------- */
/*                                  platform                                  */
/* -------------------------------------------------------------------------- */

/**
 * Whether `mod` means ⌘.
 *
 * Only consulted for chords that carry a modifier, and the overlay scope has
 * none — but `resolve` takes the flag, and handing it a guess that is wrong on
 * half the machines is how a modifier rule stops being exact.
 */
function onApplePlatform(): boolean {
  if (Platform.OS === "ios" || Platform.OS === "macos") return true;
  if (Platform.OS !== "web" || typeof navigator === "undefined") return false;
  const platform = navigator.platform || navigator.userAgent || "";
  return /Mac|iPhone|iPad|iPod/.test(platform);
}

/* -------------------------------------------------------------------------- */
/*                                    rows                                    */
/* -------------------------------------------------------------------------- */

interface Run {
  text: string;
  matched: boolean;
}

/**
 * `label` cut into matched and unmatched runs.
 *
 * `ranges` are half-open `[start, end)` slices of `label`, ascending and
 * non-overlapping — that is the contract `fuzzyMatch` documents — so this is a
 * single pass with a cursor. Anything left after the last range is the tail,
 * and an empty `ranges` (the untyped palette) yields the whole label unmatched.
 */
export function highlightRuns(
  label: string,
  ranges: readonly (readonly [number, number])[],
): Run[] {
  const runs: Run[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) runs.push({ text: label.slice(cursor, start), matched: false });
    if (end > start) runs.push({ text: label.slice(start, end), matched: true });
    cursor = Math.max(cursor, end);
  }
  if (cursor < label.length) runs.push({ text: label.slice(cursor), matched: false });
  return runs;
}

/**
 * The one row both presentations draw.
 *
 * The matched runs are their own `Text` nodes because that is the only way to
 * give a slice of a string its own weight in React Native — there is no
 * `<mark>` and no rich-text primitive. Unmatched runs stay bare strings so
 * they inherit the parent's size and colour and cannot fall out of step with it.
 */
function PaletteRow({
  match,
  selected,
  touch,
  onPress,
  testID,
}: {
  match: Match;
  selected: boolean;
  touch: boolean;
  onPress: () => void;
  testID: string;
}) {
  const [hovered, setHovered] = useState(false);
  const runs = highlightRuns(match.item.label, match.ranges);

  return (
    <Pressable
      role="option"
      aria-selected={selected}
      accessibilityLabel={
        match.item.detail ? `${match.item.label}, ${match.item.detail}` : match.item.label
      }
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      testID={testID}
      style={[
        styles.row,
        touch ? styles.rowTouch : styles.rowPointer,
        hovered && !selected && styles.rowHover,
        selected && styles.rowSelected,
      ]}
    >
      <Text variant="treeMeta" style={styles.glyph} aria-hidden>
        {GLYPHS[match.item.kind]}
      </Text>

      <View style={styles.rowText}>
        <Text variant="tree" numberOfLines={1} style={styles.label}>
          {runs.map((run, index) =>
            run.matched ? (
              <Text
                key={`${index}-${run.text}`}
                variant="tree"
                style={styles.mark}
                testID="palette-mark"
              >
                {run.text}
              </Text>
            ) : (
              run.text
            ),
          )}
        </Text>

        {/* Under the label where there is a whole screen, beside it where a
            pointer means the row can afford to be one line tall. */}
        {match.item.detail && touch ? (
          <Text variant="treeMeta" numberOfLines={1} style={styles.detailUnder}>
            {match.item.detail}
          </Text>
        ) : null}
      </View>

      {match.item.detail && !touch ? (
        <Text variant="treeMeta" numberOfLines={1} style={styles.detailBeside}>
          {match.item.detail}
        </Text>
      ) : null}
    </Pressable>
  );
}

/* -------------------------------------------------------------------------- */
/*                                  palette                                   */
/* -------------------------------------------------------------------------- */

export function Palette({
  items,
  placeholder,
  scopeNote,
  emptyHeading,
  noMatchMessage,
  onChoose,
  onDismiss,
}: PaletteProps) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);

  /**
   * Native is always the sheet; the browser decides on width. A desktop
   * browser window dragged narrow gets the sheet too, which is right: the
   * constraint is the room, not the input device.
   */
  const touch = Platform.OS !== "web" || width < layout.narrowBreakpoint;
  const rowHeight = touch ? TOUCH_ROW_HEIGHT : POINTER_ROW_HEIGHT;

  const matches = useMemo(() => rank(query, items), [query, items]);

  /**
   * The highlight is always on a row that exists. `cursor` is intent — where
   * the arrows have walked to — and the clamp is what stops a shrinking list
   * from leaving Enter pointing at nothing.
   */
  const selected = matches.length === 0 ? -1 : Math.min(cursor, matches.length - 1);

  const choose = useCallback(() => {
    const match = matches[selected];
    if (match !== undefined) onChoose(match.item);
  }, [matches, selected, onChoose]);

  /**
   * Wraps, in both directions. The alternative — stopping dead at the ends —
   * makes "go to the last row" a hold rather than a keystroke, and there is no
   * ambiguity to protect: this list is bounded and entirely on one axis.
   */
  const move = useCallback(
    (delta: number) => {
      setCursor((current) => {
        if (matches.length === 0) return 0;
        const from = Math.min(current, matches.length - 1);
        return (from + delta + matches.length) % matches.length;
      });
    },
    [matches.length],
  );

  /* ------------------------------ scrolling ------------------------------ */

  const scroller = useRef<ScrollView | null>(null);
  const viewport = useRef(0);
  const offset = useRef(0);

  useEffect(() => {
    if (selected < 0 || viewport.current <= 0) return;
    const top = selected * rowHeight;
    const bottom = top + rowHeight;
    const at = offset.current;

    // Scroll the minimum that puts the row inside the window, so walking down
    // a long list creeps rather than jumping the highlight to the middle.
    let next = at;
    if (top < at) next = top;
    else if (bottom > at + viewport.current) next = bottom - viewport.current;
    if (next === at) return;

    offset.current = next;
    scroller.current?.scrollTo({ y: next, animated: false });
  }, [selected, rowHeight]);

  /* ------------------------------- keyboard ------------------------------ */

  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    const apple = onApplePlatform();

    const onKeyDown = (event: KeyboardEvent) => {
      const command = resolve(
        {
          key: event.key,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          // True by construction: the palette's filter has focus. Said out
          // loud rather than hard-coded `false`, because the whole reason the
          // overlay scope exists is that it ignores this flag — and a `false`
          // here would make that look like it was never tested.
          inTextField: true,
        },
        "overlay",
        apple,
      );
      if (command === null) return;

      switch (command) {
        case "treeUp":
          move(-1);
          break;
        case "treeDown":
          move(1);
          break;
        case "treeOpen":
          choose();
          break;
        case "dismiss":
          onDismiss();
          break;
        default:
          // Unreachable: the overlay scope resolves to nothing else. Left in
          // so that adding an overlay binding fails visibly here rather than
          // silently swallowing the keystroke below.
          return;
      }

      // The arrows would otherwise walk the caret through the query, and Enter
      // would submit whatever form a host page happens to have wrapped us in.
      event.preventDefault();
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [move, choose, onDismiss]);

  /* -------------------------------- pieces ------------------------------- */

  const onListLayout = (event: LayoutChangeEvent) => {
    viewport.current = event.nativeEvent.layout.height;
  };
  const onListScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    offset.current = event.nativeEvent.contentOffset.y;
  };

  const field = (
    <TextInput
      value={query}
      onChangeText={(next) => {
        setQuery(next);
        // A new query is a new list; the highlight belongs on its top row.
        setCursor(0);
      }}
      onSubmitEditing={choose}
      autoFocus
      autoCorrect={false}
      autoCapitalize="none"
      returnKeyType="go"
      placeholder={placeholder}
      placeholderTextColor={colors.muted}
      accessibilityLabel={placeholder}
      testID="palette-input"
      style={[styles.input, touch ? styles.inputTouch : styles.inputPointer]}
    />
  );

  const list = (
    <ScrollView
      ref={scroller}
      role={LISTBOX_ROLE}
      aria-label={placeholder}
      testID="palette-list"
      keyboardShouldPersistTaps="handled"
      onLayout={onListLayout}
      onScroll={onListScroll}
      scrollEventThrottle={16}
      style={touch ? styles.listTouch : styles.listPointer}
      contentContainerStyle={styles.listContent}
    >
      {matches.length === 0 ? (
        <View style={styles.empty} testID="palette-empty">
          <Text variant="rowSub">
            {noMatchMessage ?? "Nothing matches. Try fewer letters."}
          </Text>
        </View>
      ) : (
        matches.map((match, index) => (
          <PaletteRow
            key={`${match.item.kind}:${match.item.id}`}
            match={match}
            selected={index === selected}
            touch={touch}
            onPress={() => {
              setCursor(index);
              onChoose(match.item);
            }}
            testID={`palette-row-${index}`}
          />
        ))
      )}
    </ScrollView>
  );

  const heading =
    emptyHeading && query.trim() === "" && matches.length > 0 ? (
      <Text variant="eyebrow" style={styles.heading} testID="palette-heading">
        {emptyHeading}
      </Text>
    ) : null;

  /*
    Between the field and the list, and unconditional. Above the results rather
    than under them because it qualifies what is about to be read, and a caveat
    read after the conclusion has already been drawn is not a caveat.
  */
  const scope =
    scopeNote === undefined ? null : (
      <Text variant="treeMeta" style={styles.scope} testID="palette-scope">
        {scopeNote}
      </Text>
    );

  /* ------------------------------ the sheet ------------------------------ */

  if (touch) {
    return (
      <Modal transparent animationType="slide" visible onRequestClose={onDismiss}>
        <KeyboardAvoidingView
          /**
           * The input is at the top, so the keyboard never covers it — what it
           * covers is the bottom of the results. `padding` on iOS shortens the
           * sheet by the keyboard's height so the last rows stay reachable;
           * Android resizes the window itself, and `height` is the behaviour
           * that cooperates with that rather than fighting it.
           */
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={[
            styles.sheet,
            { paddingTop: insets.top, paddingBottom: insets.bottom },
          ]}
          testID="palette-sheet"
        >
          <View style={styles.sheetHeader}>
            {field}
            <Button
              label="Cancel"
              onPress={onDismiss}
              testID="palette-cancel"
              style={styles.cancel}
            />
          </View>
          {scope}
          {heading}
          {list}
        </KeyboardAvoidingView>
      </Modal>
    );
  }

  /* ------------------------------ the panel ------------------------------ */

  const top = Math.min(
    PANEL_TOP_MAX,
    Math.max(PANEL_TOP_MIN, Math.round(height * PANEL_TOP_FRACTION)),
  );

  return (
    <Modal transparent animationType="fade" visible onRequestClose={onDismiss}>
      <Pressable
        style={[styles.scrim, { paddingTop: top }]}
        accessibilityLabel="Close"
        onPress={onDismiss}
        testID="palette-scrim"
      >
        {/* Swallow presses inside the panel, so only the scrim dismisses. */}
        <Pressable
          style={styles.panel}
          onPress={() => {}}
          accessibilityLabel={placeholder}
          testID="palette-panel"
        >
          <View style={styles.panelHeader}>
            <Icon name="search" size={16} color={colors.muted} />
            {field}
          </View>
          {scope}
          {heading}
          {list}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */

const styles = StyleSheet.create({
  /* ------------------------------- pointer ------------------------------- */

  scrim: {
    flex: 1,
    backgroundColor: "rgba(3,3,4,.72)",
    alignItems: "center",
    paddingHorizontal: space.x6,
  },
  panel: {
    width: "100%",
    maxWidth: 560,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radii.card,
    backgroundColor: colors.surface3,
    overflow: "hidden",
    boxShadow: "0 40px 100px -30px rgba(0,0,0,1)",
  },
  panelHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.x2,
    paddingHorizontal: space.x4,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },

  /* -------------------------------- touch -------------------------------- */

  sheet: {
    flex: 1,
    backgroundColor: colors.ground,
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.x2,
    paddingHorizontal: space.x3,
    paddingVertical: space.x2,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    backgroundColor: colors.surface2,
  },
  cancel: { minHeight: 44, justifyContent: "center" },

  /* -------------------------------- input -------------------------------- */

  input: {
    flex: 1,
    fontFamily: fonts.body,
    color: colors.text,
  },
  inputPointer: { fontSize: 15, paddingVertical: 13 },
  /**
   * 17, not 15. RN-Web renders this as a real `<input>`, and mobile Safari
   * zooms the whole page when one under 16px takes focus — a zoom the person
   * then has to pinch their way back out of, on the screen they opened to
   * find one note.
   */
  inputTouch: { fontSize: 17, paddingVertical: 11, paddingHorizontal: space.x2 },

  /* -------------------------------- list --------------------------------- */

  listPointer: { maxHeight: POINTER_LIST_MAX_HEIGHT },
  listTouch: { flex: 1 },
  listContent: { paddingVertical: space.x1 },
  heading: {
    paddingHorizontal: space.x4,
    paddingTop: space.x3,
    paddingBottom: space.x1,
  },
  /** A hairline under it, so the caveat reads as chrome rather than as a row. */
  scope: {
    paddingHorizontal: space.x4,
    paddingVertical: space.x2,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  empty: {
    paddingHorizontal: space.x4,
    paddingVertical: space.x5,
  },

  /* --------------------------------- row --------------------------------- */

  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.x2,
    paddingHorizontal: space.x4,
  },
  rowPointer: { height: POINTER_ROW_HEIGHT },
  rowTouch: { height: TOUCH_ROW_HEIGHT },
  rowHover: { backgroundColor: colors.surface2 },
  rowSelected: { backgroundColor: colors.accentDim },
  rowText: { flex: 1, minWidth: 0 },
  glyph: { width: 14, textAlign: "center" },
  label: { color: colors.text2 },
  /** The whole reason `Match.ranges` is carried out of the ranker. */
  mark: { color: colors.text, fontWeight: "600" },
  detailUnder: { marginTop: 1 },
  detailBeside: { maxWidth: "45%", marginLeft: "auto" },
});
