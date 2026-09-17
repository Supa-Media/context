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
  focusToggleFor,
  initialFrame,
  panelsClearedFor,
  regionsFor,
  topBarLeadFor,
  type Density,
  type FrameState,
  type Regions,
} from "./frame";
import { setBottomChromeHeight } from "./bottomChrome";

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
   * The drawer button, and ⌘B on web.
   *
   * What toggling the explorer *means* is `explorerToggleFor`'s to decide, and
   * at a density where it answers `null` — medium and wide, where the explorer
   * is a permanent column and there is nothing to pull in — this genuinely
   * does nothing. It used to toggle `railCollapsed` there, which made its
   * chord a second ⌘B that never once touched the explorer — and ⌘B is now
   * this command's own, the rail having folded into the switcher.
   */
  toggleExplorer: () => void;
  /**
   * ⌘\, and the pill on the focus edge.
   *
   * Folds both panels away for the length of a read and restores them exactly
   * as they were — `FrameState.focus` is one boolean *over* the two
   * preferences, not a snapshot of them, so there is no second copy to drift.
   * Nothing on a phone, where there is no panel to fold; `focusToggleFor` owns
   * that, for the reason the other two commands have their own owners.
   */
  toggleFocus: () => void;
  /**
   * The pointer arriving at, or leaving, the folded tree's seam.
   *
   * Hover state rather than a command, which is why it takes the value instead
   * of toggling: two `onHoverOut`s in a row must not bring the peek back. The
   * *delay* before the pointer counts as resting is the seam's business — this
   * is only told the answer.
   */
  setExplorerPeeking: (peeking: boolean) => void;
  closeDrawer: () => void;
  /**
   * Puts away whatever panel is over the editor, and says whether there was
   * one.
   *
   * The scrim's handler, and Escape's. `keymap.ts` promises "Escape closes
   * whatever is open, wherever you are"; the boolean is how a caller keeps
   * that promise honest, returning `false` so the browser's own Escape
   * behaviour survives when nothing was open.
   *
   * It closes the drawer and the peek — the panels this component renders —
   * **and** whatever registered itself through `registerDismissable`,
   * nearest first.
   */
  closeOverlays: () => boolean;
  /**
   * Put a panel this frame does not render into Escape's reach, and take it
   * out again when it unmounts.
   *
   * The promise above was only ever true of the two panels below. A find bar
   * over the note is neither, so ⌘F could open something Escape could not
   * close as soon as focus left the editor — reported, accurately, as "isn't
   * dismissable". A closer answers whether it closed anything, so
   * `closeOverlays` can keep returning an honest boolean.
   *
   * Returns the unregistration, which makes it the whole body of an effect:
   * `useEffect(() => registerDismissable(close), [registerDismissable])`.
   */
  registerDismissable: (close: () => boolean) => () => void;
  setExplorerWidth: (width: number) => void;
  /**
   * True on a phone: choosing a note has to dismiss the drawer, because the
   * drawer is covering the note. False everywhere else — dismissing a permanent
   * region because somebody clicked inside it is how people stop using a tree.
   */
  closesOnSelect: boolean;
  /**
   * How much room a surface inside this frame owes at each edge, in total —
   * the system's furniture *and* the chrome floating over it.
   *
   * On a phone the chrome does not sit in a band the document is kept out of —
   * it lies over the document, and the document runs underneath it. That is
   * how Obsidian draws it, and the giveaway in the reference is at the bottom
   * edge: body text is visible to the left and to the right of the floating
   * pill, on the same lines it covers, because the text column is wider than
   * the bar and simply runs behind it.
   *
   * Which means the *viewport* must not be shrunk to make room for the chrome.
   * A scroller that stops where the toolbar begins has a hard edge across the
   * glass and cannot scroll its last line clear of anything. A scroller that
   * fills the screen and pads its **content** has neither problem.
   *
   * `viewportInsets` below names the part of this sum where the opposite is
   * true. Read them together, through `surfacePadding`; nothing should spend
   * this number on its own.
   *
   * Zero at the top at every other density, where the frame has already padded
   * itself down past the notch and the bars are real regions with their own
   * surfaces.
   */
  contentInsets: { top: number; bottom: number };
  /**
   * The part of `contentInsets` that has to be spent **outside** the scroller.
   *
   * The system's top furniture, and only on a phone. Content padding scrolls
   * away with the content, so an inset spent there keeps the first line clear
   * of the Dynamic Island and lets the twentieth run straight across it — which
   * is exactly what shipped, and exactly what a guard that checked only the
   * resting layout could not see.
   *
   * Zero at every other density, and that is not "nothing to clear": at medium
   * and wide the frame carries `paddingTop: insets.top` itself, so every
   * scroller inside it is already an inset's worth down the glass and paying it
   * again would open a band of ground above the content on every tablet.
   *
   * The bottom is always zero. The home indicator is a thin translucent bar the
   * platform draws over whatever is beneath it, and the phone's own toolbar
   * floats in that same band by design — a shortened viewport there would draw
   * the hard edge across the glass this frame exists not to have.
   */
  viewportInsets: { top: number; bottom: number };
  /**
   * Whether there is a real frame above this, or `useFrame`'s fallback.
   *
   * `contentInsets` is a complete answer — system insets *and* our chrome —
   * only when a frame computed it. The fallback's zeros are not "nothing to
   * clear", they are "nobody asked", and a surface that read them as the first
   * would lay itself out under the notch on every screen outside the console.
   * `surfacePadding` in `frame.ts` is what reads this; see `Screen.tsx`.
   */
  framed: boolean;
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
   *
   * A panel over the editor puts it away for the same reason — see
   * `toolbarHidden` in the frame body — but that one *is* a region rule, and is
   * read off `regions.scrim` rather than kept here.
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
  const fallbackRegions = regionsFor(fallbackDensity, initialFrame);
  return (
    provided ?? {
      density: fallbackDensity,
      regions: fallbackRegions,
      state: initialFrame,
      toggleExplorer: noop,
      toggleFocus: noop,
      setExplorerPeeking: noop,
      closeDrawer: noop,
      closeOverlays: () => false,
      // Nothing outside a provider has a frame to be closed by, so the
      // registration is real and the unregistration is a no-op.
      registerDismissable: () => noop,
      setExplorerWidth: noop,
      closesOnSelect: closesOnSelect(fallbackRegions.explorer),
      contentInsets: NO_CONTENT_INSETS,
      viewportInsets: NO_CONTENT_INSETS,
      framed: false,
      chromeGap: floatingGapFor(0),
      accessoryOpen: false,
      setAccessoryOpen: noop,
    }
  );
}

function noop(): void {}

/**
 * The fallback frame's insets.
 *
 * A frozen object rather than a fresh literal: `useFrame` hands this back to
 * every component mounted outside a provider — the landing page's fake console
 * window, and a hundred-odd tests — and a new object each call is a new `style`
 * array each render for anything that spreads it.
 *
 * It travels with `framed: false`, and that pairing is the whole point. These
 * zeros mean "no frame answered", never "there is nothing at this edge to
 * clear" — outside the console the system's insets are the answer and
 * `surfacePadding` reads them instead.
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
  /**
   * The context switcher, at the leading edge of the top bar. **Pointer
   * layouts only** — at compact the leading edge is `accountSlot` and the
   * contexts are not in this bar at all (see `accountSlot`).
   *
   * It used to travel with a `switcherLabel: string`, and that prop is gone
   * with the control it named. The chip was *pressable* on a phone — it was
   * how the rail sheet came in — and a pressable's accessible name cannot be
   * derived from its content on native: `aria-hidden` is destructured by
   * `View` and not by `Text`, so it is dropped as an unknown prop, and
   * `RCTRecursiveAccessibilityLabel` concatenates every descendant's text
   * regardless — VoiceOver announced "@seyi personal black down-pointing small
   * triangle". Here the chip is not a control at all, so it has no name to
   * spell out, and a prop nothing reads is a prop that goes.
   *
   * **That rule has not expired, it has moved**: every control on the phone's
   * top row now carries an explicit `accessibilityLabel` of its own, and
   * `ContextStrip` states it as one of its three drawing rules. If this slot
   * ever becomes pressable again, the label comes back with it.
   */
  switcher: ReactNode;
  /** Storage chip, avatar — the trailing edge of the top bar. */
  topTrailing?: ReactNode;
  /**
   * **Compact only.** Pinned at the leading end of the phone's top row.
   *
   * The signed-in identity, and whatever it opens. It used to be the account
   * block at the foot of the rail sheet, which is where every application puts
   * it and where nothing on a phone can reach any more — so it comes out to the
   * one corner of the glass that is always visible.
   *
   * **It is the only thing pinned at this edge, and it used to have the
   * contexts beside it.** They were a `contextStrip` slot here: a row of pills
   * in the floating bar, lying over the note. Two things were wrong with that
   * and both were reported from a phone. The bar floats, so the document ran
   * *behind* the pills — a line of body text sliding under a row of chrome,
   * permanently, with no scroll position that clears it. And the strip named
   * the current context one line above a breadcrumb that named it again, so a
   * 390pt screen spent two of its rows saying `@seyi`.
   *
   * The contexts are navigation, so they went to the navigation: they are the
   * first row of `features/console/NavBand.tsx`, inside the scroller, above the
   * path. They scroll away with the document and come back by scrolling up,
   * which is what the person asking for this described. What is left here is
   * the identity and the trailing capsule — Obsidian's own shape for this bar.
   *
   * This slot stays pinned for the reason it always was: it holds the
   * product's only sign-out, and a control you have to scroll to find is one
   * somebody concludes is missing. That is the argument `ConsoleRail` makes
   * about pinning the account block above a scrolling list.
   *
   * `layout.accountAvatar` is the *mark* the geometry is budgeted against and
   * `layout.minTouchTarget` is the pressable around it; the frame imposes
   * neither, because what goes in here is the caller's. On a phone this slot
   * holds the product's only sign-out, so the caller pads to the floor — see
   * `ConsoleRail.AccountBlock`.
   */
  accountSlot?: ReactNode;
  /** Opens the palette. Renders the search field on web, a button on touch. */
  onSearch?: () => void;
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
  accountSlot,
  onSearch,
  explorer,
  status,
  bottomBar,
  children,
}: AppFrameProps) {
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
  // something else — toggling the rail here is what made this a duplicate of
  // ⌘B on every layout that has an explorer column.
  const toggleExplorer = useCallback(() => {
    setState((current) => {
      // A command that names a panel which is not on the screen brings the
      // panels back rather than writing a preference nobody can see change.
      // Leaving focus is the whole of what the first press does — see
      // `toggleFocus`.
      if (current.focus) return { ...current, focus: false };
      /*
        `hasExplorer` decides whether there is anything to fold: it is `false`
        on Map and Connections, and writing `explorerHidden` there would set a
        preference on a pane that cannot show it, discovered later as a missing
        tree back on Browse. `explorerToggleFor` owns that and answers `null`,
        which must stay a genuine no-op — "does nothing" means *nothing*, not
        "does the other command", which is what made this a second ⌘B.
      */
      const field = explorerToggleFor(densityFor(width), { hasExplorer });
      if (field === null) return current;
      // The peek goes with the fold in both directions: opening the column
      // leaves no seam to have been resting on, and closing it must not open
      // straight into a peek the pointer never asked for.
      return { ...current, [field]: !current[field], explorerPeeking: false };
    });
  }, [width, hasExplorer]);

  // Same rule as `toggleExplorer`: `frame.ts` owns what the command means and
  const toggleFocus = useCallback(
    () =>
      setState((current) => {
        if (!focusToggleFor(densityFor(width))) return current;
        return { ...current, focus: !current.focus, explorerPeeking: false };
      }),
    [width],
  );
  /*
    Idempotent on purpose. The seam sends `false` on hover-out and the peek
    panel sends `false` when the pointer leaves it too, so the same value
    arrives twice on the way out of one gesture; returning `current` is what
    keeps that from being a second render of the whole frame.
  */
  const setExplorerPeeking = useCallback(
    (peeking: boolean) =>
      setState((current) =>
        current.explorerPeeking === peeking ? current : { ...current, explorerPeeking: peeking },
      ),
    [],
  );
  const closeDrawer = useCallback(
    () => setState((current) => (current.drawerOpen ? { ...current, drawerOpen: false } : current)),
    [],
  );
  /**
   * The panels this frame does not render, newest registration last.
   *
   * A ref rather than state: nothing on screen depends on the list, and a
   * render per editor mount on the console's most expensive route is a price
   * for nothing. `closeOverlays` reads it at press time, which is also the only
   * moment the answer is knowable.
   */
  const dismissables = useRef<(() => boolean)[]>([]);
  const registerDismissable = useCallback((close: () => boolean) => {
    dismissables.current = [...dismissables.current, close];
    return () => {
      dismissables.current = dismissables.current.filter((one) => one !== close);
    };
  }, []);
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
    /*
      Nearest first, which is last registered first: a find bar lies over the
      note inside the drawer's console, so one Escape must not take both. The
      loop stops at the first closer that actually closed something — the rest
      are further away, and a person pressing Escape means the thing in front
      of them.

      Read into a local first: a closer is free to unmount the thing it closed,
      which unregisters it, and `registerDismissable` answers that by replacing
      the array rather than splicing it. Iterating the live `.current` would
      then walk a different list than it started on, and skip the panel behind
      the one that just went away.
    */
    const registered = dismissables.current;
    for (let at = registered.length - 1; at >= 0; at -= 1) {
      if (registered[at]?.() === true) return true;
    }
    /*
      Then the frame's own panels, which are the outermost thing Escape can
      reach and so genuinely the last resort — including the two the folding
      tree added. The peek is over the editor and focus mode has taken the
      panels away, and Escape is the key everybody tries for either.
    */
    const wasOpen = state.drawerOpen || state.explorerPeeking || state.focus;
    if (wasOpen)
      setState((current) => ({
        ...current,
        drawerOpen: false,
        explorerPeeking: false,
        focus: false,
      }));
    return wasOpen;
  }, [state.drawerOpen, state.explorerPeeking, state.focus]);
  const setExplorerWidth = useCallback(
    (next: number) =>
      setState((current) => ({ ...current, explorerWidth: clampExplorerWidth(next) })),
    [],
  );

  const compact = density === "compact";

  /**
   * Whether there is a folded tree here that a seam could bring back.
   *
   * Asked of `explorerToggleFor` rather than re-derived, because it is the same
   * question the command asks and the answer has to be one answer: a control
   * that folds where ⌘B does nothing is a button that lies, and a control that
   * does not exist where ⌘B works is a chord nobody can discover.
   *
   * It says `null` on a phone, which has no left panel at all, and on Map and
   * Connections, which have no tree — and both of those were drawing a closed
   * seam until a render test caught it. Focus is excluded on top: the tree is
   * hidden there too, but by a mode that owns its own way back, and a seam
   * offering to restore one of the two panels would be a third thing to put the
   * layout right with.
   */
  const explorerFoldable =
    explorerToggleFor(density, { hasExplorer }) !== null && !state.focus;

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

  /**
   * Whether the bottom toolbar is put away, and the two reasons it is.
   *
   * The first is the keyboard accessory bar — see `FrameApi.accessoryOpen`.
   *
   * The second is a panel over the editor, and it is the same argument one step
   * out: the toolbar's five actions (back, forward, search, new, save) all act
   * on the **note**, and while the tree drawer or the rail sheet is up the note
   * is the thing behind the panel. The panel brings its own row of verbs and
   * the reference draws no bar under it. Two floating bars over one surface,
   * one of them addressed to a document you cannot see, is worse than either.
   *
   * `regions.scrim` rather than `state.drawerOpen || state.navOpen` because
   * `frame.ts` is the single owner of "some panel is over the editor" — it
   * already resolves the pair that can never be up together, and it is false at
   * every density that has no bottom bar anyway.
   *
   * **`regions.scrim` is false at every density today**, so the live arm is
   * `accessoryOpen` and the paragraph above describes a case that cannot occur.
   * It is kept for the reason `frame.ts`'s own enumeration keeps the panels
   * representable, and it is left as the second operand rather than deleted so
   * that the day a density puts a panel back this line already says the right
   * thing. Nobody was stranded by it when it did fire: the panel's own ×, the
   * toggle on the sliver of note, and a tap through the scrim each brought the
   * bar straight back.
   */
  const toolbarHidden = accessoryOpen || regions.scrim;

  /*
    Tell anything mounted *above* this frame how much floating chrome is lying
    along the bottom edge, so it can stack rather than land on top of it. The
    only such thing today is the persistent recording bar, which is mounted at
    the root of `(app)` precisely so that it is visible on screens — like this
    one — that know nothing about meetings. See `bottomChrome.ts`; the condition
    is the same one the toolbar itself renders under, so a bar hidden by the
    keyboard accessory stops being reserved for at the same moment.
  */
  const bottomBarShowing = regions.bottomBar && bottomBar != null && !toolbarHidden;
  useEffect(() => {
    setBottomChromeHeight(bottomBarShowing ? layout.bottomBarHeight : 0);
    return () => setBottomChromeHeight(0);
  }, [bottomBarShowing]);

  /*
    A pointer layout is not "no insets" — it is "the frame already paid the
    top". `styles.frame` carries `paddingTop: insets.top` there, so a surface
    inside owes nothing at that edge; the bottom is a different matter, because
    the bottom bar is a phone region and on a tablet in portrait nothing else
    reaches the home indicator. Reporting the two edges separately is what lets
    `surfacePadding` be one formula rather than a density check at every call
    site.
  */
  const hasBottomBar = regions.bottomBar && bottomBar != null;
  /**
   * The band a surface must hold back from its scroller, rather than pad its
   * content by. See `FrameApi.viewportInsets`.
   *
   * Only the top, and only on a phone: at every other density `styles.frame`
   * already carries `paddingTop: insets.top`, which is an ancestor of every
   * scroller in the frame and has therefore already shortened all of them.
   */
  const viewportInsets = useMemo(
    () => (compact ? { top: insets.top, bottom: 0 } : NO_CONTENT_INSETS),
    [compact, insets.top],
  );
  const contentInsets = useMemo(
    () =>
      compact
        ? {
            top: insets.top + layout.chromeButton + space.x3,
            bottom: hasBottomBar
              ? layout.bottomBarHeight + layout.floatingInset + chromeGap
              : /*
                  Map, Connections and Settings have no toolbar, so there is
                  nothing floating at this edge and the home indicator is the
                  whole of what a surface owes. Reserving the toolbar's 110pt
                  anyway would leave a hand's width of empty ground under the
                  last card on the three panes signing in lands you on.
                */
                insets.bottom,
          }
        : { top: 0, bottom: insets.bottom },
    [compact, insets.top, insets.bottom, chromeGap, hasBottomBar],
  );

  const api = useMemo<FrameApi>(
    () => ({
      density,
      regions,
      state,
      toggleExplorer,
      toggleFocus,
      setExplorerPeeking,
      closeDrawer,
      closeOverlays,
      registerDismissable,
      setExplorerWidth,
      closesOnSelect: closesOnSelect(regions.explorer),
      contentInsets,
      viewportInsets,
      framed: true,
      chromeGap,
      accessoryOpen,
      setAccessoryOpen,
    }),
    [
      density,
      regions,
      state,
      toggleExplorer,
      toggleFocus,
      setExplorerPeeking,
      closeDrawer,
      closeOverlays,
      registerDismissable,
      setExplorerWidth,
      contentInsets,
      viewportInsets,
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
          {/*
            The phone's top row, in two parts: a pinned account mark and the
            trailing capsule. The contexts were the third and are now the first
            row of the navigation band inside the scroller — see `accountSlot`.

            **Two controls used to be here and both are gone with the panels.**
            A round drawer toggle at the leading edge pulled the file tree in —
            and crossed to the sliver of note when it did, so it did not lie on
            the panel it had opened — and the switcher chip pulled the rail in
            where no file tree was there to carry it at its foot. `frame.ts`
            answers `false` to both toggles at every density now, so what is
            left is not a bar with two buttons and a gap: it is a row of slots,
            and the middle one is a list.

            At medium and wide the switcher is unchanged and still the leading
            element of a real bar with a surface and a hairline.
          */}
          {topBarLeadFor(density) === "account" ? (
            <>
              {accountSlot == null ? null : (
                /*
                  Pinned, and alone at this edge. The contexts used to sit
                  beside it and are now the first row of the navigation band
                  inside the scroller — see the prop.
                */
                <View style={styles.accountLead}>{accountSlot}</View>
              )}
            </>
          ) : (
            <View style={styles.topLead}>{switcher}</View>
          )}

          {/*
            The trailing slot, which on a phone is **the** grouped container.

            Obsidian's top bar is exactly two objects: a rounded-square sidebar
            toggle at the leading edge, and one rounded container at the
            trailing edge holding the actions for what is on screen — the book
            and the ⋯ in the reference. Nothing in the middle. So at compact
            this is a floating capsule with the same surface and shadow the
            toggle has, and whatever `_layout` puts in it sits inside that one
            container rather than bringing a box of its own.

            It used to wrap its chips in a bordered, filled pill *and* let each
            chip draw its own border — three nested rounded boxes for two
            words. The chips themselves are gone from here: identity and the
            storage binding are facts about the context, and they live at the
            foot of the file tree where Obsidian puts the vault switcher.

            At every other density the bar has its own surface and its own
            hairline, the chips have room, and a container around them would be
            a box in a box — so `topTrail` alone, unfilled.
          */}
          {/*
            The trailing group, and search is part of it.

            Search sits in the top bar where there is a pointer and in the
            bottom toolbar where there is a thumb — rendering it in both would
            put the same control twice on the screen with least room. What
            changed is *where* in the bar: it was centred, on its own
            `marginLeft: "auto"`, which put two auto margins in one row and
            split the free space between them — so it sat in the middle of the
            band looking like a browser's omnibox rather than beside the other
            actions. One group, one push to the trailing edge, and the centre
            of the bar is free for what belongs there.
          */}
          {topTrailing == null && !(onSearch && !compact) ? null : (
            <View style={[styles.topTrail, compact && styles.topTrailCompact]}>
              {onSearch && !compact ? <SearchTrigger onPress={onSearch} /> : null}
              {topTrailing}
            </View>
          )}
        </View>

        <View style={styles.body}>
          {regions.explorer === "column" ? (
            <View style={[styles.explorerColumn, { width: state.explorerWidth }]}>
              {explorer}
              <ExplorerResizer
                width={state.explorerWidth}
                onResize={setExplorerWidth}
                onClose={toggleExplorer}
              />
            </View>
          ) : null}

          {/*
            What is left where the tree was: a seam that is wider than the one
            between two panels, because it is the only thing standing where a
            whole column stood, and because it is a control rather than a rule.

            Drawn for `peek` as well as `hidden` — the peek floats *over* the
            editor and does not take the seam's place, so the seam has to stay
            put underneath it or the pointer resting on it would be resting on
            nothing and the peek would close the instant it opened.
          */}
          {explorerFoldable && (regions.explorer === "hidden" || regions.explorer === "peek") ? (
            <ClosedExplorerSeam
              peeking={regions.explorer === "peek"}
              onOpen={toggleExplorer}
              onPeek={setExplorerPeeking}
            />
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

          {/*
            The peek: the folded tree, back over the editor while the pointer
            rests on its seam.

            **Absolutely positioned rather than a flex sibling, which is the
            point of it.** A panel that took part in the row would push the
            editor across every time the pointer crossed the seam, and the
            paragraph somebody is reading would jump under their eyes. This
            floats, so nothing reflows, and the note stays exactly where it was
            — which is what makes folding the tree away a cheap decision rather
            than a commitment.

            No scrim, deliberately, and that is why `peek` is its own arm of
            `Regions.explorer` rather than the `drawer` with the scrim
            suppressed: it is dismissed by moving the pointer away, and a scrim
            would grey out and make inert the note being peeked at in order to
            reach.

            `left` is arithmetic on tokens rather than a measurement, so it is
            correct on the first frame. Measuring the rail would put the panel
            at zero for a frame and slide it into place, which reads as a bug.
          */}
          {regions.explorer === "peek" ? (
            <Pressable
              style={[
                styles.explorerPeek,
                styles.panelRounded,
                {
                  left: layout.seamWidth + layout.seamClosedWidth,
                  width: state.explorerWidth,
                },
              ]}
              /*
                The pointer leaving the panel ends the peek, exactly as it
                leaving the seam does. Both send `false`, and `setExplorerPeeking`
                is idempotent so the pair costs one render rather than two.
              */
              onHoverOut={() => setExplorerPeeking(false)}
              onHoverIn={() => setExplorerPeeking(true)}
              /*
                A hover surface, so not a tab stop. `Pressable` gives every
                instance a `tabIndex` and the scrim a few lines down states the
                rule this would otherwise break: labelled and roleless, a screen
                reader announces a stop it cannot describe — and this one would
                be roleless *and* nameless, sitting between the rail and the
                note. The tree inside carries the semantics; this only carries
                the pointer.

                `tabIndex` rather than `focusable`: react-native-web's
                `Pressable` reads the first and ignores the second, so the
                obvious spelling compiles, renders `tabindex="0"` anyway, and is
                only caught by asserting the attribute.
              */
              tabIndex={-1}
              testID="explorer-peek"
            >
              {explorer}
            </Pressable>
          ) : null}

          {/*
            Focus mode's way back.

            A strip of the leading edge that draws nothing and holds a pill once
            the pointer arrives, because the edge of the window is where a hand
            goes looking for a panel that was there a moment ago. ⌘\ and Escape
            both do the same thing; this is for the hand that reaches before it
            remembers.
          */}
          {state.focus && !compact ? <FocusEdge onLeave={toggleFocus} /> : null}

          {regions.explorer === "drawer" ? (
            <View
              /*
                A panel is full height now, because the body is: the chrome
                floats over it rather than sitting above it. So the panel runs
                from the top of the glass to the bottom, the way Obsidian's
                sidebar does, and pays for what is over it in padding — the top
                clears the status bar, the bottom the home indicator.

                **The toolbar is not at that edge while this is up** — see
                `toolbarHidden` — so the bottom is `insets.bottom` rather than
                `contentInsets.bottom` at both densities. Reserving the
                toolbar's band anyway would put a hand's width of dead panel
                under the count line, which is the second half of the same bug:
                the bar was drawn there *and* paid for there.

                **It does not clear the toggle**, and that was 34pt of dead
                space above the first row of the tree — measured at 126pt
                against the reference's 92. The toggle crossed to the sliver of
                note the moment a panel was up, so it was not over this surface
                at all; paying `contentInsets.top` here was reserving room for a
                control that had moved out of the way. `panelGutter` is what is
                left: the air Obsidian leaves between the status bar and its
                first row.

                The toggle itself is gone, along with the style this once cited
                by name (`toggleOnSliver`, which no longer exists as a symbol
                anywhere). A phone has no panel to raise, so nothing raises one.
                The arithmetic is unchanged and is kept in the past tense.

                All of it is on the panel rather than inside the tree's own
                scroller, which is what keeps rows from riding up under the
                clock once the tree is longer than the glass.
              */
              style={[
                styles.drawer,
                compact && styles.panelRounded,
                compact
                  ? {
                      paddingTop: insets.top + layout.panelGutter,
                      paddingBottom: insets.bottom,
                    }
                  : { paddingBottom: insets.bottom },
              ]}
              accessibilityViewIsModal
              testID="frame-drawer"
            >
              {explorer}
            </View>
          ) : null}

        </View>

        {regions.statusBar && status ? (
          <View style={styles.status}>
            {/*
              The two panel toggles, at the leading edge where VS Code, Zed and
              every editor with a foldable sidebar put them.

              They are the frame's own and not part of the `status` node
              because they are geometry, which is the only thing this component
              knows about — the counts and the save state beside them belong to
              whatever is in the editor.

              Two controls for one action, with the seam, is deliberate and the
              split is clean: **the seam is the gesture and the status bar is
              the state**. The seam costs nothing at rest because it is only
              revealed under the pointer, and a person who has folded something
              away and forgotten what needs somewhere that never moves to look.
              It is also the only one of the two a keyboard can reach by
              tabbing, and the only one left standing in focus mode.
            */}
            {hasExplorer ? (
              <PanelToggle
                testID="status-toggle-explorer"
                label="File tree"
                chord="⌘B"
                state={regions.explorer === "column" ? "open" : "off"}
                onPress={toggleExplorer}
              />
            ) : null}
            <View style={styles.statusDivider} />
            {status}
          </View>
        ) : null}

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
          Not while the keyboard accessory bar is up — see `toolbarHidden`. The
          reference has no bottom bar in either screenshot, and two floating bars
          in the same 66pt of glass is worse than either.

          `toolbarHidden`'s other arm is `regions.scrim`, which is false at every
          density now that no panel comes in over the editor. It is still read
          rather than dropped, for the reason `frame.ts`'s enumeration gives for
          keeping the panels representable at all; what is corrected here is a
          comment that named the dead arm first, as if the common case were a
          drawer rather than the keyboard.
        */}
        {bottomBarShowing ? (
          <View
            style={[
              styles.bottomBar,
              {
                paddingTop: layout.floatingInset,
                paddingBottom: chromeGap,
                /*
                  The sliver of note showing either side, from here rather than
                  from whatever the bar happens to contain. See
                  `layout.bottomBarInset`: sizing the pill to its own controls
                  made the gap a function of how many actions the current route
                  has, so a context somebody is only a member of — no New note —
                  drew the bar 78pt in on a screen where the reference is 52.

                  **It is 24, and this comment said 52.** That was the
                  measurement off the reference and it is what the token *was*;
                  the seventh key was bought with it, because seven targets do
                  not clear the touch floor inside a pill inset by 52. The
                  number is not repeated here at all now — the token is the one
                  place it lives, and a second spelling of it is how the two
                  drift.
                */
                paddingHorizontal: layout.bottomBarInset,
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
      {Platform.OS === "web" ? (
        <Text variant="treeMeta" style={styles.kbd}>
          ⌘K
        </Text>
      ) : (
        <Text variant="rowSub">Search</Text>
      )}
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
  round = false,
  grouped = false,
  testID,
}: {
  label: string;
  icon: IconName;
  onPress: () => void;
  /*
    There is no `selected` here, and its removal is the point rather than a
    tidy-up. It lit this button with `accentDim` for exactly one caller — the
    note's read toggle — on the argument that one mark cannot draw both "will
    hide the markup" and "will bring it back", so the state had to live in the
    fill. That toggle now swaps its glyph between `eye` and `pencil`, which says
    the same thing in the place a reader is already looking, and a lit *pencil*
    would have contradicted it: a lit control here means "this mode is on",
    while the pencil means "press to start editing". The prop went with its last
    caller rather than staying as a facility nobody uses and the next person has
    to reason about. See `docs/decisions/app-and-console.md`.
  */
  /** The phone's shape: a filled circle lying over the document. */
  round?: boolean;
  /**
   * Inside the top bar's trailing capsule: a phone-sized target with no
   * surface of its own.
   *
   * The container is the object — one fill, one radius, one shadow, however
   * many actions are in it — so a button that brought its own would be the
   * nested-rounded-box defect this branch removed from the other corner. It
   * still clears `minTouchTarget`, because the target is what a thumb hits and
   * the capsule around it is only what a reader sees.
   */
  grouped?: boolean;
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
        grouped && styles.iconButtonGrouped,
        round && styles.iconButtonRound,
        // `iconButtonHover` tints an untinted square; on a filled circle it
        // would paint `surface3` *over* `chrome`, which is darker than the
        // resting state and reads as the control switching off. The circle
        // lights the way it does under a thumb instead — this is reachable on
        // a narrowed desktop browser, which is a real surface here.
        hovered && (round ? styles.iconButtonPressed : styles.iconButtonHover),
        (round || grouped) && pressed && styles.iconButtonPressed,
      ]}
    >
      <Icon name={icon} size={round || grouped ? 20 : 17} color={colors.text2} />
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
  onClose,
}: {
  width: number;
  onResize: (next: number) => void;
  /** Called on release, when the drag went far enough past the floor. */
  onClose: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const [active, setActive] = useState(false);
  /**
   * Whether releasing now would fold the column away.
   *
   * **The clamp is not weakened by this and that is the whole of the design.**
   * `clampExplorerWidth` still refuses to render anything below the floor,
   * because the floor is where a kebab-case name under two indents stops being
   * readable. What it used to do past that point was simply refuse, and its
   * comment gave the reason: dragging to zero is how somebody hides a region
   * and then wonders where it went. That reason is answered now by the seam
   * that stays behind, so the drag can mean something past the floor instead of
   * meeting a wall — it arms, it says so, and releasing above the floor snaps
   * back.
   */
  const [arming, setArming] = useState(false);
  const armed = useRef(false);

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
  /*
    `onClose` goes through a ref for the reason above, which applies to it more
    sharply than to `onResize`. `setExplorerWidth` is stable; `toggleExplorer`
    is not — it closes over the window width — so listing it here would rebuild
    the responder on any resize, and the paragraph above is about what a rebuild
    mid-gesture costs. The deps stay "nothing a drag can change", which is the
    invariant, rather than "nothing a drag happens to change today".
  */
  const liveClose = useRef(onClose);
  useEffect(() => {
    liveClose.current = onClose;
  }, [onClose]);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          startWidth.current = liveWidth.current;
          setActive(true);
        },
        onPanResponderMove: (_event, gesture) => {
          const raw = startWidth.current + gesture.dx;
          /*
            The *raw* width decides whether the close is armed, and the clamped
            one is what gets rendered. Reading the clamped value here would make
            this unreachable: it can never be below the floor, so the drag would
            arm at exactly the moment it stopped being able to.
          */
          const next = raw < layout.explorerMinWidth - layout.explorerCloseOvershoot;
          if (next !== armed.current) {
            armed.current = next;
            setArming(next);
          }
          onResize(raw);
        },
        onPanResponderRelease: () => {
          setActive(false);
          if (armed.current) liveClose.current();
          armed.current = false;
          setArming(false);
        },
        /*
          A terminated gesture is not a release. The pointer was taken away by
          something else — a browser drag, a lost capture — and folding a panel
          on the strength of that is the surprise this whole design is trying
          not to be, so it only disarms.
        */
        onPanResponderTerminate: () => {
          setActive(false);
          armed.current = false;
          setArming(false);
        },
      }),
    [onResize],
  );

  return (
    <View
      {...responder.panHandlers}
      style={[styles.resizer, active && styles.resizerActive, arming && styles.resizerArming]}
      accessibilityLabel="Resize the file tree"
      role="separator"
      testID="explorer-resizer"
    >
      {/*
        A marker, not a button, and that is the one real constraint this seam
        has. A press target in the middle of a drag handle takes the most
        natural place to grab a divider and makes it do something else — so the
        seam behind a resizable panel drags, the seam behind a folded or
        fixed-width one is pressed, and the status bar carries the toggle that
        works the same way for both. What this draws is the answer to "what will
        releasing do", which only a drag can ask.
      */}
      {arming ? <View style={styles.seamArmMark} testID="explorer-seam-arming" /> : null}
    </View>
  );
}

/**
 * The seam left standing where the folded tree was.
 *
 * Two controls in one 10pt strip, and they are different gestures on purpose:
 * **pressing** it brings the column back for good, **resting** on it brings the
 * tree back for as long as the pointer stays. One is a decision and the other
 * is a glance, and a person who only wants to check where a note lives should
 * not have to reflow their editor twice to do it.
 *
 * The delay before a rest counts is what keeps a pointer crossing the seam on
 * its way somewhere else from opening anything.
 */
function ClosedExplorerSeam({
  peeking,
  onOpen,
  onPeek,
}: {
  peeking: boolean;
  onOpen: () => void;
  onPeek: (peeking: boolean) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const [hovered, setHovered] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancel = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  /*
    A pending timer outliving the component would call `onPeek` on a frame that
    is gone — which is what happens every time somebody navigates from Browse to
    Map with the pointer sitting on this seam.
  */
  useEffect(() => cancel, [cancel]);

  return (
    <Pressable
      style={[styles.seamClosed, (hovered || peeking) && styles.seamClosedActive]}
      onPress={() => {
        cancel();
        onOpen();
      }}
      onHoverIn={() => {
        setHovered(true);
        cancel();
        timer.current = setTimeout(() => onPeek(true), PEEK_DELAY_MS);
      }}
      /*
        Hovering out cancels a pending peek but does not close one that is
        already up: the pointer leaving this seam is usually the pointer moving
        *onto* the panel that opened beside it, and closing here would make the
        peek impossible to reach. The panel reports its own exit.
      */
      onHoverOut={() => {
        setHovered(false);
        cancel();
      }}
      role="button"
      accessibilityLabel="Open the file tree"
      testID="explorer-seam-closed"
    >
      <SeamPill shown={hovered || peeking} direction="expand" />
    </Pressable>
  );
}

/**
 * How long the pointer has to rest on the closed seam before the tree peeks.
 *
 * Short enough to feel like a property of the seam rather than a wait; long
 * enough that crossing it on the way to the editor opens nothing. Exported for
 * the render test, which drives it with fake timers rather than guessing.
 */
export const PEEK_DELAY_MS = 300;

/**
 * The chevron centred on a seam, revealed under the pointer.
 *
 * A drawing rather than a control: the seam it sits on is the button, and one
 * press target inside another is how a click lands on the wrong one. It is
 * rendered at `opacity: 0` rather than not at all so that revealing it is a
 * fade and not a layout change under the pointer that caused it.
 */
function SeamPill({ shown, direction }: { shown: boolean; direction: "collapse" | "expand" }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <View
      style={[styles.seamPill, shown && styles.seamPillShown]}
      /*
        **A drawing must not take pointer events, and this one was.** The pill is
        18pt wide on a 7pt or 10pt seam — deliberately, because a chevron inside
        a hairline is unreadable — so it overhangs its own seam by several points
        on each side. As a plain child it therefore sat *on top of* whatever was
        next to it: with the tree folded, the closed seam's pill covered the
        rail's seam, and clicking the rail's seam re-opened the file tree
        instead. Found by the browser fixture; jsdom has no pointers to
        intercept, so nothing in the render suite could have seen it.
      */
      pointerEvents="none"
    >
      <Icon
        name={direction === "expand" ? "chevronRight" : "chevronLeft"}
        size={12}
        color={colors.text2}
      />
    </View>
  );
}

/**
 * The leading edge in focus mode, and the pill that ends it.
 *
 * Nothing is drawn until the pointer arrives. The strip exists because the edge
 * of the window is where a hand goes for a panel that was there a moment ago,
 * and finding the note there instead is the moment somebody decides the mode
 * ate their sidebar.
 */
function FocusEdge({ onLeave }: { onLeave: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [near, setNear] = useState(false);
  return (
    <Pressable
      style={styles.focusEdge}
      onHoverIn={() => setNear(true)}
      onHoverOut={() => setNear(false)}
      onPress={onLeave}
      role="button"
      accessibilityLabel="Bring the panels back"
      testID="frame-focus-edge"
    >
      {near ? (
        <View style={styles.focusExit} testID="frame-focus-exit">
          <Icon name="panelLeft" size={14} color={colors.text2} />
          <Text variant="treeMeta">Panels</Text>
          <Text variant="treeMeta">⌘\</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

/**
 * One of the two panel toggles in the status bar.
 *
 * Draws the layout rather than naming it: a cell for the panel and a wider one
 * for the document, so the glyph is a two-pane picture that fills in when the
 * panel is out and thins to a bar when the rail is down to its icons. A word
 * would be just as clear and twice as wide, and this bar is 26pt tall.
 */
function PanelToggle({
  state,
  label,
  chord,
  onPress,
  testID,
}: {
  state: "open" | "half" | "off";
  label: string;
  chord: string;
  onPress: () => void;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      style={[styles.panelToggle, hovered && styles.panelTogglePressed]}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      role="switch"
      aria-checked={state === "open"}
      accessibilityLabel={`${label} (${chord})`}
      testID={testID}
    >
      <View style={styles.toggleGlyph}>
        <View
          style={[styles.toggleCell, state === "open" && styles.toggleCellOn]}
        />
        <View style={styles.toggleDoc} />
      </View>
    </Pressable>
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
    // The title bar is chrome and reads as chrome by being chrome-coloured;
    // the rule under it was the same line doing a value's job.
    backgroundColor: colors.chromeSurface,
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
  /**
   * The account mark, pinned at the leading end of a phone's top row.
   *
   * `flexShrink: 0` is the pin: it is the first child of a row whose second
   * child is a list, and a flex child that may shrink is one the list squeezes
   * the moment somebody joins a fourth workspace. The strip is what gives way,
   * because the strip is what scrolls.
   */
  accountLead: { flexGrow: 0, flexShrink: 0 },
  topTrail: {
    marginLeft: "auto",
    flexDirection: "row",
    alignItems: "center",
    gap: space.x2,
  },
  /**
   * Obsidian's trailing group: one floating capsule, however many actions.
   *
   * The same surface, radius and shadow as the toggle opposite it, because
   * they are the same kind of object — chrome lying on the note rather than a
   * bar drawn across it. `chromeButton` is the height so the two corners of the
   * screen match; `space.x1` of padding either side because the targets inside
   * are already `chromeButton` wide and the capsule only has to close around
   * them.
   *
   * `gap: 0` on purpose: the actions inside are full touch targets that meet,
   * which is how the reference's book and ⋯ sit — one container, no gutters
   * inside it.
   */
  topTrailCompact: {
    gap: 0,
    minHeight: layout.chromeButton,
    paddingHorizontal: space.x1,
    borderRadius: radii.pill,
    backgroundColor: colors.chrome,
    boxShadow: shadows.floating,
  },

  search: {
    /*
      A control at the trailing edge, not a field across the middle.

      It was a 420pt bordered input centred in the title bar — browser
      furniture, and the widest object in the band, for a feature whose whole
      interface is a keystroke. Centred, it also forced the band into three
      fixed slots, so there was nowhere for tabs to go. As a button beside the
      other actions it costs about 60pt and gives the centre back.

      The label goes with the width: on web the shortcut *is* the label, and a
      magnifier beside it says what it opens. Native keeps a word, having no
      shortcut to show.
    */
    flexDirection: "row",
    alignItems: "center",
    gap: space.x2,
    height: 28,
    paddingHorizontal: space.x2,
    borderRadius: radii.sm,
    backgroundColor: "transparent",
  },
  searchHover: { backgroundColor: colors.surface3 },
  kbd: { color: colors.muted },

  /** The three columns. `flex: 1` plus `minHeight: 0` is what makes the
      children scroll instead of the frame growing past the viewport. */
  body: {
    flex: 1,
    minHeight: 0,
    flexDirection: "row",
    position: "relative",
  },

  /*
    No border. The explorer and the page were both `surface` — one value across
    two regions — so a hairline had to be drawn between them to say they were
    different things. They are different values now (`chromeSurface` against
    `pageSurface`), which is what separates panels in this design; the only
    hairlines left in the frame are the seams, and a seam is a 7pt drag target
    that has to be visible to be usable.
  */
  explorerColumn: {
    backgroundColor: colors.chromeSurface,
    position: "relative",
  },

  editor: { flex: 1, minWidth: 0, backgroundColor: colors.pageSurface },

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
  /** Past the floor: releasing here folds the column away rather than snapping back. */
  resizerArming: { backgroundColor: colors.warnWash },
  /** The bar drawn inside an arming seam, so the state is visible and not only felt. */
  seamArmMark: {
    position: "absolute",
    top: "50%",
    left: 1,
    width: 5,
    height: layout.seamPillHeight,
    marginTop: -layout.seamPillHeight / 2,
    borderRadius: radii.xs,
    backgroundColor: colors.warn,
  },

  /**
   * The seam between two panels.
   *
   * A hairline the layout needed anyway, drawn as a border rather than a fill so
   * that at rest it is exactly the rule it replaced — the control costs nothing
   * on the screen until a pointer goes looking for it.
   */
  seam: {
    width: layout.seamWidth,
    borderRightWidth: 1,
    borderRightColor: colors.line,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
    ...(Platform.OS === "web" ? ({ cursor: "pointer" } as unknown as ViewStyle) : null),
  },
  seamHot: { borderRightColor: colors.accent },

  /**
   * The seam left where a folded panel was: wider, and lit.
   *
   * Wider because it is the only thing standing where a whole column stood, and
   * because it is a control rather than a rule — 7pt is a comfortable target
   * beside something; 10pt is a comfortable target beside nothing.
   */
  seamClosed: {
    width: layout.seamClosedWidth,
    borderRightWidth: 1,
    borderRightColor: colors.line,
    /*
      `surface3`, not `surface2`, and the difference is the whole point of the
      strip. On the light palette `surface2` is #FAFAFA against a #FFFFFF
      ground — a browser check showed it reading as nothing at all, so the only
      thing saying a panel could come back was a hairline indistinguishable
      from the rule between two columns. A recessed strip says "there is
      something here" before anybody hovers it.
    */
    backgroundColor: colors.surface3,
    alignItems: "center",
    justifyContent: "center",
    ...(Platform.OS === "web" ? ({ cursor: "pointer" } as unknown as ViewStyle) : null),
  },
  seamClosedActive: { backgroundColor: colors.accentDim, borderRightColor: colors.accent },

  seamPill: {
    width: layout.seamPillWidth,
    height: layout.seamPillHeight,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.chrome,
    alignItems: "center",
    justifyContent: "center",
    /*
      Drawn and invisible rather than absent, so that revealing it is a fade
      rather than a node appearing under the pointer that caused it — and so the
      seam's own width never changes, which would move the editor.
    */
    opacity: 0,
    boxShadow: shadows.floating,
  },
  seamPillShown: { opacity: 1 },

  /**
   * The peek: the folded tree, over the editor rather than beside it.
   *
   * Absolute, so nothing reflows when it arrives — see the branch that renders
   * it. `left` and `width` are supplied there; everything that is a constant is
   * here.
   */
  explorerPeek: {
    position: "absolute",
    top: 0,
    bottom: 0,
    backgroundColor: colors.surface,
    zIndex: 2,
    boxShadow: shadows.floating,
  },

  /** The warm strip down the leading edge in focus mode. Draws nothing itself. */
  focusEdge: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    width: layout.focusEdgeWidth,
    zIndex: 3,
  },
  focusExit: {
    position: "absolute",
    top: space.x4,
    left: space.x3,
    flexDirection: "row",
    alignItems: "center",
    gap: space.x2,
    paddingHorizontal: space.x3,
    paddingVertical: space.x2,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.chrome,
    boxShadow: shadows.floating,
  },

  /**
   * A panel toggle in the status bar: a two-cell picture of the layout.
   *
   * The panel, then the document. Filled when the panel is out, a thin bar when
   * the rail is down to its icons, empty when it is folded away — so the glyph
   * is the layout rather than a label for it, which is what fits in 26pt.
   */
  panelToggle: {
    height: layout.statusBarHeight - 8,
    paddingHorizontal: space.x2,
    borderRadius: radii.xs,
    alignItems: "center",
    justifyContent: "center",
  },
  panelTogglePressed: { backgroundColor: colors.surface3 },
  toggleGlyph: { flexDirection: "row", alignItems: "center", gap: 1 },
  toggleCell: {
    width: 4,
    height: 11,
    borderRadius: 1,
    borderWidth: 1,
    borderColor: colors.lineStrong,
  },
  toggleCellOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  toggleDoc: { width: 8, height: 11, borderRadius: 1, backgroundColor: colors.line },
  statusDivider: {
    width: 1,
    height: 12,
    marginHorizontal: space.x2,
    backgroundColor: colors.line,
  },

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
  /*
    `navToggle`, `navToggleCompact` and `navTogglePressed` were here, and are
    gone. They dressed the control that pulled the rail in: a stretched 44pt
    target on a pointer layout, and on a phone a shadowed white capsule around
    the context chip. `frame.ts` answers `navToggle: false` at every density
    now — a phone's navigation is the context strip and the seventh key, and a
    pointer layout has the rail as a permanent column — so all three had zero
    render call sites.

    They are a deletion rather than a survivor, which is the distinction
    `frame.ts`'s "what is deliberately kept" list exists to make: the `sheet`
    and `drawer` arms of `Regions` are kept because callers outside this feature
    hold the API that raises them, and a *drawing* of a control no density asks
    for is held by nobody. `Explorer`'s `touch` fork went the same way.

    They outlived their control because prose kept describing them:
    `console/_layout.tsx` explained that it dropped the switcher chip's own
    border because `navToggleCompact` "already draws a shadowed white capsule
    around it". Nothing drew one, and the style it named was unreachable — which
    also made the `switcherCompact` it was justifying unreachable, since a phone
    renders no switcher at all.
  */
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
  /** See `grouped`: the target, without the surface its container already has. */
  iconButtonGrouped: {
    width: layout.chromeButton,
    height: layout.chromeButton,
    borderRadius: radii.pill,
  },
  iconButtonHover: { backgroundColor: colors.surface3 },
  iconButtonPressed: { backgroundColor: colors.chromePressed },
});
