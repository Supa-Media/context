import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type Role,
} from "react-native";
import { paletteKey, rank, type PaletteItem } from "../../console/files/palette";
import { mergeRanked } from "./paletteMerge";
import { SEE_ALL_ID, seeAllItem } from "./paletteHandoffs";
import { reducedRecallMessage } from "../../console/files/useContextSearch";
import { layout } from "../tokens";
import { useColors, useThemedStyles } from "../theme";
import { Icon } from "./Icon";
import { Text } from "./Text";
import { makeStyles } from "./PaletteStyles";
import { PaletteSheet, type PaletteLookIn } from "./PaletteSheet";
import { usePaletteKeys } from "./usePaletteKeys";

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
 * `KeyboardAvoidingView` in `PaletteSheet` is React Native's own, not the one in
 * `react-native-keyboard-controller` — even though this app mounts that
 * library's `KeyboardProvider` at the root and its version is the nicer of the
 * two. The library's animated views import `react-native-reanimated`, which is
 * a peer dependency `apps/mobile` does not declare, so reaching for it would
 * add a dependency to get a smoother transition on one overlay. The provider
 * stays where it is and the plain avoider is enough: it lifts the sheet's foot,
 * where the field is, by the keyboard's height.
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

import { POINTER_ROW_HEIGHT, PaletteRow, TOUCH_ROW_HEIGHT } from "./PaletteRow";

export { POINTER_ROW_HEIGHT, TOUCH_ROW_HEIGHT, highlightRuns, secondLine } from "./PaletteRow";

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


/* -------------------------------------------------------------------------- */
/*                                    props                                   */
/* -------------------------------------------------------------------------- */

/**
 * Answers from asking the whole context, for a palette whose own `items` are
 * only what the browser has already loaded.
 *
 * Kept beside the local matches rather than merged into them, because the two
 * are ranked by different things and neither ranking survives the other: local
 * matches are fuzzy over a note's *name* and are instant, and these are ranked
 * by what is written *inside* the notes and arrive a moment later. Re-ranking
 * a content hit by how well its filename fuzzes against the query is how "the
 * note that actually says this" ends up below "the note whose title has the
 * right letters in it".
 */
export interface PaletteSearch {
  /**
   * Called as the query changes. Debouncing belongs to the caller, which is
   * the side that knows what a round trip costs.
   */
  onQuery: (query: string) => void;
  /** Hits, already ranked by the search itself. */
  items: PaletteItem[];
  /**
   * `indexing` is not `empty`: a context whose index is still being built has
   * nothing to say yet, and saying "no matches" for it is telling somebody
   * their note does not exist.
   */
  state: "idle" | "searching" | "ready" | "indexing" | "failed";
  /** Rendered above the search results, e.g. "In your notes". */
  heading?: string;
  /**
   * The caller's own visible notes that hold more messages than the search
   * index can keep in full, or absent/`[]` for none.
   *
   * Drawn as a fixed banner rather than folded into `state`: unlike
   * `indexing`, this does not resolve by searching again, so it stays true
   * beside a screen full of real hits exactly as it does beside none. See
   * `reducedRecallMessage` in `features/console/files/useContextSearch.ts`,
   * which is also where the rendered wording lives — the same sentence an
   * AI client reads off this field, never a fourth version of it.
   */
  reducedRecallNotes?: readonly string[];
  /**
   * A sentence about where the answer came from, drawn in the same fixed
   * place as the shed-note caveat — e.g. "Searched the copy on this device.
   * Only 340 of 1,204 notes are on this device yet." (`deviceSearchNotice` in
   * `features/offline/mirrorCopy.ts`). Fixed above the list for the same
   * reason: it qualifies every row, so it must be on screen with the first.
   */
  notice?: string | null;
  /**
   * What an answered search with no rows says, when the caller's own
   * `noMatchMessage` would be wrong for it — a search of the device's copy
   * that found nothing must not tell somebody to "keep typing to search the
   * rest of this context".
   */
  emptyMessage?: string;
  /**
   * The search's answer is the ranking: once it has answered, its rows are
   * drawn in its own order with the loaded name matches folded in
   * (`mergeRanked`), rather than under them. ⌘K's search of every workspace.
   */
  ranked?: boolean;
  /** What the strip says while the search runs, where "the rest of this workspace" is wrong. */
  searchingText?: string;
}

export interface PaletteProps {
  items: PaletteItem[];
  placeholder: string;
  /** Rendered above the list when the query is empty (e.g. "Recent"). */
  emptyHeading?: string;
  /**
   * What an untyped palette lists instead of `items`: the notes somebody was
   * just in (`recentItems`). Absent or empty, it lists `items` as it always
   * did — a picker ("Move to…") has no recents, and a first visit has none yet.
   */
  recent?: PaletteItem[];
  /** Shown when the query matches nothing. Must say what to do next. */
  noMatchMessage?: string;
  /**
   * Optional whole-context search. Absent, the palette filters `items` and
   * nothing else — which is what "Move to…" and the quick switcher want.
   */
  search?: PaletteSearch;
  /**
   * Hand the query to a page that can show all of it.
   *
   * Absent for every palette that is a *navigator* — "Move to…" and the quick
   * switcher are pickers over a list that is already complete, and there is no
   * "all of it" to see. Present for the console's search, where ten rows is a
   * deliberate cut of something longer.
   *
   * It is a row at the bottom of the same list the arrows walk, rather than a
   * button in the chrome, and that is the whole design: Enter still opens the
   * highlighted result, because that is what Enter has always done here and
   * breaking it to reach a new page would be a worse trade than the page is
   * worth. Walk to the last row — or press it — and Enter opens the page. With
   * nothing matching, it is the only row there is, so Enter reaches it in one
   * keystroke exactly when the overlay has failed to answer.
   */
  onSeeAll?: (query: string) => void;
  onChoose: (item: PaletteItem) => void;
  onDismiss: () => void;
  /** Under the field: what the search is narrowed to, and the way to widen it. */
  scopeBar?: ReactNode;
  /** Beside the field on a pointer layout, above the scope bar on a phone: ⌘K's timing pill. */
  fieldAccessory?: ReactNode;
  /** A phone's Look in chips and folder and tag results; ignored on a pointer layout. */
  lookIn?: PaletteLookIn;
}

export { SEE_ALL_ID, seeAllItem } from "./paletteHandoffs";

/* -------------------------------------------------------------------------- */
/*                                  palette                                   */
/* -------------------------------------------------------------------------- */

export function Palette({
  items,
  placeholder,
  emptyHeading,
  recent,
  noMatchMessage,
  search,
  onSeeAll,
  onChoose,
  onDismiss,
  scopeBar,
  fieldAccessory,
  lookIn,
}: PaletteProps) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const { width, height } = useWindowDimensions();

  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [look, setLook] = useState("all");
  const input = useRef<TextInput | null>(null);

  /**
   * Native is always the sheet; the browser decides on width. A desktop
   * browser window dragged narrow gets the sheet too, which is right: the
   * constraint is the room, not the input device.
   */
  const touch = Platform.OS !== "web" || width < layout.narrowBreakpoint;
  const rowHeight = touch ? TOUCH_ROW_HEIGHT : POINTER_ROW_HEIGHT;

  const untyped = query.trim() === "" && recent !== undefined && recent.length > 0;
  const ranked = useMemo(
    () => (untyped ? recent.map((item) => ({ item, score: 0, ranges: [] })) : rank(query, items)),
    [untyped, recent, query, items],
  );

  /**
   * A note that both halves found is one row, in the half that can bold its
   * title — and it carries the body search's snippet, which is the reason it
   * matched when the letters of its title were not.
   */
  const local = useMemo(() => {
    const snippets = new Map(
      (search?.items ?? []).flatMap((item) =>
        item.snippet ? [[`${item.kind}:${item.id}`, item.snippet] as const] : [],
      ),
    );
    if (snippets.size === 0) return ranked;
    return ranked.map((match) => {
      const snippet = snippets.get(`${match.item.kind}:${match.item.id}`);
      return snippet === undefined ? match : { ...match, item: { ...match.item, snippet } };
    });
  }, [ranked, search]);

  /**
   * Search results the local list does not already carry. A note that is both
   * loaded and a content hit appears once, in the half that can highlight
   * which letters of its name matched.
   */
  const remote = useMemo(() => {
    if (!search) return [];
    const already = new Set(local.map((match) => `${match.item.kind}:${match.item.id}`));
    return search.items
      .filter((item) => !already.has(`${item.kind}:${item.id}`))
      // `ranges: []` rather than a guess: these matched on what is inside the
      // note, so there is nothing in the label to bold, and inventing a run
      // would point at the wrong reason this row is here.
      .map((item) => ({ item, score: 0, ranges: [] as readonly [number, number][] }));
  }, [search, local]);

  /**
   * Rows that are answers, as opposed to rows that are a way out of here.
   *
   * `matches` is what the keyboard walks and it includes the handoff; this is
   * what the *copy* is about. Keeping them separate is what lets the handoff
   * be a real row in the list without it counting as having found something.
   */
  const answeredInOrder =
    search?.ranked === true && (search.state === "ready" || search.state === "indexing");
  const merged = useMemo(
    () => (answeredInOrder && search !== undefined ? mergeRanked(ranked, search.items) : null),
    [answeredInOrder, ranked, search],
  );
  const found = merged === null ? local.length + remote.length : merged.length;

  /**
   * One list for the arrows and for Enter, so a keyboard walks into the search
   * results rather than stopping at the last loaded note, with the handoff as
   * its last row.
   *
   * The row is appended here rather than rendered after the list so that
   * `selected`, the wrap-around in `move`, and the scroll arithmetic all see
   * it. Anything else makes it a row the mouse can press and the keyboard
   * cannot reach.
   */
  const handoff = useMemo(
    () => seeAllItem(query, onSeeAll !== undefined),
    [query, onSeeAll],
  );
  const matches = useMemo(() => {
    const rows = merged ?? [...local, ...remote];
    // The handoff is last, so it is never what Enter reaches by accident.
    if (handoff === null) return rows;
    return [...rows, { item: handoff, score: 0, ranges: [] as readonly [number, number][] }];
  }, [merged, local, remote, handoff]);

  const onSearchQuery = search?.onQuery;
  useEffect(() => {
    if (!onSearchQuery) return;
    onSearchQuery(query);
  }, [onSearchQuery, query]);

  /**
   * The highlight is always on a row that exists. `cursor` is intent — where
   * the arrows have walked to — and the clamp is what stops a shrinking list
   * from leaving Enter pointing at nothing.
   */
  const selected = matches.length === 0 ? -1 : Math.min(cursor, matches.length - 1);

  /**
   * Open what is highlighted.
   *
   * The handoff row is intercepted here rather than in `onChoose`, so a caller
   * never has to know this row exists — a palette that leaked a synthetic item
   * id into `onChoose` would have every caller writing the same guard, and the
   * one that forgot would try to open a note called `\u0000see-all`.
   */
  const choose = useCallback(() => {
    const match = matches[selected];
    if (match === undefined) return;
    if (match.item.id === SEE_ALL_ID) onSeeAll?.(query);
    else onChoose(match.item);
  }, [matches, selected, onChoose, onSeeAll, query]);

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

  usePaletteKeys({ move, choose, onDismiss });

  /* -------------------------------- pieces ------------------------------- */

  const onListLayout = (event: LayoutChangeEvent) => {
    viewport.current = event.nativeEvent.layout.height;
  };
  const onListScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    offset.current = event.nativeEvent.contentOffset.y;
  };

  const field = (
    <TextInput
      ref={input}
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

  /**
   * What an empty list says, and it is never "no matches" while there is still
   * a reason to think otherwise. A search that is running has not answered
   * yet; one whose index is still being built cannot answer yet; one that
   * failed knows nothing either way. Reporting absence in any of those three
   * is the bug this whole feature exists to remove — the palette used to say
   * "only folders you have opened are searched", which was at least honest,
   * and "nothing matches" would be worse than what it replaced.
   */
  const emptyText = (() => {
    if (search?.state === "searching") return search.searchingText ?? "Searching the rest of this workspace…";
    if (search?.state === "indexing") {
      return "This workspace is still being indexed. Try again in a moment.";
    }
    if (search?.state === "failed") {
      return "That search could not be run. Only loaded folders were filtered.";
    }
    if (search?.state === "ready" && search.emptyMessage) return search.emptyMessage;
    return noMatchMessage ?? "Nothing matches. Try fewer letters.";
  })();

  /** The label above the search half, when there is a search half. */
  const searchNote = merged === null && remote.length > 0 ? (search?.heading ?? "In your notes") : null;

  /**
   * The shed-note caveat, fixed above the list rather than inside it.
   *
   * Placed here rather than folded into `emptyText` or the "still searching"
   * strip below the rows: both of those are inside the `ScrollView` and a
   * palette that actually found something can push either one out of sight,
   * which is exactly backwards for a person who typed a word and got back
   * fewer or emptier results than they expected. This sits between the input
   * and the list on both presentations, so it is on screen with the very
   * first row rather than a scroll away from it.
   */
  const reducedRecallText = reducedRecallMessage(search?.reducedRecallNotes ?? []);
  const reducedRecallNotice = reducedRecallText ? (
    <View style={styles.notice} testID="palette-reduced-recall">
      <Text variant="rowSub">{reducedRecallText}</Text>
    </View>
  ) : null;
  /* Where the answer came from — the device's copy — in the same fixed place. */
  const sourceNotice = search?.notice ? (
    <View style={styles.notice} testID="palette-search-notice">
      <Text variant="rowSub">{search.notice}</Text>
    </View>
  ) : null;

  // A phone's Look in chips and folder and tag rows (`PaletteLookIn`); `notes` false hides the note rows.
  // A chip keeps the caret in the field, so typing carries on after picking one.
  const lookAt = (next: string) => {
    setLook(next);
    input.current?.focus();
  };
  const looked = touch && lookIn ? lookIn.render({ query, found, look, setLook: lookAt }) : null;
  const notes = looked?.notes !== false;

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
      {/*
        The explanation belongs to the *found* rows being empty, not to the
        list being empty, and those stopped being the same thing when the
        handoff row joined `matches`. A palette with `onSeeAll` always has at
        least that row once something is typed, so gating on `matches.length`
        silently retired three states this component exists to keep honest:
        "still being indexed", "could not be run", and the caller's own
        `noMatchMessage`. The one palette that has a handoff is the console's,
        which is the one those states were written for.
      */}
      {looked?.places}
      {notes && found === 0 ? (
        <View style={styles.empty} testID="palette-empty">
          <Text variant="rowSub">{emptyText}</Text>
        </View>
      ) : null}
      {(notes ? matches : []).map((match, index) => (
        <Fragment key={paletteKey(match.item)}>
          {/*
            The divider between what was already loaded and what searching the
            whole context found. Rendered at the boundary rather than as a
            wrapper, so the flat `matches` list the keyboard walks stays flat.
          */}
          {index === local.length && searchNote !== null ? (
            <Text variant="eyebrow" style={styles.heading} testID="palette-search-heading">
              {searchNote}
            </Text>
          ) : null}
          <PaletteRow
            match={match}
            selected={index === selected}
            touch={touch}
            onPress={() => {
              setCursor(index);
              if (match.item.id === SEE_ALL_ID) onSeeAll?.(query);
              else onChoose(match.item);
            }}
            testID={`palette-row-${index}`}
          />
        </Fragment>
      ))}
      {/*
        Still working, with rows already on screen. Below the list because the
        rows above are real answers and must not move when this appears. Gated
        on found rows for the same reason as the block above: with none, the
        empty text already says it, and both would say it twice.
      */}
      {found > 0 && search?.state === "searching" ? (
        <View style={styles.empty} testID="palette-searching">
          <Text variant="rowSub">{search.searchingText ?? "Searching the rest of this workspace…"}</Text>
        </View>
      ) : null}
    </ScrollView>
  );

  const heading =
    emptyHeading && notes && query.trim() === "" && matches.length > 0 ? (
      <Text variant="eyebrow" style={styles.heading} testID="palette-heading">
        {emptyHeading}
      </Text>
    ) : null;


  /* ------------------------------ the sheet ------------------------------ */

  if (touch) {
    return (
      <PaletteSheet field={field} onDismiss={onDismiss}>
        {fieldAccessory}
        {scopeBar}
        {looked?.chips}
        {heading}
        {sourceNotice}
        {reducedRecallNotice}
        {list}
      </PaletteSheet>
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
            {fieldAccessory}
          </View>
          {scopeBar}
          {heading}
          {sourceNotice}
          {reducedRecallNotice}
          {list}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
