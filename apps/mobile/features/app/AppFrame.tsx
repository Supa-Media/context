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
import { Text } from "../design/components/Text";
import { viewportHeight } from "../design/css";
import { colors, layout, radii, space } from "../design/tokens";
import {
  clampExplorerWidth,
  closesOnSelect,
  densityFor,
  explorerToggleFor,
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
    }
  );
}

function noop(): void {}

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
    ],
  );

  const compact = density === "compact";

  return (
    <FrameContext.Provider value={api}>
      <View
        style={[
          styles.frame,
          viewportHeight(),
          // The notch and the home indicator. Only the top and bottom matter:
          // the frame is edge to edge horizontally by design, and the regions
          // inside it carry their own padding.
          { paddingTop: insets.top },
        ]}
        testID="app-frame"
      >
        <View style={[styles.topBar, compact && styles.topBarCompact]}>
          {regions.drawerToggle ? (
            <FrameIconButton
              label={state.drawerOpen ? "Close the file tree" : "Open the file tree"}
              glyph="☰"
              onPress={toggleExplorer}
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
              style={[styles.topLead, styles.navToggle]}
            >
              {switcher}
              <Text style={styles.navChevron} aria-hidden>
                {state.navOpen ? "\u25b4" : "\u25be"}
              </Text>
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

          <View style={styles.topTrail}>{topTrailing}</View>
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
              style={[styles.drawer, { paddingBottom: insets.bottom }]}
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
              style={[styles.navSheet, { paddingBottom: insets.bottom }]}
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

        {regions.bottomBar && bottomBar ? (
          <View style={[styles.bottomBar, { paddingBottom: insets.bottom }]}>{bottomBar}</View>
        ) : null}
      </View>
    </FrameContext.Provider>
  );
}

/* -------------------------------------------------------------------------- */
/*                                   pieces                                   */
/* -------------------------------------------------------------------------- */

function SearchTrigger({ onPress }: { onPress: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      role="button"
      accessibilityLabel="Search notes and commands"
      testID="frame-search"
      style={[styles.search, hovered && styles.searchHover]}
    >
      <Text variant="treeMeta" aria-hidden>
        ⌕
      </Text>
      <Text variant="rowSub">Search notes and commands</Text>
      {Platform.OS === "web" ? (
        <View style={styles.kbd}>
          <Text variant="treeMeta">⌘K</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

export function FrameIconButton({
  label,
  glyph,
  onPress,
  selected = false,
  testID,
}: {
  label: string;
  glyph: string;
  onPress: () => void;
  selected?: boolean;
  testID?: string;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      role="button"
      accessibilityLabel={label}
      testID={testID}
      style={[styles.iconButton, hovered && styles.iconButtonHover, selected && styles.iconButtonOn]}
    >
      <Text style={[styles.iconGlyph, selected && styles.iconGlyphOn]} aria-hidden>
        {glyph}
      </Text>
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

const styles = StyleSheet.create({
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
  topBarCompact: { paddingHorizontal: space.x2 },
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
    backgroundColor: "rgba(0,0,0,.55)",
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
    boxShadow: "24px 0 60px -20px rgba(0,0,0,.9)",
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
   * `▴`/`▾` rather than `⌃`/`⌄`. The arrowhead pair sits high in most faces —
   * they are keyboard-legend glyphs, drawn to align with a modifier symbol
   * rather than with running text — and beside a bordered chip the offset reads
   * as a rendering fault. `BottomBar` makes the same observation about
   * Unicode's optical inconsistency, and draws a different conclusion from it
   * (every glyph gets a visible caption); here there is a chip beside it doing
   * that job already.
   */
  navChevron: { color: colors.muted, fontSize: 10 },
  drawer: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    // Never the whole screen: the sliver of editor still showing is what says
    // "this is a panel over your note", and it is a second way to dismiss it.
    width: "86%",
    maxWidth: 340,
    borderRightWidth: 1,
    borderRightColor: colors.lineStrong,
    backgroundColor: colors.surface,
    boxShadow: "24px 0 60px -20px rgba(0,0,0,.9)",
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

  bottomBar: {
    borderTopWidth: 1,
    borderTopColor: colors.line,
    backgroundColor: colors.surface2,
  },

  iconButton: {
    width: 30,
    height: 30,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
  },
  iconButtonHover: { backgroundColor: colors.surface3 },
  iconButtonOn: { backgroundColor: colors.accentDim },
  iconGlyph: { color: colors.text2, fontSize: 15 },
  iconGlyphOn: { color: colors.accentText },
});
