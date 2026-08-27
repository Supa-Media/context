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
 * ## This is a phone layout that grows, not a desktop layout that shrinks
 *
 * The product is a markdown context people carry around, and the reference for
 * how it should feel on a phone is Obsidian mobile: the editor **is** the
 * screen, the file tree is a drawer you pull in from the left, and everything
 * you would otherwise reach for with a pointer lives on a bottom toolbar within
 * thumb reach. So `compact` is not a degraded `wide` with things hidden — it is
 * the layout, and the wider densities are what happens when there is room to
 * stop hiding things.
 *
 * That ordering matters for a concrete reason. A desktop-first layout reveals
 * its phone bugs only on a phone, and this repo's test suite runs in plain node
 * with no renderer — so the phone case has to be decidable from a number, which
 * is what this module makes it.
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
export function regionsFor(density: Density, state: FrameState): Regions {
  if (density === "compact") {
    return {
      rail: "hidden",
      explorer: state.drawerOpen ? "drawer" : "hidden",
      editor: true,
      scrim: state.drawerOpen,
      bottomBar: true,
      statusBar: false,
      drawerToggle: true,
    };
  }

  return {
    // A medium window has room for the explorer column or the rail's labels,
    // not both. The rail is the one that survives as icons, because its entries
    // are a handful of stable destinations you learn by position, while the
    // explorer is a list of names you have to read.
    rail: density === "medium" || state.railCollapsed ? "icons" : "full",
    explorer: "column",
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
 * One command (`toggleExplorer`, ⌘⇧E on web, the drawer button on a phone) with
 * two implementations, resolved here so neither the keymap nor the button has
 * to know the density. Returning the *field to change* rather than mutating
 * keeps this callable from a reducer.
 */
export function explorerToggleFor(density: Density): "drawerOpen" | "railCollapsed" | null {
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
