import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
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
  initialFrame,
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
 * screen, the tree is a drawer, and the verbs sit on a bottom toolbar within
 * thumb reach, which is where Obsidian mobile puts them and where a thumb can
 * actually reach.
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
  /** The drawer button, and ⌘⇧E on web. A no-op where there is no drawer. */
  toggleExplorer: () => void;
  /** ⌘B. Collapses the rail to its marks on a wide window. */
  toggleRail: () => void;
  closeDrawer: () => void;
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
      setExplorerWidth: noop,
      closesOnSelect: closesOnSelect(fallbackDensity),
    }
  );
}

function noop(): void {}

/* -------------------------------------------------------------------------- */
/*                                   frame                                    */
/* -------------------------------------------------------------------------- */

export interface AppFrameProps {
  /** The context switcher, at the leading edge of the top bar. */
  switcher: ReactNode;
  /** Storage chip, avatar — the trailing edge of the top bar. */
  topTrailing?: ReactNode;
  /** Opens the palette. Renders the search field on web, a button on touch. */
  onSearch?: () => void;
  /** The rail, told how much room it has. Absent at compact. */
  rail: (mode: "full" | "icons") => ReactNode;
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
  const regions = regionsFor(density, state, { hasExplorer: explorer != null });

  const toggleExplorer = useCallback(() => {
    setState((current) =>
      densityFor(width) === "compact"
        ? { ...current, drawerOpen: !current.drawerOpen }
        : { ...current, railCollapsed: !current.railCollapsed },
    );
  }, [width]);

  const toggleRail = useCallback(
    () => setState((current) => ({ ...current, railCollapsed: !current.railCollapsed })),
    [],
  );
  const closeDrawer = useCallback(
    () => setState((current) => (current.drawerOpen ? { ...current, drawerOpen: false } : current)),
    [],
  );
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
      setExplorerWidth,
      closesOnSelect: closesOnSelect(density),
    }),
    [density, regions, state, toggleExplorer, toggleRail, closeDrawer, setExplorerWidth],
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

          <View style={styles.topLead}>{switcher}</View>

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
          {regions.rail !== "hidden" ? (
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

          <View style={styles.editor}>{children}</View>

          {/*
            The drawer is painted last so it lies over the editor without any
            z-index arithmetic — in React Native, later siblings are on top, and
            `zIndex` is the thing that behaves differently between the two
            platforms.
          */}
          {regions.scrim ? (
            <Pressable
              style={styles.scrim}
              onPress={closeDrawer}
              accessibilityLabel="Close the file tree"
              testID="frame-scrim"
            />
          ) : null}

          {regions.explorer === "drawer" ? (
            <View style={styles.drawer} testID="frame-drawer">
              {explorer}
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
  const startWidth = useRef(width);
  const [active, setActive] = useState(false);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          startWidth.current = width;
          setActive(true);
        },
        onPanResponderMove: (_event, gesture) => onResize(startWidth.current + gesture.dx),
        onPanResponderRelease: () => setActive(false),
        onPanResponderTerminate: () => setActive(false),
      }),
    [width, onResize],
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
