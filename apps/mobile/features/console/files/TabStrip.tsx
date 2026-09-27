import { useCallback, useEffect, useRef, useState } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ViewProps,
} from "react-native";
import { FocusRing } from "../../design/components/FocusRing";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { pointerType as t, radii } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { Menu } from "../../design/components/Menu";
import { describeBinding, type Command } from "../../design/keymap";
import { isApplePlatform } from "../../design/applePlatform";
import { joinGroups, type MenuItem } from "./menu";
import { tabLabel, type Tab, type TabsState } from "./tabs";

/**
 * What a right-click on a tab offers — **its own id union**, not `MenuActionId`.
 *
 * This is what the `TODO(menu)` that used to sit on `TabMenu` was waiting for,
 * and it is not the fix that TODO proposed. It suggested widening
 * `MenuActionId` to fit three tab verbs; `MenuItem`'s own doc argues the
 * opposite and is right: `Menu` is a *disclosure menu component* generic in its
 * id, and `Explorer`'s dispatcher switches on every member of `MenuActionId`,
 * so a `closeTab` in there is a case that dispatcher must go on not
 * mishandling, forever, for a menu it never draws. The account menu already
 * draws with this same component against a two-item union of its own.
 *
 * So the file menu answers "what can I do with this file?" and this answers
 * "what can I do with this tab?", and neither has to know about the other.
 */
type TabMenuId = "close" | "closeOthers" | "closeToRight" | "reopen";

/**
 * The tab strip: the pointer half of `tabs.ts`.
 *
 * `tabs.ts` owns every rule worth arguing about — what closing the active tab
 * lands on, what a rename does to a draft, what ⌘⇧T brings back — and this file
 * owns none of them. It draws the state and reports gestures. Anything in here
 * that starts deciding *which* tab something happens to belongs in the reducer,
 * where it can be tested one action at a time.
 *
 * **There is no mobile half any more.** `TabSwitcher.tsx` was a count button
 * and a sheet at compact density, and nothing at that density could open a
 * second tab — so the count read `1` for the life of the app and the sheet's ×
 * closed a tab while leaving the note on screen. A phone gets `RecentSheet.tsx`
 * over `history.ts` instead. Tabs are a pointer instrument now, which is what
 * the gap in `menu.ts` had been quietly assuming all along: `openInNewTab` is
 * offered to `platform === "web"` and to nothing else.
 *
 * Three behaviours here are copied from VS Code deliberately, because they are
 * the ones people already have in their hands:
 *
 *  - **A preview tab is italic.** That slant is the whole warning that the next
 *    single click will replace this tab rather than add one. Without it the
 *    preview rule (see `tabs.ts`) is invisible, and invisible means it reads as
 *    a bug — "my tab disappeared" — rather than as the feature that stops you
 *    accumulating forty tabs walking down a folder.
 *  - **A dirty tab shows a dot where its × would be, and swaps to the × on
 *    hover.** The tempting alternative — a dot *beside* the × — moves the close
 *    button sideways the moment a note goes dirty, so the click you aimed at a
 *    close button lands on a note with an unsaved draft in it. The dot occupies
 *    the same box, and the same box closes the tab when you press it.
 *  - **Middle-click closes.** It costs one handler and it is the gesture half of
 *    the people who use tabs reach for first.
 *
 * And one rule that is not a copy of anything: **the strip must never wrap.** A
 * second row of tabs reflows the first one, which moves every tab out from under
 * the pointer that is already on its way to one of them. It scrolls instead, and
 * the active tab is kept in view when it changes so that ⌘1–⌘9 and "close the
 * active tab" cannot leave you looking at a strip that does not contain the note
 * you are editing.
 */

export interface TabStripProps {
  state: TabsState;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
  onCloseOthers: (path: string) => void;
  /** Close everything after this tab, keeping it and everything before it. */
  onCloseToRight: (path: string) => void;
  onReopen: () => void;
  /**
   * The open note's name as its title is being typed — see `linkedTitle.ts`.
   * The tab keeps its path and its place; only what it reads changes.
   */
  relabel?: { path: string; label: string | null } | null;
}

/** Roughly a dozen characters. Long enough to be a name, short enough to fit six. */
const MAX_LABEL_WIDTH = 180;

/** Breathing room left either side of the active tab when it is scrolled in. */
const SCROLL_MARGIN = 24;

/* -------------------------------------------------------------------------- *
 * Mouse buttons two and three.
 * -------------------------------------------------------------------------- */

/**
 * The shape of the DOM event these three handlers get.
 *
 * Declared locally and loosely because it is genuinely a DOM event, not a React
 * Native one: react-native-web forwards `onAuxClick`, `onContextMenu` and
 * `onMouseDown` from a `View` straight through to the element (see its
 * `modules/forwardedProps`), and hands back React's own `MouseEvent`. Every
 * field is optional so a synthetic event in a test — or a native platform that
 * somehow routes one here — cannot throw.
 */
interface WebMouseEvent {
  button?: number;
  pageX?: number;
  pageY?: number;
  preventDefault?: () => void;
}

/**
 * Middle-click and right-click, which React Native has no vocabulary for.
 *
 * React Native's `ViewProps` has no `onAuxClick` or `onContextMenu` — there is
 * no second or third mouse button on a phone — so the object is built and cast
 * in one place rather than spreading `any` through the component. On native the
 * result is empty, which is the honest answer rather than a stub.
 */
function mouseButtonProps(handlers: {
  onMiddleClick: () => void;
  onRightClick: (at: { x: number; y: number }) => void;
}): ViewProps {
  if (Platform.OS !== "web") return {};
  return {
    // Middle-click's *default* is the browser's autoscroll cursor, and it is
    // armed on mousedown — by `auxclick` it is already on screen. Refusing it
    // here is what makes closing a tab with the wheel feel like closing a tab
    // rather than like starting a drag.
    onMouseDown: (event: WebMouseEvent) => {
      if (event.button === 1) event.preventDefault?.();
    },
    onAuxClick: (event: WebMouseEvent) => {
      // `auxclick` is every non-primary button, which on a five-button mouse
      // includes Back and Forward. Only the wheel closes anything.
      if (event.button !== 1) return;
      event.preventDefault?.();
      handlers.onMiddleClick();
    },
    onContextMenu: (event: WebMouseEvent) => {
      event.preventDefault?.();
      handlers.onRightClick({ x: event.pageX ?? 0, y: event.pageY ?? 0 });
    },
  } as unknown as ViewProps;
}

/**
 * The tab menu, as data — the same shape `menu.ts` produces for a file, so the
 * shared `Menu` can draw it.
 *
 * `others` and `toRight` are absent rather than inert when there is nothing for
 * them to close, which is `menu.ts`'s rule and right here for the same reason:
 * "Close others" on the only open tab is not a thing you are temporarily unable
 * to do, it is a thing that does not apply. "Reopen closed" is the documented
 * exception — see `MenuItem.disabled`.
 */
export function tabMenuItems(state: TabsState, path: string): MenuItem<TabMenuId>[] {
  const at = state.tabs.findIndex((tab) => tab.path === path);
  const apple = isApplePlatform();
  return joinGroups<TabMenuId>([
    [
      {
        id: "close",
        label: "Close",
        ...chord("closeTab", apple),
      },
      ...(state.tabs.length > 1 ? [{ id: "closeOthers" as const, label: "Close others" }] : []),
      ...(at !== -1 && at < state.tabs.length - 1
        ? [{ id: "closeToRight" as const, label: "Close to the right" }]
        : []),
    ],
    [
      {
        id: "reopen",
        label: "Reopen closed",
        ...(state.closed.length > 0 ? {} : { disabled: true }),
        ...chord("reopenTab", apple),
      },
    ],
  ]);
}

/**
 * The chord, or nothing — never a literal.
 *
 * `keymap.ts` is the one place that knows what is bound, and a menu that prints
 * a keystroke nothing binds is worse than one that prints none. Same rule
 * `menu.ts`'s `COMMANDS` table follows, and the same reason.
 */
function chord(command: Command, apple: boolean): { shortcut?: string } {
  const printed = describeBinding(command, apple);
  return printed === null ? {} : { shortcut: printed };
}

/* -------------------------------------------------------------------------- */

interface MenuAt {
  path: string;
  x: number;
  y: number;
}

export function TabStrip({
  state,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseToRight,
  onReopen,
  relabel,
}: TabStripProps) {
  const styles = useThemedStyles(makeStyles);
  const [menu, setMenu] = useState<MenuAt | null>(null);

  const scroller = useRef<ScrollView | null>(null);
  /** Where each tab sits along the track, filled in by `onLayout`. */
  const boxes = useRef(new Map<string, { x: number; width: number }>());
  /** The visible window: how wide the strip is, and how far it is scrolled. */
  const viewport = useRef({ width: 0, offset: 0 });

  const { activePath } = state;

  /**
   * Keep the active tab on screen.
   *
   * Deliberately a *minimum* scroll — nudge the near edge into view and stop —
   * rather than centring, because centring moves the whole strip on every
   * activation and the tabs either side of the one you clicked are the ones you
   * are most likely to click next.
   *
   * Every measurement comes from `onLayout`, which is driven by a
   * `ResizeObserver`. There isn't one in jsdom, so under test nothing is ever
   * measured, `viewport.width` stays 0, and this returns before it can ask a
   * scroll view with no dimensions to scroll somewhere.
   */
  useEffect(() => {
    if (activePath === null) return;
    const box = boxes.current.get(activePath);
    const { width, offset } = viewport.current;
    if (box === undefined || width === 0) return;

    if (box.x < offset) {
      scroller.current?.scrollTo({ x: Math.max(0, box.x - SCROLL_MARGIN), animated: true });
    } else if (box.x + box.width > offset + width) {
      scroller.current?.scrollTo({
        x: box.x + box.width - width + SCROLL_MARGIN,
        animated: true,
      });
    }
  }, [activePath, state.tabs.length]);

  const closeMenu = useCallback(() => setMenu(null), []);

  if (state.tabs.length === 0) return null;

  return (
    <View style={styles.strip} testID="tab-strip">
      <ScrollView
        ref={scroller}
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.scroller}
        contentContainerStyle={styles.scrollerContent}
        testID="tab-strip-scroller"
        onLayout={(event: LayoutChangeEvent) => {
          viewport.current.width = event.nativeEvent.layout.width;
        }}
        onScroll={(event: NativeSyntheticEvent<NativeScrollEvent>) => {
          viewport.current.offset = event.nativeEvent.contentOffset.x;
        }}
        scrollEventThrottle={16}
      >
        {/*
          The row lives in a child of the content container rather than in
          `contentContainerStyle` so that "this element must not wrap" is a
          question a test can ask of one node it can find by name. `nowrap` is
          also written out rather than left to the CSS initial value, because
          the failure it prevents — a strip that reflows under the pointer — is
          invisible in source and obvious only on the day somebody opens a
          seventh tab.
        */}
        <View style={styles.track} testID="tab-strip-track" role="tablist">
          {state.tabs.map((tab) => (
            <TabItem
              key={tab.path}
              tab={tab}
              label={
                relabel?.path === tab.path && relabel.label !== null
                  ? relabel.label
                  : tabLabel(state, tab.path)
              }
              active={tab.path === state.activePath}
              onActivate={() => onActivate(tab.path)}
              onClose={() => onClose(tab.path)}
              onMenu={(at) => setMenu({ path: tab.path, x: at.x, y: at.y })}
              onMeasure={(box) => boxes.current.set(tab.path, box)}
            />
          ))}
        </View>
      </ScrollView>

      {menu === null ? null : (
        <Menu<TabMenuId>
          items={tabMenuItems(state, menu.path)}
          anchor={{ x: menu.x, y: menu.y }}
          title={tabLabel(state, menu.path)}
          onSelect={(id) => {
            const path = menu.path;
            closeMenu();
            // The tab that was *clicked*, never the active one. Right-clicking
            // an inactive tab and closing the one you were reading is the bug
            // this argument exists to prevent.
            if (id === "close") onClose(path);
            else if (id === "closeOthers") onCloseOthers(path);
            else if (id === "closeToRight") onCloseToRight(path);
            else onReopen();
          }}
          onDismiss={closeMenu}
        />
      )}
    </View>
  );
}

/**
 * One tab: a press target that opens the note, and a second, *sibling* press
 * target that closes it.
 *
 * Sibling rather than nested, and that is the whole design of this component.
 * The obvious arrangement — a close button inside the pressable that opens the
 * note — is how a tab strip ends up switching to a background tab on the way to
 * closing it, throwing away the place you were in. There is no clever
 * event-stopping here because there is nothing to stop: the two targets do not
 * contain one another.
 *
 * React Native's responder negotiation would in fact spare the nested version
 * today — the innermost responder wins, so the outer press never starts — and
 * that is exactly why the arrangement is written down rather than left to it.
 * The containment is what a plain DOM `onClick`, a keyboard activation, or the
 * next version of the responder system would fire twice, and none of those
 * would announce themselves.
 *
 * `aria-selected` is set directly rather than through `PressRow`'s `selected`,
 * which reaches react-native-web as `accessibilityState` — a prop version 0.21
 * no longer maps to anything. It renders no attribute at all, silently, which
 * is exactly the kind of accessibility hole that looks fine in a review.
 */
function TabItem({
  tab,
  label,
  active,
  onActivate,
  onClose,
  onMenu,
  onMeasure,
}: {
  tab: Tab;
  label: string;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
  onMenu: (at: { x: number; y: number }) => void;
  onMeasure: (box: { x: number; width: number }) => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);

  // The dot IS the close button wearing a different face; see the file comment.
  // Hovering the tab anywhere reveals the ×, because by then the pointer is
  // already on its way to it.
  const showDot = tab.dirty && !hovered;
  // The path, not the label: the label is deliberately the short form, and a
  // screen reader announcing "notes" for two different notes is the ambiguity
  // `tabLabel` exists to fix everywhere it has the room to.
  const spoken = `${tab.path}${tab.dirty ? ", unsaved changes" : ""}`;

  return (
    <View
      testID={`tab-${tab.path}`}
      style={[styles.tab, active ? styles.tabActive : styles.tabIdle]}
      onLayout={(event: LayoutChangeEvent) => {
        const { x, width } = event.nativeEvent.layout;
        onMeasure({ x, width });
      }}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      {...mouseButtonProps({ onMiddleClick: onClose, onRightClick: onMenu })}
    >
      <Pressable
        role="tab"
        aria-selected={active}
        accessibilityLabel={spoken}
        onPress={onActivate}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={styles.hit}
        testID={`tab-open-${tab.path}`}
      >
        <Text
          numberOfLines={1}
          style={[
            styles.label,
            active ? styles.labelActive : styles.labelIdle,
            tab.preview && styles.labelPreview,
          ]}
        >
          {label}
        </Text>
        <FocusRing visible={focused} radius={0} />
      </Pressable>

      {/*
        THE ✕ IS THE FRONT TAB'S, THE HOVERED ONE'S, AND A DIRTY ONE'S.

        It used to be every tab's, and a strip of five open notes was a strip
        of five ✕s — the canvas draws one, on the tab you are reading. Chrome,
        Safari and Obsidian all do the same thing for the same reason: the
        close button is a *destination for a pointer already on its way*, and a
        pointer that is not on a tab is not on its way to closing it.

        Three conditions, because each covers a case the others do not:
        `active` is the canvas's; `hovered` is the pointer already there, which
        is what makes every tab closeable without any of them advertising it;
        and `tab.dirty` never hides, because the dot is the only thing on
        screen saying this note has unsaved text and hiding it would make a
        tab with work in it look identical to one without.

        Faded, never unmounted — the same technique and the same reasons as
        the explorer's header toolbar. A ✕ that leaves the tree is one a
        keyboard cannot tab to and a test cannot press, and a ✕ that grows
        back on hover would resize the tab under the hand reaching for it.
        Nobody ever presses an invisible one: by the time a pointer is over
        the tab, `hovered` is already true.
      */}
      <Pressable
        role="button"
        accessibilityLabel={`Close ${label}${tab.dirty ? ", unsaved changes" : ""}`}
        onPress={onClose}
        style={[styles.close, !(active || hovered || tab.dirty) && styles.closeAway]}
        testID={`tab-close-${tab.path}`}
      >
        {showDot ? (
          <View style={styles.dirtyDot} testID={`tab-dot-${tab.path}`} />
        ) : (
          <Icon name="close" size={10} color={colors.chromeMuted} />
        )}
      </Pressable>
    </View>
  );
}


/** The canvas's tab, hanging off a 44pt title bar with 10pt of air above it. */
const TAB_HEIGHT = 34;

/** The ✕'s box, and the width the spacer holds when there is no ✕. */
const CLOSE_WIDTH = 18;

const makeStyles = (colors: Colors) => StyleSheet.create({
  /**
   * The band the tabs sit in — **and it draws nothing**.
   *
   * It had `surface2` behind it and a hairline under it, so the strip was a
   * third horizontal band stacked between the title bar and the note. The
   * frame separates its regions by value now (`chromeSurface`/`pageSurface`,
   * `tokens.ts`), and this band sits on the page: a fill of its own would be a
   * fourth surface, and the rule would draw a boundary the active tab is
   * specifically trying not to have.
   *
   * `alignItems: "flex-end"` because the tabs are shorter than the band and
   * hang from its foot, which is what lets the active one meet the note.
   */
  strip: {
    flexDirection: "row",
    alignItems: "flex-end",
  },

  scroller: {
    flexGrow: 1,
    flexShrink: 1,
  },

  scrollerContent: {
    // `flexGrow: 1` so the strip's ground colour reaches the right-hand edge
    // when there are only two tabs open.
    flexGrow: 1,
  },

  /** One row, forever. See the comment at its use site. */
  track: {
    flexDirection: "row",
    flexWrap: "nowrap",
    alignItems: "flex-end",
    /* The canvas's 2pt, which is what stops two adjacent idle tabs reading as
       one long label. It is all the separation they get now that the hairline
       between every pair is gone. */
    gap: 2,
  },

  /**
   * One tab.
   *
   * **It was a cell in a table and it is a tab now.** Every tab carried a
   * right hairline and a 2pt transparent top border, and the active one was a
   * `surface` fill under an accent rule — a VS Code strip, which is a row of
   * boxes that happen to be adjacent. The design draws what a browser draws:
   * the active tab is the *same surface as the page*, rounded at its top
   * corners, so it reads as the front edge of what is below it, and the idle
   * ones are labels with no box at all.
   *
   * No borders, so nothing has to reserve space for a highlight it does not
   * have — which is what the "always two pixels" note was working around.
   */
  tab: {
    flexDirection: "row",
    alignItems: "center",
    height: TAB_HEIGHT,
    /*
      8, which is not in `radii` and is deliberate.

      The family there is 6 / 10 / 16 and it is a *nesting* rule — "a child's
      radius is its parent's minus the padding between them". A tab nests in
      nothing: it hangs off the edge of the title bar with no padding between
      the two, so the rule has no input for it. The canvas draws 8, between the
      6 of the chip beside it and the 10 of a panel, and taking 6 here makes a
      34pt tab look like a 28pt chip that grew.
    */
    borderTopLeftRadius: 8,
    borderTopRightRadius: 8,
  },

  /** The page's own surface, which is what makes this the page's front edge. */
  tabActive: { backgroundColor: colors.pageSurface },

  tabIdle: { backgroundColor: "transparent" },

  /*
    No vertical padding: `tab` sets the height now, so padding here would fight
    it. It used to be what made the tab tall, which is why the height and the
    padding kept having to be reasoned about together.
  */
  hit: {
    flexDirection: "row",
    alignItems: "center",
    flexGrow: 1,
    flexShrink: 1,
    alignSelf: "stretch",
    paddingLeft: 12,
    paddingRight: 6,
  },

  label: {
    fontSize: t.ui,
    lineHeight: 18,
    maxWidth: MAX_LABEL_WIDTH,
  },

  /** The one in front is the one you are reading, so it carries the weight. */
  labelActive: { color: colors.text, fontWeight: "500" },
  /** Chrome's grey. A tab you are not reading is furniture, not a label. */
  labelIdle: { color: colors.chromeMuted },

  /** The one cue that says "the next single click replaces this". */
  labelPreview: { fontStyle: "italic" },

  close: {
    width: CLOSE_WIDTH,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 6,
    borderRadius: radii.xs,
  },

  /** See its use site: the ✕ keeps its box so the tab never changes width. */
  closeAway: { opacity: 0 },

  dirtyDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.accent,
  },





});
