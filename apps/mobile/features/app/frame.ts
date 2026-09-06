/**
 * Which regions of the console are on screen, at what width.
 *
 * The console is one application with four regions — rail, explorer, editor,
 * status — and the whole of the responsive design is deciding which of them
 * exist at a given width and which one owns the screen. That decision is here,
 * as a pure function, rather than as a pile of `width < 880 &&` scattered
 * through the components: there are three densities and four regions, and the
 * combinations that are wrong (an explorer drawer *and* an explorer column, a
 * bottom bar on a desktop, a rail with nowhere to go) are exactly the ones
 * nobody notices until somebody rotates a tablet.
 *
 * ## Neither surface is the other one degraded
 *
 * This app ships to a browser and to a phone from one codebase, and both are
 * the product. A pointer and a touchscreen are genuinely different machines:
 * one has a right button, a keyboard and 1400px of width; the other has a
 * thumb, a soft keyboard and 390px. Designing for either one and deriving the
 * other produces a recognisable failure in both directions — a desktop layout
 * shrunk down gives you 20px tap targets and a tree you cannot hit, and a phone
 * layout stretched out gives you a 1400px column of chrome with nothing in it.
 *
 * So each density is designed on its own terms. `wide` is a real desktop
 * application: three columns at once, a resizable explorer, a status bar, and
 * every operation on a keyboard chord. `compact` is a real phone application:
 * the editor owns the screen, the tree is a drawer, and the verbs sit on a
 * bottom toolbar within thumb reach, the way Obsidian mobile does it. `medium`
 * is the honest middle — a tablet has room for the explorer column but not for
 * the rail's labels too, and it says so.
 *
 * What they share is this function and the models underneath it, which is the
 * point: the *rules* are one implementation, so a refusal or a permission
 * cannot exist on one surface and go missing on the other. Only the
 * presentation forks.
 *
 * Deciding it from a number also makes it testable. This repo's suite runs in
 * plain node with no renderer, so a layout decided by a width is a layout with
 * tests, and the combinations that are wrong fail in CI rather than on a device
 * somebody happens to pick up.
 *
 * ## Why the drawer and the column are the same region
 *
 * `explorer: "drawer" | "column" | "hidden"` is one field on purpose. The file
 * tree has one selection, one expansion set and one scroll position no matter
 * how it is presented, and modelling the drawer as a separate thing is how you
 * end up with a tablet that opens the drawer, rotates, and shows you a column
 * scrolled somewhere else.
 *
 * `rail: "full" | "icons" | "sheet" | "hidden"` is one field for the same
 * reason.
 *
 * ## `compact` answers `rail: "hidden"` again, and this time it is not a hole
 *
 * **Amended, and the version it replaces is stated rather than deleted.** This
 * paragraph used to argue for the `sheet` arm: `compact` answered
 * `rail: "hidden"` and put *nothing* in its place, so a phone had the pane it
 * landed on and no way to leave it — Map and Connections, every other context
 * and sign-out are all in the rail, and landing on the map after signing in was
 * the end of the session. That was true, and the sheet fixed it.
 *
 * What has changed is not the requirement but the answer to it. A phone now has
 * **no left panel at all** — no rail sheet, no file-tree drawer, no toggle for
 * either and no scrim from either — because navigation moved to two surfaces
 * that are always on the glass and are not panels: a horizontally scrolling
 * **context strip** along the top (`AppFrame`'s `contextStrip` slot, beside a
 * pinned `accountSlot`) and a seventh key on the bottom row. Neither has to be
 * summoned, so neither can be missing; a person is never one press away from
 * navigation, they are looking at it.
 *
 * The old invariant — "every compact layout offers `navToggle` or
 * `drawerToggle`" — is therefore retired rather than dropped, and
 * `appFrame.test.ts` carries the rule that replaced it: at compact there is
 * always a context strip and always a bottom row. A toggle for a panel that
 * does not exist is not navigation, which is what made the old assertion the
 * right one to write and the wrong one to keep.
 *
 * ## What is deliberately kept although no density reaches it
 *
 * This is the whole list. **Anything not on it that a phone used to reach is a
 * deletion, not a survivor** — that is what makes the list worth keeping, and
 * it is enforced by being read: the day something else here stops being
 * reachable it is added with its reason or it goes.
 *
 *  - **The `sheet` and `drawer` arms of `Regions`, the `scrim`, and the two
 *    panel flags on `FrameState`.** `AppFrame`'s API (`closeDrawer`,
 *    `closeNav`, `closeOverlays`, `closesOnSelect`) is consumed outside this
 *    feature — the file tree and the console layout both hold it — and retiring
 *    the representation is one change, made where those callers are, rather
 *    than a hole opened here for somebody else to find.
 *  - **`menu.ts`'s `platform: "touch"` arm**, which decides that a surface with
 *    no keyboard prints no chords and is offered no "Open in new tab". That is
 *    a *rule* rather than a rendering fork, `menu.ts` is its single owner, and
 *    both values are checked; deleting it would move the decision into whatever
 *    grows a long-press menu next. `Explorer` no longer derives it from the
 *    density — it passes the literal `"web"`, because it is a pointer-layout
 *    region and nothing else.
 *
 * **What was removed rather than kept**, so that the two lists are visibly
 * different things: `Explorer`'s whole `const touch = frame.density ===
 * "compact"` fork — a footer icon row, a revealed filter, an autofocus, a
 * "Close the file tree" button, thumb-sized targets — and `FileTree`'s `touch`
 * presentation with it. Those are *drawings* of a region that is `hidden` at
 * compact, with one caller each inside this feature, so nothing outside was
 * holding them and nothing was deciding anything by them.
 */

import { layout } from "../design/tokens";

/**
 * How much room there is, in three named steps.
 *
 *  - `compact` — a phone, or a narrow window. One region owns the screen; the
 *    rail and the explorer are sheets over it and the bottom bar carries the
 *    verbs.
 *  - `medium` — a tablet, a split-screen laptop window. The explorer earns a
 *    permanent column, but the rail collapses to icons to pay for it.
 *  - `wide` — a real desktop window. Everything is visible at once.
 */
export type Density = "compact" | "medium" | "wide";

export function densityFor(width: number): Density {
  if (width < layout.narrowBreakpoint) return "compact";
  if (width < layout.wideBreakpoint) return "medium";
  return "wide";
}

/**
 * What the person has toggled.
 *
 * Deliberately *preferences*, not answers: `drawerOpen` is meaningless at
 * `wide` and `railCollapsed` is meaningless at `compact`, and neither is
 * cleared when the window resizes. Somebody who collapses the rail, narrows the
 * window and widens it again gets their collapsed rail back — clearing the
 * preference on every resize is the behaviour that feels broken.
 */
export interface FrameState {
  /** Compact only: the explorer drawer is pulled in over the editor. */
  drawerOpen: boolean;
  /** Compact only: the rail is pulled in over the editor as a sheet. */
  navOpen: boolean;
  /** Wide only: the rail is reduced to its icons. */
  railCollapsed: boolean;
  /** Medium and wide: the explorer column's width, in points. */
  explorerWidth: number;
}

export const initialFrame: FrameState = {
  drawerOpen: false,
  navOpen: false,
  railCollapsed: false,
  explorerWidth: layout.explorerWidth,
};

export interface Regions {
  /**
   * `full` shows labels, `icons` shows only the marks, `sheet` is the same
   * full-width rail pulled in over the editor on a phone, `hidden` is not
   * rendered.
   */
  rail: "full" | "icons" | "sheet" | "hidden";
  /** `column` sits beside the editor; `drawer` slides over it. */
  explorer: "column" | "drawer" | "hidden";
  /** The editor is always rendered — there is no density with nothing to read. */
  editor: true;
  /** The scrim that dismisses whichever panel is over the editor. */
  scrim: boolean;
  /** Thumb-reach verbs. Compact only; a pointer has the menu and the keyboard. */
  bottomBar: boolean;
  /** Counts, save state and the conflict-check mode. No room for it on a phone. */
  statusBar: boolean;
  /**
   * The button that pulls the drawer in. **False at every density.**
   *
   * A phone has no file-tree drawer to pull in — see the file header — and a
   * pointer layout has the column already. It is kept as a field rather than
   * deleted because `drawer` is still a representable value of `explorer`, and
   * a region with no control to raise it is the pair this file exists to keep
   * honest.
   */
  drawerToggle: boolean;
  /**
   * The control in the top bar that pulls the rail in. **False at every
   * density**, for `drawerToggle`'s reason.
   *
   * It used to be compact-only, and only where the file tree was not there to
   * carry the switcher at its foot. Both halves of that are gone with the
   * panels: a phone's navigation is the context strip and the bottom row, which
   * are on the screen rather than behind a control.
   */
  navToggle: boolean;
}

/**
 * The whole responsive design, as a function.
 *
 * Three invariants hold for every input, and each is asserted in the tests
 * because each is one careless edit away:
 *
 *  - nothing is ever a permanent region and a panel over the editor at once,
 *    and the scrim exists if and only if some panel is over the editor;
 *  - the rail sheet and the explorer drawer are **never** up together. They
 *    occupy the same place on the screen and share the one scrim;
 *  - the bottom bar and the status bar are **never** both present. They are two
 *    answers to "what goes along the bottom edge", and a screen with both has
 *    28px of chrome saying nothing and a toolbar the thumb cannot reach.
 */
export function regionsFor(
  density: Density,
  state: FrameState,
  /**
   * Whether this route has a file tree at all.
   *
   * Browse does; Map and Connections do not — they are app-level panes that
   * span every context, and there is no single tree that belongs beside them.
   * Without this, a wide window would draw a 260px empty column next to the
   * constellation and a phone would offer a drawer button that pulls in
   * nothing, which is worse than either pane simply being full width.
   */
  options: { hasExplorer?: boolean } = {},
): Regions {
  const hasExplorer = options.hasExplorer ?? true;

  if (density === "compact") {
    /*
      A phone has no left panel. Not a hidden one, not one behind a toggle —
      none, at either route, whether or not there is a file tree.

      The two panels used to come in over the editor from the same edge under
      one scrim, and the state's two flags decided which. Both flags are still
      on `FrameState` and neither is read here, which is the whole of the
      change: navigation moved onto the glass, to the context strip along the
      top and the seventh key on the bottom row, and a panel that has to be
      summoned is not what a phone offers any more. See the file header for
      what that retires and why the reason it retires is not the reason the
      sheet was added.
    */
    return {
      rail: "hidden",
      explorer: "hidden",
      editor: true,
      scrim: false,
      bottomBar: true,
      statusBar: false,
      drawerToggle: false,
      navToggle: false,
    };
  }

  return {
    // A medium window has room for the explorer column or the rail's labels,
    // not both — unless there is no explorer, in which case the rail may as
    // well be readable.
    rail: (density === "medium" && hasExplorer) || state.railCollapsed ? "icons" : "full",
    explorer: hasExplorer ? "column" : "hidden",
    editor: true,
    scrim: false,
    bottomBar: false,
    statusBar: true,
    drawerToggle: false,
    // The rail is a permanent column here. A control that pulls it in would be
    // pulling in something already on the screen.
    navToggle: false,
  };
}

/**
 * The explorer column's width, held between a floor and a ceiling.
 *
 * The floor is where a kebab-case note name under two levels of indent stops
 * being readable; the ceiling is where the editor's measure drops below the
 * ~65 characters that make prose comfortable. Dragging is allowed to feel free
 * within that, and refuses outside it rather than letting somebody hide a
 * region by dragging it to zero and then wondering where it went.
 */
export function clampExplorerWidth(width: number): number {
  if (!Number.isFinite(width)) return layout.explorerWidth;
  return Math.min(layout.explorerMaxWidth, Math.max(layout.explorerMinWidth, Math.round(width)));
}

/**
 * What toggling the explorer means at this density.
 *
 * One command (`toggleExplorer`, ⌘⇧E on web, the drawer button on a phone)
 * resolved here so neither the keymap nor the button has to know the density.
 * Returning the *field to change* rather than mutating keeps this callable from
 * a reducer.
 *
 * This is the single owner of that meaning, and `AppFrame.toggleExplorer` is
 * its only caller: for a while the frame implemented a different rule of its
 * own, this function was imported by nothing but its own test, and ⌘⇧E toggled
 * the *rail* on any layout with an explorer column — a duplicate of ⌘B that
 * never touched the region it is named after.
 *
 * `null` means the command does nothing here, and nothing is what it must do.
 * Medium and wide have a permanent explorer column: there is no drawer to pull
 * in, and hiding the column outright is a product decision nobody has taken.
 * The day somebody takes it, this is where it lands — one function, one
 * meaning, and every caller follows.
 *
 * **It now answers `null` at every density, compact included.** A phone has no
 * file-tree drawer to pull in (see the file header), so the one arm that
 * returned a field has nothing left to write. That makes this a constant, and
 * it stays a function anyway for the reason it was extracted: ⌘⇧E and the
 * button that used to press it must not each carry their own idea of what
 * toggling the explorer means, and a constant *here* is a single owner
 * answering "nothing", where a deleted function is every caller deciding for
 * itself. `AppFrame.toggleExplorer` is still its only caller and is still a
 * genuine no-op rather than a licence to do something else — toggling the rail
 * there is what once made ⌘⇧E a duplicate of ⌘B.
 */
export function explorerToggleFor(
  _density: Density,
  /**
   * Whether this route has a file tree, exactly as `regionsFor` takes it. Kept
   * on the signature — every caller already has it and the day a density gets
   * a drawer back it is the flag that decides — and unread today.
   */
  _options: { hasExplorer?: boolean } = {},
): "drawerOpen" | null {
  return null;
}

/**
 * What toggling the *rail* means at this density.
 *
 * One command — ⌘B, and the switcher in the top bar — with two honest
 * meanings, resolved here for the same reason `explorerToggleFor` exists: so
 * neither the keymap nor the button has to know the density.
 *
 * On a pointer layout the rail is a permanent column and the command collapses
 * it to its marks.
 *
 * **On a phone it now answers `null`, and that reverses what this comment used
 * to say.** It used to answer `"navOpen"`, because compact had no column to
 * collapse and the rail was a sheet the command brought in — and the sentence
 * before that one is worth keeping, because it is the failure this must not go
 * back to: writing `railCollapsed` at compact set a preference no compact
 * layout reads, so ⌘B did nothing and the phone had no navigation at all.
 *
 * A phone has no rail at all now (see the file header), so there is genuinely
 * no field to write and `null` is the honest answer. What makes that different
 * from the old bug is *where the navigation went*: it is the context strip and
 * the bottom row, on the screen, rather than nothing.
 *
 * At medium and wide it still answers `"railCollapsed"`, and still writes a
 * preference you may only see later: a medium window with an explorer column
 * renders the rail as icons whichever way the flag points, so there the command
 * changes something visible on a pane with no tree. Pre-existing, and stated
 * here rather than in a comment claiming otherwise.
 */
export function railToggleFor(density: Density): "railCollapsed" | null {
  return density === "compact" ? null : "railCollapsed";
}

/**
 * The panels, put away when the layout stops having anywhere to put them.
 *
 * `FrameState` above argues that a resize must not rewrite what somebody
 * chose, and that argument is right — about `railCollapsed` and
 * `explorerWidth`, which are *preferences*. `drawerOpen` and `navOpen` are
 * not preferences. They are "a panel is currently over your editor", which is
 * a thing that is either true of what is on the screen or is stale.
 *
 * Left uncleared they are write-once-and-stuck: there is no sheet, no scrim and
 * no toggle at any density now, so nothing can put them away and they wait.
 * That used to be a description of medium and wide only, and the case it was
 * written for was real — open the rail on an iPad in portrait (820pt is under
 * `narrowBreakpoint`, so compact), rotate to landscape, work in the rail
 * column, rotate back, and a sheet nobody asked for is sitting over the note
 * behind a full-body scrim.
 *
 * **The compact exemption is gone with the panels.** It existed because compact
 * was the one density that *had* somewhere to put them; it does not, so a flag
 * left over from a bundle that did is cleared here rather than left to be read
 * by a `regionsFor` that no longer looks at it. The density is still taken —
 * this is the one place that decides where a panel may live, and a density that
 * grows one back changes this line and nothing else.
 *
 * Returns the same object when there is nothing to clear, so this is safe to
 * call from a state updater on every density change.
 */
export function panelsClearedFor(_density: Density, state: FrameState): FrameState {
  if (!state.drawerOpen && !state.navOpen) return state;
  return { ...state, drawerOpen: false, navOpen: false };
}

/**
 * The gap the floating chrome keeps from the bottom of the glass.
 *
 * `max`, never a sum: on a notched phone the home indicator's inset is already
 * a gap, and adding a float on top of it is a bar hovering 68pt above the
 * indicator. `layout.floatingGap` is the floor, measured off Obsidian, so a
 * browser window or an un-notched phone gets the reference's 25pt rather than
 * reading as flush against the edge.
 *
 * One function because there are two callers and they must not drift: the
 * frame reserves this much below its bottom slot, and the keyboard accessory
 * bar spends the same amount so that it lands exactly where the toolbar it
 * covers was.
 */
export function floatingGapFor(safeAreaBottom: number): number {
  return Math.max(safeAreaBottom, layout.floatingGap);
}

/** How much room a surface has to leave at its top and bottom edges. */
export interface EdgePadding {
  top: number;
  bottom: number;
}

/**
 * The height of *our own* chrome lying over a surface, at each edge.
 *
 * Kept apart from the system's insets and added to them, because they are two
 * different claims on the same band. A screen's own floating header adds to the
 * notch; it does not replace it.
 */
export interface ChromeHeights {
  top?: number;
  bottom?: number;
}

/**
 * What a surface owes at each edge, **split by how it has to be paid**.
 *
 * The split is the whole point, and it exists because a scroller has two
 * different top edges. Padding put on the *content* scrolls away with the
 * content: it decides where the first line rests, and nothing more. Padding put
 * on the view *around* the scroller shortens the viewport, and that is the only
 * kind that is still there once somebody has swiped.
 *
 * So a number that must hold while scrolling cannot be spent on the content, and
 * a number that must let its line be brought out from under something cannot be
 * spent on the viewport. There is one of each.
 */
export interface SurfacePadding {
  /**
   * Paid **outside** the scroller, where it shortens the viewport.
   *
   * The system's furniture at the top of the glass — the status bar and the
   * Dynamic Island. Content may not be laid out under it at rest *and may not
   * scroll under it either*: an opaque clock over body text is illegible
   * whatever put it there, and the platform draws that clock over whatever we
   * leave beneath it.
   */
  viewport: EdgePadding;
  /**
   * Paid as **content padding**, where it scrolls.
   *
   * Our own floating chrome — the round toggle, the trailing capsule, the
   * bottom pill — plus the home indicator's own gap at the foot. Content is
   * *meant* to run under these: that is how Obsidian draws them, and the
   * giveaway in the reference is body text visible either side of the floating
   * pill on the lines it covers. What the padding buys is that the first and
   * last lines can still be brought out from under them, which a shortened
   * viewport can never do.
   */
  content: EdgePadding;
  /** The two together: what a surface that does not scroll pays as plain padding. */
  top: number;
  bottom: number;
}

/**
 * **The one place this arithmetic happens.**
 *
 * A surface pays for two things at each edge, only one of them is ours, and —
 * see `SurfacePadding` — they are not paid in the same place:
 *
 * - The **system's** top furniture shortens the surface. This is the half that
 *   was wrong: it used to go on the content container with everything else, so
 *   every screen was correct at rest and drew its text across the clock the
 *   moment anybody scrolled. A guard that only checked the resting layout could
 *   not see it, which is why `safeArea.test.ts` now scrolls.
 * - **Our** floating chrome is content padding, and stays content padding.
 *
 * `framed` is what stops either half being paid twice. Inside `AppFrame`,
 * `FrameApi.contentInsets` already *is* "the system's insets plus the frame's
 * own chrome, at whichever density you are at", and `FrameApi.viewportInsets`
 * names the part of that sum which has to be spent outside the scroller — the
 * frame is the only thing that knows whether it padded itself down past the
 * notch (a pointer layout, where the answer is nothing: the frame's own
 * `paddingTop` already shortened every scroller inside it) or floated its bars
 * over a full-bleed document (a phone). Outside the frame — `/login`,
 * `/authorize`, `/welcome`, the invitation and share screens, the landing page
 * — there is no such answer, and the system's top inset is the whole of what
 * must be held back from the scroller.
 *
 * On the web every number here is zero and this is arithmetic on nothing, which
 * is why no call site has to ask what platform it is on.
 */
export function surfacePadding({
  systemInsets,
  frameInsets,
  frameViewport,
  framed,
  chrome = {},
}: {
  /** `useSafeAreaInsets()`. Zero on the web. */
  systemInsets: EdgePadding;
  /** `useFrame().contentInsets` — the whole sum. Only meaningful when `framed`. */
  frameInsets: EdgePadding;
  /** `useFrame().viewportInsets` — the part of it paid outside the scroller. */
  frameViewport: EdgePadding;
  /** Whether this surface is inside an `AppFrame` provider. */
  framed: boolean;
  chrome?: ChromeHeights;
}): SurfacePadding {
  const total = framed ? frameInsets : systemInsets;
  /*
    Outside a frame the bottom is left to the content on purpose: the home
    indicator is a thin translucent bar the platform draws *over* whatever is
    beneath it, and every one of these screens ends in a control that has to be
    scrollable clear of it. The top is the opposite — an opaque clock and a
    camera housing — and it is the edge the verification pass found text under.
  */
  const viewport = framed ? frameViewport : { top: systemInsets.top, bottom: 0 };
  const content = {
    top: total.top - viewport.top + (chrome.top ?? 0),
    bottom: total.bottom - viewport.bottom + (chrome.bottom ?? 0),
  };
  return {
    viewport,
    content,
    top: viewport.top + content.top,
    bottom: viewport.bottom + content.bottom,
  };
}

/**
 * Whether a selection in the tree should dismiss the explorer.
 *
 * **False everywhere now, and the reason it used to be true on a phone is worth
 * keeping**: the drawer was covering the thing you had just asked to read, so
 * leaving it open meant every note opened behind a panel. On a column it must
 * stay put — dismissing a permanent region because somebody clicked inside it
 * is the behaviour that makes people stop using the tree.
 *
 * There is no drawer at any density (see the file header), so the first half
 * has nothing to be true of and the second half is the only case left. It stays
 * a function of the density because that is the question it answers, and the
 * day a density puts the tree over the document again this is the line that
 * changes rather than the call site in `Explorer`.
 */
export function closesOnSelect(_density: Density): boolean {
  return false;
}
