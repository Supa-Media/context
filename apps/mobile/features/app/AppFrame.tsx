import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  View,
  type ViewStyle,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon, type IconName } from "../design/components/Icon";
import { Text } from "../design/components/Text";
import { viewportHeight } from "../design/css";
import { layout, radii, space } from "../design/tokens";
import { useColors, useThemedStyles, type Colors, type Shadows } from "../design/theme";
import {
  clampExplorerWidth,
  closesOnSelect,
  densityFor,
  explorerToggleFor,
  floatingGapFor,
  initialFrame,
  panelsClearedFor,
  railToggleFor,
  regionsFor,
  type Density,
  type FrameState,
  type Regions,
} from "./frame";

/**
 * The application frame.
 *
 * This replaces the arrangement the console shipped with, which was a 1200px
 * card centred inside the landing page's own scroll container, between a
 * marketing header and a marketing footer. That is the right shape for a
 * *picture* of the product — the landing page still uses it — and the wrong
 * shape for the product: the page scrolled, the file tree scrolled again
 * inside a fixed 432px box, and on a wide display the app occupied a strip in
 * the middle of an empty screen.
 *
 * Here the browser window is the window. Four regions, each owning its own
 * scroll, and a document that never moves.
 *
 * ## Two real surfaces, not one plus a fallback
 *
 * The same codebase serves a browser and a phone, and both are the product. On
 * a wide window this is a desktop application — three columns at once, a
 * resizable explorer, a status bar, a right-click menu and a keyboard chord for
 * every operation. On a phone it is a phone application — the editor owns the
 * screen, the rail and the tree come in as sheets over it, and the verbs sit on
 * a bottom toolbar within thumb reach, which is where Obsidian mobile puts them
 * and where a thumb can actually reach.
 *
 * Neither is derived from the other. What is shared is the layer underneath:
 * the menu items, the drop rules, the tab model and the ranking are one
 * implementation each, so an operation cannot be available on one surface and
 * quietly missing on the other. Only the presentation forks — and where it
 * forks it does so on purpose, because a 44pt row is wrong under a pointer and
 * a 24px row is unusable under a thumb.
 *
 * Which regions exist at a given width is decided by `frame.ts`, as a pure
 * function with tests, because the combinations that are wrong (a drawer *and*
 * a column, a bottom bar on a desktop, a drawer that survives a rotation into a
 * layout with no drawer) are exactly the ones nobody catches by resizing a
 * browser.
 *
 * ## Slots, not knowledge
 *
 * `AppFrame` knows about geometry and nothing else. It takes the rail, the
 * explorer and the editor as nodes and never imports the console's data, which
 * is what lets it be mounted in a test — and, later, around a pane that is not
 * Browse — without dragging a Convex subscription in behind it.
 */

/* -------------------------------------------------------------------------- */
/*                                   context                                  */
/* -------------------------------------------------------------------------- */

export interface FrameApi {
  density: Density;
  regions: Regions;
  state: FrameState;
  /**
   * The drawer button, and ⌘⇧E on web.
   *
   * What toggling the explorer *means* is `explorerToggleFor`'s to decide, and
   * at a density where it answers `null` — medium and wide, where the explorer
   * is a permanent column and there is nothing to pull in — this genuinely
   * does nothing. It used to toggle `railCollapsed` there, which made ⌘⇧E a
   * second ⌘B that never once touched the explorer.
   */
  toggleExplorer: () => void;
  /**
   * ⌘B, and the switcher in the top bar.
   *
   * Collapses the rail to its marks on a pointer layout and pulls it in as a
   * sheet on a phone — `railToggleFor` owns which, for the same reason
   * `explorerToggleFor` owns the other one.
   */
  toggleRail: () => void;
  closeDrawer: () => void;
  /**
   * Dismisses the rail sheet. Clears the flag at any density; there is only
   * anything to see at compact, where the sheet is the thing being dismissed.
   */
  closeNav: () => void;
  /**
   * Puts away whatever panel is over the editor, and says whether there was
   * one.
   *
   * The scrim's handler, and Escape's. `keymap.ts` promises "Escape closes
   * whatever is open, wherever you are"; the boolean is how a caller keeps
   * that promise honest, returning `false` so the browser's own Escape
   * behaviour survives when nothing was open.
   */
  closeOverlays: () => boolean;
  setExplorerWidth: (width: number) => void;
  /**
   * True on a phone: choosing a note has to dismiss the drawer, because the
   * drawer is covering the note. False everywhere else — dismissing a permanent
   * region because somebody clicked inside it is how people stop using a tree.
   */
  closesOnSelect: boolean;
  /**
   * How much room the floating chrome takes at each edge, for a scroller to
   * spend as **content padding**.
   *
   * On a phone the chrome does not sit in a band the document is kept out of —
   * it lies over the document, and the document runs underneath it. That is
   * how Obsidian draws it, and the giveaway in the reference is at the bottom
   * edge: body text is visible to the left and to the right of the floating
   * pill, on the same lines it covers, because the text column is wider than
   * the bar and simply runs behind it.
   *
   * Which means the *viewport* must not be shrunk to make room. A scroller that
   * stops where the toolbar begins has a hard edge across the glass and cannot
   * scroll its last line clear of anything. A scroller that fills the screen and
   * pads its **content** by these numbers has neither problem: the first and
   * last lines can be brought out from under the chrome, and everything in
   * between passes behind it.
   *
   * Zero at every other density, where the bars are real regions with their own
   * surfaces and the document is genuinely beside them rather than beneath them.
   */
  contentInsets: { top: number; bottom: number };
  /**
   * The gap the floating chrome keeps from the bottom of the glass.
   *
   * Exposed rather than recomputed because a second caller has appeared: the
   * keyboard accessory bar covers the toolbar while the keyboard is up, and it
   * has to land exactly where that toolbar was. Two components each calling
   * `floatingGapFor(useSafeAreaInsets().bottom)` would be the same number
   * derived twice — and, more practically, would make every component that
   * mounts the accessory bar need a `SafeAreaProvider` above it, which is the
   * dependency `useFrame`'s no-provider fallback exists to avoid.
   */
  chromeGap: number;
  /**
   * Whether the keyboard accessory bar is up, and the way to say so.
   *
   * While a note has the caret, the row riding above the keyboard *is* the
   * toolbar — that is what the reference shows: in the editing screenshot there
   * is no bottom bar at all. Drawing both is two bars stacked on a 440pt screen
   * saying different things, and the accessory bar cannot simply paint over the
   * other one: it lives inside the editor region and the toolbar is a sibling of
   * that region, so their `zIndex`es are compared in different stacking contexts
   * and the toolbar wins whatever either of them asks for.
   *
   * So the frame puts its own toolbar away instead, which is both the correct
   * z-order and the correct behaviour. It is state on the frame rather than a
   * region rule in `frame.ts` because `regionsFor` decides regions from a width
   * and knows nothing about where the caret is.
   */
  accessoryOpen: boolean;
  setAccessoryOpen: (open: boolean) => void;
}

const FrameContext = createContext<FrameApi | null>(null);

/**
 * The frame's state, for the regions inside it.
 *
 * Returns a usable default rather than throwing when there is no provider. The
 * file tree is mounted both inside this frame and inside the landing page's
 * fake console window, and a hook that threw would make the second one a crash
 * instead of a screenshot.
 */
export function useFrame(): FrameApi {
  const fallbackDensity = densityFor(useWindowDimensions().width);
  const provided = useContext(FrameContext);
  return (
    provided ?? {
      density: fallbackDensity,
      regions: regionsFor(fallbackDensity, initialFrame),
      state: initialFrame,
      toggleExplorer: noop,
      toggleRail: noop,
      closeDrawer: noop,
      closeNav: noop,
      closeOverlays: () => false,
      setExplorerWidth: noop,
      closesOnSelect: closesOnSelect(fallbackDensity),
      contentInsets: NO_CONTENT_INSETS,
      chromeGap: floatingGapFor(0),
      accessoryOpen: false,
      setAccessoryOpen: noop,
    }
  );
}

function noop(): void {}

/**
 * The fallback frame's insets, and every pointer layout's.
 *
 * A frozen object rather than a fresh literal: `useFrame` hands this back to
 * every component mounted outside a provider — the landing page's fake console
 * window, and a hundred-odd tests — and a new object each call is a new `style`
 * array each render for anything that spreads it.
 */
const NO_CONTENT_INSETS = { top: 0, bottom: 0 } as const;

/**
 * `inert`, spread rather than written as a prop.
 *
 * It is a real DOM attribute that react-native-web forwards
 * (`modules/forwardedProps`), and it is not in React Native's `ViewProps` —
 * because on native it means nothing and `accessibilityViewIsModal` on the
 * panel does the job instead. Spreading a typed constant keeps the escape
 * hatch in one named place, the way `css.ts` does for gradients and
 * `cursor: col-resize` does below.
 *
 * `true`, not `""`. The empty string is how the attribute is spelled in HTML
 * and it is dropped on the way to the DOM; only a boolean survives.
 */
const INERT = { inert: true } as unknown as { pointerEvents?: undefined };

/* -------------------------------------------------------------------------- */
/*                                   frame                                    */
/* -------------------------------------------------------------------------- */

export interface AppFrameProps {
  /** The context switcher, at the leading edge of the top bar. */
  switcher: ReactNode;
  /**
   * What the switcher says, as a string — the accessible name of the control
   * that opens the rail on a phone.
   *
   * Passed rather than derived, because deriving it only works on one of the
   * two platforms this app ships to. On web the `<button>` takes its name from
   * its content and the chevron beside it is `aria-hidden`, so "Your context, 3
   * reachable" is what a screen reader reads. On iOS and Android neither half
   * holds: `aria-hidden` is destructured by `View` and **not** by `Text`
   * (`react-native/Libraries/Text/Text.js`), so it is dropped as an unknown
   * prop, and `RCTRecursiveAccessibilityLabel` concatenates every descendant's
   * text regardless — VoiceOver would announce "@seyi personal black
   * down-pointing small triangle".
   *
   * Every other glyph in this file sits inside a control that carries an
   * explicit label, which short-circuits that recursion. This is the first one
   * that relied on content-derived naming, and it is where the trick fails.
   */
  switcherLabel?: string;
  /** Storage chip, avatar — the trailing edge of the top bar. */
  topTrailing?: ReactNode;
  /** Opens the palette. Renders the search field on web, a button on touch. */
  onSearch?: () => void;
  /**
   * The rail, told how much room it has and what shape it is in.
   *
   * The three modes are `Regions.rail` minus `hidden`, passed straight through
   * rather than folded into two: a phone sheet has the width for labels *and*
   * needs targets a thumb can hit, and collapsing it to `full` here is what
   * made the sheet inherit a pointer layout's 35pt rows.
   *
   * Reachable at every density — a column on a pointer layout, a sheet the top
   * bar brings in on a phone. It is not optional and must not become so: the
   * app-level panes, the other contexts and sign-out are reachable through this
   * node and no other, so a density with no way to reach it is a density you
   * cannot navigate out of. On a phone it is mounted only while the sheet is
   * up, which is why the slot is a function rather than a node.
   */
  rail: (mode: "full" | "icons" | "sheet") => ReactNode;
  /**
   * The file tree, rendered as a column or inside the drawer.
   *
   * Omit it for a route that has no tree — Map and Connections are app-level
   * panes spanning every context, and there is no single tree that belongs
   * beside them. The frame then draws no column, no drawer and no drawer
   * button, rather than a 260px empty strip and a button that opens nothing.
   */
  explorer?: ReactNode;
  /** Counts and save state, on the bottom edge of a pointer layout. */
  status?: ReactNode;
  /** Thumb-reach verbs, on the bottom edge of a phone. */
  bottomBar?: ReactNode;
  /** The editor. */
  children: ReactNode;
}

export function AppFrame({
  switcher,
  switcherLabel,
  topTrailing,
  onSearch,
  rail,
  explorer,
  status,
  bottomBar,
  children,
}: AppFrameProps) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [state, setState] = useState<FrameState>(initialFrame);

  const density = densityFor(width);
  const hasExplorer = explorer != null;
  const regions = regionsFor(density, state, { hasExplorer });

  /*
    A panel is not a preference. `railCollapsed` and `explorerWidth` survive a
    resize on purpose; "a sheet is over your editor" cannot, because at every
    other density there is nothing on screen that could put it away — see
    `panelsClearedFor`. Without this, rotating an iPad out of compact and back
    returns you to a scrim you never raised.
  */
  useEffect(() => {
    setState((current) => panelsClearedFor(density, current));
  }, [density]);

  // One command with one meaning per density, and `frame.ts` owns which. The
  // field it names is toggled; a `null` is a real no-op, not a licence to do
  // something else — toggling the rail here is what made ⌘⇧E a duplicate of
  // ⌘B on every layout that has an explorer column.
  const toggleExplorer = useCallback(() => {
    setState((current) => {
      // `hasExplorer` matters here for the same reason it matters to
      // `regionsFor`: on Map and Connections there is no tree, the command has
      // nothing to do, and doing nothing has to mean *nothing* — the line
      // below would otherwise dismiss the rail sheet on its way to setting a
      // flag `regionsFor` discards.
      const field = explorerToggleFor(densityFor(width), { hasExplorer });
      if (field === null) return current;
      // The two compact panels share a place on the screen and a scrim, so
      // raising one puts the other away. `frame.ts` resolves a state carrying
      // both; that the resolution is unreachable from here is the point.
      return { ...current, navOpen: false, [field]: !current[field] };
    });
  }, [width, hasExplorer]);

  const toggleRail = useCallback(
    () =>
      setState((current) => {
        const field = railToggleFor(densityFor(width));
        return field === "navOpen"
          ? { ...current, drawerOpen: false, navOpen: !current.navOpen }
          : { ...current, railCollapsed: !current.railCollapsed };
      }),
    [width],
  );
  const closeDrawer = useCallback(
    () => setState((current) => (current.drawerOpen ? { ...current, drawerOpen: false } : current)),
    [],
  );
  const closeNav = useCallback(
    () => setState((current) => (current.navOpen ? { ...current, navOpen: false } : current)),
    [],
  );
  /**
   * The scrim covers whichever panel is up, so it dismisses whichever panel is
   * up — and Escape means the same thing.
   *
   * Reports whether there was anything to close. Reading `state` for the answer
   * rather than the updater's `current` is safe because a keystroke and a press
   * both arrive between renders, and it is what lets the return value be
   * synchronous for a keymap that has to decide, now, whether it handled the
   * key.
   */
  const closeOverlays = useCallback(() => {
    const wasOpen = state.drawerOpen || state.navOpen;
    if (wasOpen) setState((current) => ({ ...current, drawerOpen: false, navOpen: false }));
    return wasOpen;
  }, [state.drawerOpen, state.navOpen]);
  const setExplorerWidth = useCallback(
    (next: number) =>
      setState((current) => ({ ...current, explorerWidth: clampExplorerWidth(next) })),
    [],
  );

  const compact = density === "compact";

  /**
   * The two bands the floating chrome occupies, as content padding.
   *
   * Read from the same tokens the chrome is drawn from, and from the same
   * `max(insets.bottom, floatingGap)` the bottom slot pads with, so the number
   * a scroller pads by and the number the toolbar actually takes cannot drift.
   * The top is the safe area plus the compact bar's own height; the bottom is
   * the toolbar, the gap above it and the gap below it.
   */
  const chromeGap = floatingGapFor(insets.bottom);
  /*
    See `FrameApi.accessoryOpen`. Held here because the thing it hides — the
    bottom toolbar — is rendered here, and because the editor that raises it is
    several components down inside the slot this frame is given.
  */
  const [accessoryOpen, setAccessoryOpenState] = useState(false);
  const setAccessoryOpen = useCallback(
    (open: boolean) => setAccessoryOpenState((current) => (current === open ? current : open)),
    [],
  );

  const contentInsets = useMemo(
    () =>
      compact
        ? {
            top: insets.top + layout.chromeButton + space.x3,
            bottom: layout.bottomBarHeight + layout.floatingInset + chromeGap,
          }
        : NO_CONTENT_INSETS,
    [compact, insets.top, chromeGap],
  );

  const api = useMemo<FrameApi>(
    () => ({
      density,
      regions,
      state,
      toggleExplorer,
      toggleRail,
      closeDrawer,
      closeNav,
      closeOverlays,
      setExplorerWidth,
      closesOnSelect: closesOnSelect(density),
      contentInsets,
      chromeGap,
      accessoryOpen,
      setAccessoryOpen,
    }),
    [
      density,
      regions,
      state,
      toggleExplorer,
      toggleRail,
      closeDrawer,
      closeNav,
      closeOverlays,
      setExplorerWidth,
      contentInsets,
      chromeGap,
      accessoryOpen,
      setAccessoryOpen,
    ],
  );

  return (
    <FrameContext.Provider value={api}>
      <View
        style={[
          styles.frame,
          viewportHeight(),
          /*
            The notch, and only where the layout keeps the document out of it.

            On a pointer layout the top bar is a real region with a surface and
            a hairline, so the frame pads itself down past the notch and the bar
            sits below it. On a phone the chrome floats *over* the document and
            the document runs to the top of the glass, so padding here would put
            a 59pt white band above a note that is meant to scroll behind the
            status bar. The bar carries the inset itself instead
            (`topBarCompact`'s `paddingTop`), and a scroller keeps its first
            line reachable with `contentInsets.top`.
          */
          compact ? null : { paddingTop: insets.top },
        ]}
        testID="app-frame"
      >
        <View
          style={[
            styles.topBar,
            compact && styles.topBarCompact,
            compact && { paddingTop: insets.top, height: contentInsets.top },
          ]}
        >
          {regions.drawerToggle ? (
            <FrameIconButton
              label={state.drawerOpen ? "Close the file tree" : "Open the file tree"}
              icon="panelLeft"
              onPress={toggleExplorer}
              selected={state.drawerOpen}
              round={compact}
              testID="frame-drawer-toggle"
            />
          ) : null}

          {/*
            The switcher is the way into the rail on a phone.

            Not a second `☰` beside the tree's: two identical glyphs in a 390px
            bar opening two different panels is a coin toss, and one of them
            does not exist on Map or Connections. The chip already names the
            scope you are in — "Your context", "@you · personal" — which is
            exactly what a workspace switcher says, so pressing it to change
            that scope is the behaviour it was already advertising. Its own
            text is still the accessible name, spelled out through
            `switcherLabel` because content-derived naming does not survive the
            crossing to native.
          */}
          {regions.navToggle ? (
            <Pressable
              onPress={toggleRail}
              role="button"
              accessibilityLabel={switcherLabel}
              aria-expanded={state.navOpen}
              testID="frame-nav-toggle"
              style={({ pressed }) => [
                styles.topLead,
                styles.navToggle,
                compact && styles.navToggleCompact,
                pressed && compact && styles.navTogglePressed,
              ]}
            >
              {switcher}
              <Icon
                name={state.navOpen ? "chevronUp" : "chevronDown"}
                size={14}
                color={colors.muted}
              />
            </Pressable>
          ) : (
            <View style={styles.topLead}>{switcher}</View>
          )}

          {/*
            Search sits in the top bar where there is a pointer and in the
            bottom toolbar where there is a thumb. Rendering it in both places
            would put the same control twice on the one screen that has least
            room for it.
          */}
          {onSearch && !compact ? <SearchTrigger onPress={onSearch} /> : null}

          {/*
            One container per control, and on a phone this one is empty.

            It used to wrap its chips in a bordered, filled pill — so the tier
            chip drew a border inside a border, and the storage chip drew one
            inside a press target inside that. Three nested rounded boxes for
            two words. The argument for the outer pill was that at this density
            the bar has no fill of its own, so two chips floating separately
            read as debris rather than as chrome; the argument was sound and the
            conclusion was one box too many.

            What actually fixes it is having nothing here to group. On a phone
            both chips have moved to the foot of the file tree — the slot
            Obsidian puts a vault switcher and its settings in — which is where
            a fact *about the context you are in* belongs, beside its name, and
            not floating over the note you are reading. `_layout` passes no
            `topTrailing` at compact, so this renders nothing and the top edge
            is one toggle and one chip.

            At every other density the bar has its own surface and its own
            hairline, the chips have room, and a container around them would be
            a box in a box.
          */}
          {topTrailing == null ? null : <View style={styles.topTrail}>{topTrailing}</View>}
        </View>

        <View style={styles.body}>
          {regions.rail === "full" || regions.rail === "icons" ? (
            <View
              style={[styles.rail, regions.rail === "icons" && styles.railIcons]}
              role="navigation"
              aria-label="Console"
            >
              {rail(regions.rail)}
            </View>
          ) : null}

          {regions.explorer === "column" ? (
            <View style={[styles.explorerColumn, { width: state.explorerWidth }]}>
              {explorer}
              <ExplorerResizer width={state.explorerWidth} onResize={setExplorerWidth} />
            </View>
          ) : null}

          {/*
            Behind a panel, out of reach — of the pointer via the scrim, and of
            the keyboard and the screen reader via these.

            Without them Tab from the switcher lands *in the note the sheet is
            covering*, and a swipe order walks the whole editor before reaching
            the navigation somebody just asked for. `inert` is forwarded by
            react-native-web and ignored by native; `importantForAccessibility`
            is Android's and ignored on web. Each platform reads its own.
          */}
          <View
            style={styles.editor}
            {...(regions.scrim ? INERT : null)}
            importantForAccessibility={regions.scrim ? "no-hide-descendants" : "auto"}
          >
            {children}
          </View>

          {/*
            The panels are painted last so they lie over the editor without any
            z-index arithmetic — in React Native, later siblings are on top, and
            `zIndex` is the thing that behaves differently between the two
            platforms. Only ever one of them is up (`frame.ts` resolves it), so
            their order relative to each other decides nothing.
          */}
          {regions.scrim ? (
            <Pressable
              style={styles.scrim}
              onPress={closeOverlays}
              // It is focusable — `Pressable` gives it a tab stop — so it needs
              // a role as well as a name. Labelled and roleless, a screen
              // reader announces a stop it cannot describe.
              role="button"
              accessibilityLabel="Close this panel"
              testID="frame-scrim"
            />
          ) : null}

          {regions.explorer === "drawer" ? (
            <View
              /*
                A panel is full height now, because the body is: the chrome
                floats over it rather than sitting above it. So the panel runs
                from the top of the glass to the bottom, the way Obsidian's
                sidebar does, and pays for the chrome in padding — the top
                clears the status bar and the floating toggle, the bottom clears
                the floating toolbar. Without the top, the filter row would sit
                under the notch; without the bottom, the vault footer would sit
                under the toolbar.
              */
              style={[
                styles.drawer,
                compact && styles.panelRounded,
                compact
                  ? { paddingTop: contentInsets.top, paddingBottom: contentInsets.bottom }
                  : { paddingBottom: insets.bottom },
              ]}
              accessibilityViewIsModal
              testID="frame-drawer"
            >
              {explorer}
            </View>
          ) : null}

          {/*
            The rail, over the editor rather than beside it. Full labels, not
            the icon rail: a sheet has the width, and a phone has no hover to
            recover a glyph's meaning with. It carries the account block too,
            which is why sign-out was unreachable on a phone until this
            existed.
          */}
          {regions.rail === "sheet" ? (
            <View
              /*
                The home indicator. `insets.bottom` is applied to the bottom bar
                and nowhere else, and Map and Connections have no bottom bar —
                which is to say the panes you land on after signing in are
                exactly the ones where a full-height panel runs to the edge of
                the glass. The account block is pinned to the foot of this
                sheet, so without this, sign-out sits under the indicator on the
                one surface it is reachable from.
              */
              style={[
                styles.navSheet,
                compact && styles.panelRounded,
                compact
                  ? { paddingTop: contentInsets.top, paddingBottom: contentInsets.bottom }
                  : { paddingBottom: insets.bottom },
              ]}
              accessibilityViewIsModal
              role="navigation"
              aria-label="Console"
              testID="frame-nav-sheet"
            >
              {rail("sheet")}
            </View>
          ) : null}
        </View>

        {regions.statusBar && status ? <View style={styles.status}>{status}</View> : null}

        {/*
          The toolbar's room, and both of its edges.

          `max` rather than a sum: on a notched phone the home indicator's inset
          is already a gap, and adding the float inset on top of it is the "bar
          floating 68px above the home indicator" `BottomBar` warns about. On a
          phone or a browser with no inset there is nothing, and a pill flush
          against the bottom of the glass is not a floating object. So the pill
          gets whichever gap is larger, from here, and `BottomBar` sets nothing
          on that edge at all.

          The floor is `floatingGap` (25), measured off the reference, not the
          10pt `floatingInset` that used to serve here — at 10 the pill sat
          near enough to the edge to read as attached to it. See the token.
        */}
        {/*
          Not while the keyboard accessory bar is up — see
          `FrameApi.accessoryOpen`. The reference has no bottom bar in its
          editing screenshot, and two floating bars in the same 66pt of glass
          is worse than either.
        */}
        {regions.bottomBar && bottomBar && !accessoryOpen ? (
          <View
            style={[
              styles.bottomBar,
              {
                paddingTop: layout.floatingInset,
                paddingBottom: chromeGap,
              },
            ]}
            /*
              The toolbar floats over the document; only the document's own
              last line needs to clear it, and `contentInsets.bottom` is how it
              does. This band therefore must not eat presses aimed at the text
              running behind it — only the pill inside it may.
            */
            pointerEvents="box-none"
          >
            {bottomBar}
          </View>
        ) : null}
      </View>
    </FrameContext.Provider>
  );
}

/* -------------------------------------------------------------------------- */
/*                                   pieces                                   */
/* -------------------------------------------------------------------------- */

/**
 * ⌘K.
 *
 * It said "Search notes and commands" and there are no commands. A field that
 * names a thing it does not contain teaches somebody to type a verb into it,
 * get nothing back, and stop using it — and the same words were its accessible
 * name, so a screen reader announced the same promise.
 *
 * It says what the palette's own placeholder says, and the two agreeing is the
 * point: the trigger and the thing it opens should not describe two different
 * tools.
 */
function SearchTrigger({ onPress }: { onPress: () => void }) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      role="button"
      accessibilityLabel="Search this context"
      testID="frame-search"
      style={[styles.search, hovered && styles.searchHover]}
    >
      <Icon name="search" size={15} color={colors.muted} />
      <Text variant="rowSub">Search this context</Text>
      {Platform.OS === "web" ? (
        <View style={styles.kbd}>
          <Text variant="treeMeta">⌘K</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

/**
 * A control in the frame's chrome.
 *
 * Two shapes, and the difference is not decoration. Under a pointer it is a
 * 30pt square that tints on hover, sitting in a ruled bar — the hover is what
 * says it is a control, so the resting state can be nothing at all, and 30 is
 * fine because the *bar* around it is the 44pt band.
 *
 * A phone has no hover and no band. `round` gives it a filled circle with a
 * shadow, at `layout.chromeButton` — which is exactly `minTouchTarget`, and
 * derived from it rather than typed, because here the visible circle is the
 * whole target and there is no padding around it to make up a shortfall.
 */
export function FrameIconButton({
  label,
  icon,
  onPress,
  selected = false,
  round = false,
  testID,
}: {
  label: string;
  icon: IconName;
  onPress: () => void;
  selected?: boolean;
  /** The phone's shape: a filled circle lying over the document. */
  round?: boolean;
  testID?: string;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      role="button"
      accessibilityLabel={label}
      testID={testID}
      style={({ pressed }) => [
        styles.iconButton,
        round && styles.iconButtonRound,
        // `iconButtonHover` tints an untinted square; on a filled circle it
        // would paint `surface3` *over* `chrome`, which is darker than the
        // resting state and reads as the control switching off. The circle
        // lights the way it does under a thumb instead — this is reachable on
        // a narrowed desktop browser, which is a real surface here.
        hovered && (round ? styles.iconButtonPressed : styles.iconButtonHover),
        selected && styles.iconButtonOn,
        round && pressed && styles.iconButtonPressed,
      ]}
    >
      <Icon
        name={icon}
        size={round ? 20 : 17}
        color={selected ? colors.accentText : colors.text2}
      />
    </Pressable>
  );
}

/**
 * The explorer's drag handle.
 *
 * `PanResponder` rather than web pointer events, because it is the one gesture
 * API that behaves identically under RN-Web and on a device — a tablet in a
 * split view resizes this the same way a mouse does. The width is clamped in
 * `frame.ts`, so a drag can neither hide the region nor squeeze the editor
 * below a readable measure.
 */
function ExplorerResizer({
  width,
  onResize,
}: {
  width: number;
  onResize: (next: number) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const [active, setActive] = useState(false);

  /**
   * The live width, and the width this drag started from.
   *
   * `liveWidth` is a ref rather than the `width` prop read straight out of the
   * closure below, and that is the whole point of this component's shape.
   *
   * **Do not add `width` to the responder's dependency list.** Putting the
   * value a memo closes over into its deps is the correct instinct almost
   * everywhere and is a bug here, because `width` is the value
   * `onPanResponderMove` itself changes: listing it rebuilds the responder on
   * every move event of a drag. `onPanResponderGrant` does *not* run again —
   * the gesture is already granted — but react-native-web's `PanResponder`
   * gives each instance a fresh `gestureState` with `dx: 0`, so every move
   * applies only the increment since the last rebuild while `startWidth` still
   * holds the grant-time width. A 150px drag from 260 then lands on 360
   * instead of 410, in stuttering jumps.
   *
   * So the responder depends on nothing a drag can change, and the one value
   * it needs at grant time arrives through a ref that a commit keeps current.
   */
  const liveWidth = useRef(width);
  useEffect(() => {
    liveWidth.current = width;
  }, [width]);
  const startWidth = useRef(width);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          startWidth.current = liveWidth.current;
          setActive(true);
        },
        onPanResponderMove: (_event, gesture) => onResize(startWidth.current + gesture.dx),
        onPanResponderRelease: () => setActive(false),
        onPanResponderTerminate: () => setActive(false),
      }),
    [onResize],
  );

  return (
    <View
      {...responder.panHandlers}
      style={[styles.resizer, active && styles.resizerActive]}
      accessibilityLabel="Resize the file tree"
      role="separator"
      testID="explorer-resizer"
    />
  );
}

/* -------------------------------------------------------------------------- */

const makeStyles = (colors: Colors, shadows: Shadows) => StyleSheet.create({
  frame: {
    backgroundColor: colors.ground,
    overflow: "hidden",
  },

  topBar: {
    height: layout.topBarHeight,
    flexDirection: "row",
    alignItems: "center",
    gap: space.x3,
    paddingHorizontal: space.x3,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    backgroundColor: colors.surface2,
  },
  /**
   * The phone's top edge, which is not a bar.
   *
   * No rule, no fill: the chrome is two circular buttons and a chip lying over
   * the same ground the note is on, the way Obsidian mobile draws it. A bar
   * with a hairline under it is a *desktop* toolbar, and on a 390pt screen it
   * spends the top 45pt of the glass saying so.
   *
   * Taller than `topBarHeight`, and derived rather than typed: a row of 44pt
   * circles in a 45pt bar is a bar with half a point of air either side. The
   * hairline that made `topBarHeight` `minTouchTarget + 1` is gone here too,
   * so the pixel it was buying back has nowhere left to hide.
   *
   * **It is one row and there is nothing under it.** The pane below used to add
   * a second strip — a breadcrumb with its own fill and its own rule — so the
   * top 100pt of a 956pt phone was chrome about the note rather than the note.
   * Obsidian spends 50: one transparent row that the document scrolls beneath.
   * `space.x3` of air either side of the circle rather than `space.x4` gets us
   * to the same measure, and the breadcrumb below has been reduced to a single
   * unruled line (`Breadcrumb.barCompact`).
   */
  topBarCompact: {
    /*
      Out of the column and over the document.

      The height and the safe-area padding are applied at the call site, from
      `contentInsets.top`, so the band a scroller pads its content by and the
      band the chrome actually occupies are one number rather than two that
      agree today.

      `zIndex` is set because this is painted *before* the body and has to sit
      above it. React Native's later-sibling rule is what the panels rely on;
      this is the one place that needs the opposite, and paying for it with an
      explicit `zIndex` is cheaper than moving the top bar below the body in the
      tree, where it would also come after the editor in the reading order and
      in the tab order.
    */
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 1,
    paddingHorizontal: space.x3,
    gap: space.x2,
    borderBottomWidth: 0,
    backgroundColor: "transparent",
  },
  topLead: { flexDirection: "row", alignItems: "center", gap: space.x2, minWidth: 0 },
  topTrail: {
    marginLeft: "auto",
    flexDirection: "row",
    alignItems: "center",
    gap: space.x2,
  },

  search: {
    flexShrink: 1,
    maxWidth: 420,
    minWidth: 200,
    marginHorizontal: "auto",
    flexDirection: "row",
    alignItems: "center",
    gap: space.x2,
    paddingVertical: 5,
    paddingHorizontal: space.x3,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.well,
  },
  searchHover: { borderColor: colors.lineStrong },
  kbd: {
    marginLeft: "auto",
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: radii.xs,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface3,
  },

  /** The three columns. `flex: 1` plus `minHeight: 0` is what makes the
      children scroll instead of the frame growing past the viewport. */
  body: {
    flex: 1,
    minHeight: 0,
    flexDirection: "row",
    position: "relative",
  },

  rail: {
    width: layout.railWidth,
    borderRightWidth: 1,
    borderRightColor: colors.line,
    backgroundColor: colors.surface,
  },
  railIcons: { width: layout.railIconWidth },

  explorerColumn: {
    borderRightWidth: 1,
    borderRightColor: colors.line,
    backgroundColor: colors.surface,
    position: "relative",
  },

  editor: { flex: 1, minWidth: 0, backgroundColor: colors.surface },

  resizer: {
    position: "absolute",
    top: 0,
    bottom: 0,
    // Straddles the border so the target is comfortable without being visible.
    right: -3,
    width: 7,
    // RN's `CursorValue` is `"auto" | "pointer"` only; every other CSS cursor
    // needs the same escape hatch `css.ts` uses for gradients and masks.
    ...(Platform.OS === "web" ? ({ cursor: "col-resize" } as unknown as ViewStyle) : null),
  },
  resizerActive: { backgroundColor: colors.accentDim },

  scrim: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: colors.scrim,
  },
  /**
   * The rail as a panel: the tree drawer's geometry, 40pt narrower (300 against
   * 340) because a list of destinations needs less width than a file tree with
   * two levels of indent. The same gesture from the same edge, but its own
   * style — the two are allowed to diverge, and sharing one would make that a
   * rename rather than an edit.
   */
  navSheet: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    width: "86%",
    maxWidth: 300,
    borderRightWidth: 1,
    borderRightColor: colors.lineStrong,
    backgroundColor: colors.surface,
    boxShadow: shadows.drawer,
  },
  /**
   * The primary navigation control on a phone, so it is held to the same floor
   * as the bottom bar's targets rather than to the height of the chip inside
   * it, which measures about 32pt (13px type at 1.55 leading, 5 of padding
   * either side, a hairline border).
   *
   * `alignSelf: "stretch"` alone would give 43, not 44: the top bar is 44
   * *including* its bottom hairline. So the floor is set explicitly and the
   * control takes that last pixel back over the border, where nothing can see
   * it. Stretching as well keeps the target the full height of the bar rather
   * than 44 floating inside 43.
   */
  navToggle: { alignSelf: "stretch", minHeight: layout.minTouchTarget },
  /**
   * The switcher as a chip rather than as a stretched strip.
   *
   * On a pointer it fills the bar's height so the whole 44pt band is a target.
   * There is no band on a phone — stretching to fill a transparent 56pt row
   * puts an invisible target over the top of the note and leaves the words
   * floating with nothing under them. A filled chip is the target *and* the
   * affordance, and it is the shape the two circles beside it are already in.
   *
   * **This is the only container.** The node passed as `switcher` used to draw
   * its own 1px border and 8pt radius *inside* this pill — a bordered box in a
   * shadowed capsule, for one line of type — which is the detail that made the
   * phone's top edge read as a toolbar rendered twice. `_layout` drops that
   * box at compact (`switcherCompact`); nothing in here draws an edge except
   * this.
   */
  navToggleCompact: {
    alignSelf: "center",
    paddingLeft: space.x3,
    paddingRight: space.x2,
    minHeight: layout.chromeButton,
    borderRadius: radii.pill,
    backgroundColor: colors.chrome,
    boxShadow: shadows.floating,
  },
  navTogglePressed: { backgroundColor: colors.chromePressed },
  drawer: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    // Never the whole screen: the sliver of editor still showing is what says
    // "this is a panel over your note", and it is a second way to dismiss it.
    //
    // 372 rather than 340, measured: Obsidian's covers to about 368pt of a
    // 440pt screen. The cap is what binds on a large phone — 86% of 440 is 378
    // — and the percentage is what binds on a small one, where a fixed 372
    // would leave no sliver at all.
    width: "86%",
    maxWidth: 372,
    borderRightWidth: 1,
    borderRightColor: colors.lineStrong,
    backgroundColor: colors.surface,
    boxShadow: shadows.drawer,
  },
  /**
   * A panel on a phone is an object, not a column.
   *
   * Rounded on its trailing edge and unruled: the hairline is what a *column*
   * beside a document needs, and a panel that has been slid over one already
   * has a shadow and a scrim saying the same thing twice as loudly. Applied to
   * both panels from one place because they are the same object in two sizes,
   * and the two stylesheets above have already drifted once.
   */
  panelRounded: {
    borderRightWidth: 0,
    borderTopRightRadius: radii.floating,
    borderBottomRightRadius: radii.floating,
  },

  status: {
    height: layout.statusBarHeight,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: space.x4,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    backgroundColor: colors.surface2,
  },

  /**
   * The slot the toolbar lives in, which draws nothing.
   *
   * It used to be the toolbar's own background and top rule. The toolbar is a
   * floating pill now and carries its own surface and shadow, so a fill here
   * would be a second bar behind it, and a rule would be the edge the pill
   * exists not to have. What is left is the *reservation*: the frame keeps
   * this much of the bottom edge for the toolbar rather than letting the
   * document run under it. See `layout.floatingInset` for why reserved and not
   * overlaid.
   */
  bottomBar: {
    /*
      Over the document rather than beside it.

      This slot used to be the last child of a column, so the body ended where
      the toolbar began: a hard edge across the glass with the note stopping
      short of it. The reference has the note running *behind* the pill — body
      text is visible to the left and the right of it on the lines it covers —
      which is only possible if the scroller is full height and pays for the bar
      in content padding instead. `contentInsets.bottom` is that payment.
    */
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 1,
  },

  iconButton: {
    width: 30,
    height: 30,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
  },
  iconButtonRound: {
    width: layout.chromeButton,
    height: layout.chromeButton,
    borderRadius: radii.pill,
    backgroundColor: colors.chrome,
    boxShadow: shadows.floating,
  },
  iconButtonHover: { backgroundColor: colors.surface3 },
  iconButtonPressed: { backgroundColor: colors.chromePressed },
  iconButtonOn: { backgroundColor: colors.accentDim },
});
