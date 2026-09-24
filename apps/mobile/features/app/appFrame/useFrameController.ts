import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { layout, space } from "../../design/tokens";
import {
  asideToggleFor,
  clampAsideWidth,
  clampExplorerWidth,
  closesOnSelect,
  densityFor,
  explorerToggleFor,
  floatingGapFor,
  focusToggleFor,
  initialFrame,
  lightsInBarFor,
  panelsClearedFor,
  regionsFor,
  type FrameState,
} from "../frame";
import { setBottomChromeHeight } from "../bottomChrome";
import { useShellBandAbovePx, useShellLightsLeadPx } from "../ShellTitleBandView";
import { setTopChromeHoldsLights } from "../topChrome";
import { NO_CONTENT_INSETS, type FrameApi } from "./context";

/**
 * Everything `AppFrame` works out before it draws: its state, the commands
 * over that state, the insets it owes, and the `FrameApi` it provides.
 *
 * Lifted out of the component body whole and in order, so the hooks run in
 * exactly the sequence the frame always called them in. `AppFrame` still owns
 * the provider and the drawing; this owns the arithmetic.
 */
export function useFrameController({
  explorer,
  aside,
  bottomBar,
}: {
  explorer?: ReactNode;
  aside?: ReactNode;
  bottomBar?: ReactNode;
}) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [state, setState] = useState<FrameState>(initialFrame);

  const density = densityFor(width);

  /*
    THE TRAFFIC LIGHTS: WHO HOLDS THEM, AND WHAT THAT COSTS THIS FRAME.

    Inside the desktop shell on macOS the window is frameless with inset
    traffic lights, and something has to keep the console's own content out
    from under them. Two candidates, and the frame picks between them here:

     - **This bar**, at a pointer density. It is exactly the height the
       buttons want (`SHELL_TITLE_BAND_PX` is `layout.topBarHeight`), so it
       pays a leading inset and the root band stands down — which is the whole
       of the change: 45pt of blank strip above the console becomes 45pt of
       note list.
     - **The root band**, otherwise. At compact this bar is absolute,
       transparent and lying over a document that scrolls under it, so buttons
       placed in it would sit on the note; and a console window narrowed past
       `narrowBreakpoint` is that layout on a Mac. `lightsInBarFor` is the
       density half of the rule and `shellLightsLeadPx` the platform half.

    `lightsLeadPx` is therefore non-zero only when all of it holds — a Mac,
    inside the shell, at a density whose bar can carry them — which makes it
    the honest answer to "is this frame holding them", and what the handshake
    publishes.
  */
  const lightsLeadPx = useShellLightsLeadPx(lightsInBarFor(density));
  const holdsLights = lightsLeadPx > 0;

  /*
    What the desktop shell's title band still takes out of the window above
    this frame. Zero when this frame took the job, and zero everywhere there
    are no buttons at all, including an ordinary browser tab.

    The frame is sized in viewport units rather than `flex: 1` (see
    `design/css.ts` for why the unit has to be `dvh`), so a band drawn above
    it does not shorten it the way a flex parent would — it pushed a full
    viewport down by the band instead, and the bottom of the console, which
    is where the context switcher and the sync row live, was off the bottom of
    the window with no way to scroll to it.
  */
  const shellBandPx = useShellBandAbovePx(holdsLights);

  /*
    Tell the band mounted *above* this frame to stand down, because this bar
    is reserving the buttons' corner itself. The mirror of the
    `setBottomChromeHeight` call below, and `topChrome.ts` is the argument for
    why both are module stores rather than context.

    **A layout effect rather than `useEffect`**, and this is the one place the
    difference is visible: the band is an ancestor, so standing it down is a
    parent re-render driven from a child. React flushes layout effects and the
    renders they schedule before the browser paints — with `useEffect` the
    first frame would show band *and* bar, 90pt of chrome, and collapse to 45
    one paint later. That flash is the whole defect, briefly, on every cold
    load.
  */
  const lightsClaim = useId();
  useLayoutEffect(() => {
    setTopChromeHoldsLights(lightsClaim, holdsLights);
    return () => setTopChromeHoldsLights(lightsClaim, false);
  }, [lightsClaim, holdsLights]);
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

  /**
   * The right panel, opened and closed.
   *
   * `toggleExplorer`'s shape, with two differences worth stating rather than
   * leaving to be inferred:
   *
   *  - **no `hasExplorer` term.** The panel is about the context, not the file
   *    tree, so Map and Connections may have it open beside them;
   *  - **the peek is cleared too.** A peek is the folded tree lying over the
   *    editor, and opening the panel moves the editor out from under it, so a
   *    peek that survived would be hovering over a note that is no longer
   *    where the pointer thought it was.
   */
  const toggleAside = useCallback(() => {
    setState((current) => {
      // Same first press as `toggleExplorer`: a command naming a panel that
      // focus mode has taken away brings the panels back instead of writing a
      // preference nobody can see change.
      if (current.focus) return { ...current, focus: false };
      const field = asideToggleFor(densityFor(width));
      if (field === null) return current;
      return { ...current, [field]: !current[field], explorerPeeking: false };
    });
  }, [width]);

  const setAsideWidth = useCallback(
    (next: number) => setState((current) => ({ ...current, asideWidth: clampAsideWidth(next) })),
    [],
  );

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
    /*
      The right panel joins them, and **only where it is over the editor**.

      Escape closes what is in front of you. At `wide` the panel is a column
      beside the note — it is not in front of anything, and closing a column
      somebody arranged their window around because they pressed Escape in the
      note is the same mistake as dismissing a permanent tree on select. At
      `medium` it is an overlay with a scrim, which is exactly the thing this
      is for. `regions.aside` is read rather than `state.asideOpen`, so the
      density decides, in the one place that owns that decision.
    */
    const asideOverEditor = regions.aside === "overlay";
    const wasOpen =
      state.drawerOpen || state.explorerPeeking || state.focus || asideOverEditor;
    if (wasOpen)
      setState((current) => ({
        ...current,
        drawerOpen: false,
        explorerPeeking: false,
        focus: false,
        asideOpen: asideOverEditor ? false : current.asideOpen,
      }));
    return wasOpen;
  }, [state.drawerOpen, state.explorerPeeking, state.focus, regions.aside]);
  const setExplorerWidth = useCallback(
    (next: number) =>
      setState((current) => ({ ...current, explorerWidth: clampExplorerWidth(next) })),
    [],
  );

  const compact = density === "compact";

  /**
   * Whether there is a right panel here for a toggle to act on.
   *
   * Both halves are needed and neither implies the other: `asideToggleFor`
   * answers the *density* question — a phone has no such panel at all — and
   * `aside != null` answers the *surface* one, because the landing page's
   * picture of the console and the fixtures supply no panel to open. Asked of
   * the frame function rather than re-derived, for `explorerFoldable`'s
   * reason: a control that toggles where the command does nothing is a button
   * that lies.
   */
  const asideToggle = asideToggleFor(density) !== null && aside != null;

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
      toggleAside,
      setAsideWidth,
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
      toggleAside,
      setAsideWidth,
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

  return {
    insets,
    state,
    density,
    lightsLeadPx,
    holdsLights,
    shellBandPx,
    hasExplorer,
    regions,
    toggleExplorer,
    toggleAside,
    setAsideWidth,
    toggleFocus,
    setExplorerPeeking,
    closeOverlays,
    setExplorerWidth,
    compact,
    asideToggle,
    explorerFoldable,
    chromeGap,
    bottomBarShowing,
    contentInsets,
    api,
  };
}
