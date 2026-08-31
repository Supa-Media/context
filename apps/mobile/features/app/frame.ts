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
 * reason, and the `sheet` arm is the one this file was missing. `compact`
 * answered `rail: "hidden"` and put nothing in its place, so a phone had the
 * pane it landed on and no way to leave it: Map and Connections, every other
 * context, and sign-out are all in the rail. Landing on the map after signing
 * in was the end of the session.
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
  /** Compact only: the button that pulls the drawer in. */
  drawerToggle: boolean;
  /**
   * Compact only, and only where the file tree is not there to carry it: the
   * control in the top bar that pulls the rail in.
   *
   * There is always somewhere to go — the app-level panes, the other contexts
   * and the way to sign out all live in the rail and nowhere else — so a phone
   * with no route to it is a phone with no navigation at all. What changed is
   * *where the route is*. Obsidian's top bar is a sidebar toggle and one group
   * of actions with nothing in the middle, and the vault switcher lives at the
   * foot of the sidebar. Ours does too: on a route with a tree, `Explorer`'s
   * `vault` slot carries the switcher and `drawerToggle` is the way to it.
   *
   * Map and Connections have no tree and therefore no footer, so the chip stays
   * in the bar there. `appFrame.test.ts` holds the invariant in the form it now
   * takes: every compact layout has *some* route to the rail, and this control
   * exists exactly where the other one does not.
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
      Two panels can come in over the editor and only one of them may be up at
      a time — they occupy the same place on the screen and share one scrim.
      The toggles clear each other, so a state carrying both is already
      impossible; this resolves it anyway rather than leaving the answer to
      whichever `View` happens to be painted last. The rail wins because it is
      the panel that can get you out of here.
    */
    const nav = state.navOpen;
    const tree = hasExplorer && state.drawerOpen && !nav;
    return {
      rail: nav ? "sheet" : "hidden",
      explorer: tree ? "drawer" : "hidden",
      editor: true,
      scrim: nav || tree,
      bottomBar: true,
      statusBar: false,
      drawerToggle: hasExplorer,
      // See the field's doc: where there is a tree, its footer is the vault
      // switcher and the top bar keeps to a toggle and one group of actions.
      navToggle: !hasExplorer,
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
 */
export function explorerToggleFor(
  density: Density,
  /**
   * Whether this route has a file tree, exactly as `regionsFor` takes it.
   *
   * Without this the command was answering `"drawerOpen"` on Map and
   * Connections, where there is no tree: `regionsFor` discarded the flag, so
   * the keystroke looked inert and was in fact writing state. That was
   * harmless until the rail became a panel and raising one panel had to put
   * the other away — then ⌘⇧E on the pane you sign in to *dismissed the only
   * navigation on the screen and opened nothing in its place.* The command
   * has to answer "nothing to toggle" here, not "toggle the drawer that
   * cannot exist".
   */
  options: { hasExplorer?: boolean } = {},
): "drawerOpen" | null {
  if (density === "compact" && (options.hasExplorer ?? true)) return "drawerOpen";
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
 * it to its marks. On a phone there is no column to collapse: the rail is a
 * sheet that is either over the editor or not, and the command is what brings
 * it in. Toggling `railCollapsed` there — which is what happened before this
 * existed — set a preference no compact layout reads, so ⌘B did nothing and
 * the phone had no navigation at all.
 *
 * Unlike `explorerToggleFor` this never returns `null`: every density has a
 * rail, so there is always a field to write. That is not the same as always
 * being *visible* — a medium window with an explorer column renders the rail
 * as icons whichever way `railCollapsed` points, so there the command changes
 * a preference you only see later, on a pane with no tree. Pre-existing, and
 * stated here rather than in a comment claiming otherwise.
 */
export function railToggleFor(density: Density): "navOpen" | "railCollapsed" {
  return density === "compact" ? "navOpen" : "railCollapsed";
}

/**
 * The panels, put away when the layout stops having anywhere to put them.
 *
 * `FrameState` above argues that a resize must not rewrite what somebody
 * chose, and that argument is right — about `railCollapsed` and
 * `explorerWidth`, which are *preferences*. `drawerOpen` and `navOpen` are
 * not preferences. They are "a panel is currently over your editor", which is
 * a thing that is either true of what is on the screen or is stale, and only
 * `compact` has panels at all.
 *
 * Left uncleared they are write-once-and-stuck: at medium and wide there is no
 * sheet, no scrim, no `navToggle`, and `railToggleFor` answers
 * `"railCollapsed"` — so nothing can put them away, and they wait. Open the
 * rail on an iPad in portrait (820pt is under `narrowBreakpoint`, so compact),
 * rotate to landscape, work in the rail column, rotate back, and a sheet
 * nobody asked for is sitting over the note behind a full-body scrim.
 *
 * Returns the same object when there is nothing to clear, so this is safe to
 * call from a state updater on every density change.
 */
export function panelsClearedFor(density: Density, state: FrameState): FrameState {
  if (density === "compact") return state;
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

/**
 * Whether a selection in the tree should dismiss the explorer.
 *
 * True on a phone and nowhere else: the drawer is covering the thing you just
 * asked to read, so leaving it open means every note opens behind a panel. On a
 * column it must stay put — dismissing a permanent region because somebody
 * clicked inside it is the behaviour that makes people stop using the tree.
 */
export function closesOnSelect(density: Density): boolean {
  return density === "compact";
}
