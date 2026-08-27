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
 */

import { layout } from "../design/tokens";

/**
 * How much room there is, in three named steps.
 *
 *  - `compact` — a phone, or a narrow window. One region owns the screen; the
 *    explorer is a drawer over it and the bottom bar carries the verbs.
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
  /** Wide only: the rail is reduced to its icons. */
  railCollapsed: boolean;
  /** Medium and wide: the explorer column's width, in points. */
  explorerWidth: number;
}

export const initialFrame: FrameState = {
  drawerOpen: false,
  railCollapsed: false,
  explorerWidth: layout.explorerWidth,
};

export interface Regions {
  /** `full` shows labels, `icons` shows only the marks, `hidden` is not rendered. */
  rail: "full" | "icons" | "hidden";
  /** `column` sits beside the editor; `drawer` slides over it. */
  explorer: "column" | "drawer" | "hidden";
  /** The editor is always rendered — there is no density with nothing to read. */
  editor: true;
  /** The scrim that closes the drawer. Only ever with `explorer: "drawer"`. */
  scrim: boolean;
  /** Thumb-reach verbs. Compact only; a pointer has the menu and the keyboard. */
  bottomBar: boolean;
  /** Counts, save state and the conflict-check mode. No room for it on a phone. */
  statusBar: boolean;
  /** Compact only: the button that pulls the drawer in. */
  drawerToggle: boolean;
}

/**
 * The whole responsive design, as a function.
 *
 * Two invariants hold for every input, and both are asserted in the tests
 * because both are one careless edit away:
 *
 *  - the explorer is **never** a column and a drawer at once, and the scrim
 *    exists if and only if it is a drawer;
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
    const open = hasExplorer && state.drawerOpen;
    return {
      rail: "hidden",
      explorer: open ? "drawer" : "hidden",
      editor: true,
      scrim: open,
      bottomBar: true,
      statusBar: false,
      drawerToggle: hasExplorer,
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
export function explorerToggleFor(density: Density): "drawerOpen" | null {
  if (density === "compact") return "drawerOpen";
  return null;
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
