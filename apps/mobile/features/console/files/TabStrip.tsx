import { useCallback, useEffect, useRef, useState } from "react";
import {
  Modal,
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
import { PressRow } from "../../design/components/Button";
import { FocusRing } from "../../design/components/FocusRing";
import { Text } from "../../design/components/Text";
import { colors, radii } from "../../design/tokens";
import { tabLabel, type Tab, type TabsState } from "./tabs";

/**
 * The tab strip: the pointer half of `tabs.ts`.
 *
 * `tabs.ts` owns every rule worth arguing about — what closing the active tab
 * lands on, what a rename does to a draft, what ⌘⇧T brings back — and this file
 * owns none of them. It draws the state and reports gestures. Anything in here
 * that starts deciding *which* tab something happens to belongs in the reducer,
 * where it can be tested one action at a time.
 *
 * The mobile half is `TabSwitcher.tsx`, and it is a different component rather
 * than this one with a breakpoint in it. A strip and a sheet share no geometry,
 * no gesture and no affordance; the only thing they share is `TabsState`, which
 * is exactly the thing that was extracted so they could.
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
  onReopen: () => void;
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
  onReopen,
}: TabStripProps) {
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
              label={tabLabel(state, tab.path)}
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
        <TabMenu
          at={menu}
          canReopen={state.closed.length > 0}
          onClose={() => {
            onClose(menu.path);
            closeMenu();
          }}
          onCloseOthers={() => {
            onCloseOthers(menu.path);
            closeMenu();
          }}
          onReopen={() => {
            onReopen();
            closeMenu();
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

      <Pressable
        role="button"
        accessibilityLabel={`Close ${label}${tab.dirty ? ", unsaved changes" : ""}`}
        onPress={onClose}
        style={styles.close}
        testID={`tab-close-${tab.path}`}
      >
        {showDot ? (
          <View style={styles.dirtyDot} testID={`tab-dot-${tab.path}`} />
        ) : (
          <Text style={[styles.closeGlyph, active ? styles.labelActive : styles.labelIdle]}>
            ×
          </Text>
        )}
      </Pressable>
    </View>
  );
}

/**
 * TODO(menu): fold into the shared `design/components/Menu`.
 *
 * This is a plain popover, written to be thrown away: it hard-codes its own
 * card, its own scrim and its own rows, none of which should exist twice in the
 * app. `Menu` (and its `.web` sibling) now exists and is the right home — it
 * already has the popover-at-the-pointer and sheet-under-the-thumb pair this
 * would otherwise grow itself.
 *
 * What stands in the way is one type, not a design disagreement: `MenuItem.id`
 * is `MenuActionId`, the file-tree action union, and there is no `close`,
 * `closeOthers` or `reopen` in it. Three tab items therefore cannot be
 * expressed as `MenuItem[]` without widening that union — which is a decision
 * about what `menu.ts` is *for* (it is currently "what can I do with this
 * file?", and these are "what can I do with this tab?"), and belongs in the
 * change that widens it rather than smuggled in here.
 *
 * It is a `Modal` rather than an absolutely-positioned sibling for one
 * non-cosmetic reason: the strip is a horizontal scroll view a few dozen pixels
 * tall, so anything drawn inside it is clipped by the scroller. A modal escapes
 * the clip and brings a dismiss-on-outside-press surface with it.
 */
function TabMenu({
  at,
  canReopen,
  onClose,
  onCloseOthers,
  onReopen,
  onDismiss,
}: {
  at: MenuAt;
  canReopen: boolean;
  onClose: () => void;
  onCloseOthers: () => void;
  onReopen: () => void;
  onDismiss: () => void;
}) {
  return (
    <Modal transparent animationType="none" visible onRequestClose={onDismiss}>
      <Pressable style={styles.scrim} accessibilityLabel="Dismiss menu" onPress={onDismiss}>
        {/* Swallow presses on the card so only the scrim dismisses. */}
        <Pressable
          style={[styles.menu, { left: at.x, top: at.y }]}
          onPress={() => {}}
          accessibilityLabel="Tab actions"
          testID="tab-menu"
        >
          <MenuRow label="Close" onPress={onClose} testID="tab-menu-close" />
          <MenuRow label="Close others" onPress={onCloseOthers} testID="tab-menu-others" />
          {/*
            Present and disabled rather than absent, which is the opposite of
            what `menu.ts` does for the file tree — and for a different reason.
            There, absence tells the truth about a read-only context. Here the
            item is one ⌘W away from being available again, and a menu whose
            rows move between openings is a menu you cannot learn.
          */}
          <MenuRow
            label="Reopen closed"
            onPress={canReopen ? onReopen : undefined}
            disabled={!canReopen}
            testID="tab-menu-reopen"
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function MenuRow({
  label,
  onPress,
  disabled = false,
  testID,
}: {
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  testID: string;
}) {
  return (
    <PressRow
      accessibilityLabel={label}
      onPress={disabled ? undefined : onPress}
      style={styles.menuRow}
      hoverStyle={styles.menuRowHover}
      radius={radii.xs}
      testID={testID}
    >
      <Text variant="rail" style={disabled ? styles.menuRowOff : undefined}>
        {label}
      </Text>
    </PressRow>
  );
}

const styles = StyleSheet.create({
  strip: {
    flexDirection: "row",
    alignItems: "stretch",
    backgroundColor: colors.surface2,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
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
    alignItems: "stretch",
  },

  tab: {
    flexDirection: "row",
    alignItems: "center",
    borderRightWidth: 1,
    borderRightColor: colors.line,
    // Always two pixels, so the accent on the active tab does not shift every
    // other tab down by the height of its own highlight.
    borderTopWidth: 2,
    borderTopColor: "transparent",
  },

  tabActive: {
    backgroundColor: colors.surface,
    borderTopColor: colors.accent,
  },

  tabIdle: {
    backgroundColor: colors.surface2,
  },

  hit: {
    flexDirection: "row",
    alignItems: "center",
    flexGrow: 1,
    flexShrink: 1,
    paddingVertical: 8,
    paddingLeft: 12,
    paddingRight: 6,
  },

  label: {
    fontSize: 13,
    lineHeight: 18,
    maxWidth: MAX_LABEL_WIDTH,
  },

  labelActive: { color: colors.text },
  labelIdle: { color: colors.muted },

  /** The one cue that says "the next single click replaces this". */
  labelPreview: { fontStyle: "italic" },

  close: {
    width: 26,
    height: 26,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 6,
    borderRadius: radii.xs,
  },

  closeGlyph: {
    fontSize: 15,
    lineHeight: 17,
  },

  dirtyDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.accent,
  },

  scrim: {
    flexGrow: 1,
  },

  menu: {
    position: "absolute",
    minWidth: 180,
    paddingVertical: 5,
    paddingHorizontal: 5,
    gap: 1,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.surface3,
    boxShadow: "0 18px 44px -18px rgba(0,0,0,.7)",
  },

  menuRow: {
    paddingVertical: 7,
    paddingHorizontal: 9,
    borderRadius: radii.xs,
  },

  menuRowHover: {
    backgroundColor: colors.accentDim,
  },

  menuRowOff: {
    color: colors.muted,
    opacity: 0.6,
  },
});
