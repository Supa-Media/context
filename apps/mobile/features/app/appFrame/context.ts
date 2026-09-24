import { createContext, useContext } from "react";
import { useWindowDimensions } from "react-native";
import {
  closesOnSelect,
  densityFor,
  floatingGapFor,
  initialFrame,
  regionsFor,
  type Density,
  type FrameState,
  type Regions,
} from "../frame";

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
   * The right panel — chat and meetings — and ⌘J on web.
   *
   * `asideToggleFor` owns what it means, exactly as `explorerToggleFor` owns
   * the tree's: at compact it answers `null` and this is a genuine no-op,
   * because a phone has no right panel and a command that writes a field no
   * layout reads is the ⌘B mistake `frame.ts` keeps a paragraph about.
   */
  toggleAside: () => void;
  /** Medium and wide: drag the right panel's edge. */
  setAsideWidth: (width: number) => void;
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

export const FrameContext = createContext<FrameApi | null>(null);

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
      toggleAside: noop,
      setAsideWidth: noop,
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
export const NO_CONTENT_INSETS = { top: 0, bottom: 0 } as const;
