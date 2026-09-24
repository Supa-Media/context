import type { ReactNode } from "react";
import { View } from "react-native";
import { viewportHeight } from "../design/css";
import { useThemedStyles } from "../design/theme";
import { FrameContext } from "./appFrame/context";
import { frameBody } from "./appFrame/body";
import { frameBottomBar, frameStatusRow } from "./appFrame/bottomEdge";
import { makeStyles } from "./appFrame/styles";
import { frameTopBar } from "./appFrame/topBar";
import { useFrameController } from "./appFrame/useFrameController";

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

/*
  The pieces live beside this file in `appFrame/` — the context and its
  fallback, the state and commands, the three drawn edges, the controls, the
  resizers and the seams, and the one stylesheet they all share. This module
  keeps the component and its props, and re-exports what it always exported.
*/
export { useFrame, type FrameApi } from "./appFrame/context";
export { FrameIconButton } from "./appFrame/controls";
export { PEEK_DELAY_MS } from "./appFrame/seams";

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
  /**
   * The open notes, hanging from the foot of the title bar. **Pointer layouts
   * only** — tabs are a pointer instrument and a phone has `RecentSheet`.
   *
   * A slot in the frame rather than a strip the editor region draws, because
   * the thing that makes a tab look like a tab is the *boundary*: the active
   * one is filled in `pageSurface` against the bar's `chromeSurface`, so it
   * reads as the front edge of the page below. A strip drawn on the page has
   * no boundary to meet and the active tab disappears into its own ground —
   * measured, in exactly that state, before this moved.
   *
   * Absent draws nothing at all, which is what a route with no tabs open
   * passes — and a compact layout is refused the slot whether it passes one or
   * not, because a prop whose contract lives only in its callers is a contract
   * one caller can break silently. See the render.
   */
  tabs?: ReactNode;
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
  /**
   * **Compact only.** Whether the notes are in the bucket, on a phone.
   *
   * A phone has no status strip (`regionsFor` answers `statusBar: false` at
   * compact), and the strip is where a pointer layout says Offline, "3 notes
   * waiting to sync" and "1 note needs you". Without a surface of its own on a
   * phone, none of that was said anywhere a phone could see — so this is that
   * surface: its own floating object in the top row, ahead of the trailing
   * capsule and pushed to the trailing side with it.
   *
   * Its own slot rather than a child of `topTrailing`, because the capsule is
   * a row of 44pt icon targets that meet (`topTrailCompact`'s `gap: 0`) and
   * this is words. It renders nothing at a pointer density whatever is passed,
   * for the reason `tabs` is refused at compact: the strip says it there, and a
   * contract that lived only in the caller is one a caller can break. What goes
   * in it — and that it is absent when there is nothing to say — is the
   * caller's; see `features/console/files/SyncSheet.tsx`.
   */
  syncSlot?: ReactNode;
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
  /**
   * The right panel's contents: chat, and the meeting that is running.
   *
   * A slot rather than something the editor draws, for the reason `explorer`
   * is one: it is a *region of the frame*, so the frame is what decides
   * whether it is a column beside the note or an overlay over it, and the
   * console does not have to know which. Absent on every surface that has no
   * panel to put there — the landing page's picture of the console, the
   * fixtures — and `AppFrame` draws nothing and offers no toggle when it is.
   */
  aside?: ReactNode;
  /** Thumb-reach verbs, on the bottom edge of a phone. */
  bottomBar?: ReactNode;
  /** The editor. */
  children: ReactNode;
}

export function AppFrame({
  switcher,
  tabs,
  topTrailing,
  accountSlot,
  syncSlot,
  onSearch,
  explorer,
  aside,
  status,
  bottomBar,
  children,
}: AppFrameProps) {
  const styles = useThemedStyles(makeStyles);
  const {
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
  } = useFrameController({ explorer, aside, bottomBar });

  return (
    <FrameContext.Provider value={api}>
      <View
        style={[
          styles.frame,
          viewportHeight(shellBandPx),
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
        {frameTopBar({
          styles,
          compact,
          insets,
          contentInsets,
          holdsLights,
          lightsLeadPx,
          density,
          accountSlot,
          switcher,
          tabs,
          syncSlot,
          topTrailing,
          onSearch,
          asideToggle,
          regions,
          toggleAside,
        })}

        {frameBody({
          styles,
          regions,
          state,
          explorer,
          explorerFoldable,
          toggleExplorer,
          setExplorerPeeking,
          children,
          setExplorerWidth,
          aside,
          setAsideWidth,
          closeOverlays,
          compact,
          toggleFocus,
          insets,
        })}

        {frameStatusRow({ styles, regions, status, hasExplorer, toggleExplorer })}

        {frameBottomBar({ styles, bottomBarShowing, chromeGap, bottomBar })}
      </View>
    </FrameContext.Provider>
  );
}
