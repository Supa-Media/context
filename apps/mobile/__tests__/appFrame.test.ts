/**
 * The application frame's responsive rules.
 *
 * These run in plain node with no renderer, which is the point. The app serves
 * a browser and a phone as equals, so a bad combination is only visible if
 * somebody happens to open the app at that particular width on that particular
 * device — an explorer that is a column and a drawer at once, a bottom toolbar
 * on a desktop, a drawer that survives a rotation into a layout that has no
 * drawer, a drawer button on a pane with no tree behind it. Deciding all of it
 * from a width makes every one of them an assertion instead of a bug report.
 *
 * The invariant sweeps run over every combination of density, all three
 * toggles and the explorer flag, so a new density or a new region cannot be
 * added without either satisfying them or failing loudly. `EVERY_DENSITY` is
 * what makes the density half of that claim true rather than aspirational.
 */

import { describe, expect, test } from "@jest/globals";
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
} from "../features/app/frame";
import { layout } from "../features/design/tokens";

/**
 * Every density, enumerated so that adding one is a compile error here.
 *
 * A hand-written `Density[]` is assignable to a widened `Density[]`, so a
 * fourth density could be added — reintroducing the exact bug this file exists
 * to prevent, by answering `rail: "hidden"` with no `navToggle` — and every
 * sweep below would keep passing over the three it already knew about. Keying
 * a `Record` is what makes the omission fail to build.
 */
const EVERY_DENSITY: Record<Density, true> = { compact: true, medium: true, wide: true };
const DENSITIES = Object.keys(EVERY_DENSITY) as Density[];

/** Every combination of the toggles and the explorer flag, at every density. */
function everyFrame(): { density: Density; state: FrameState; hasExplorer: boolean }[] {
  const frames: { density: Density; state: FrameState; hasExplorer: boolean }[] = [];
  for (const density of DENSITIES) {
    for (const drawerOpen of [false, true]) {
      for (const navOpen of [false, true]) {
        for (const railCollapsed of [false, true]) {
          for (const hasExplorer of [false, true]) {
            frames.push({
              density,
              hasExplorer,
              state: { drawerOpen, navOpen, railCollapsed, explorerWidth: layout.explorerWidth },
            });
          }
        }
      }
    }
  }
  return frames;
}

describe("density", () => {
  test("a phone is compact, a tablet is medium, a desktop is wide", () => {
    expect(densityFor(390)).toBe("compact");
    expect(densityFor(744)).toBe("compact");
    expect(densityFor(1024)).toBe("medium");
    expect(densityFor(1440)).toBe("wide");
  });

  test("the boundaries are the tokens, and they are inclusive upward", () => {
    expect(densityFor(layout.narrowBreakpoint - 1)).toBe("compact");
    expect(densityFor(layout.narrowBreakpoint)).toBe("medium");
    expect(densityFor(layout.wideBreakpoint - 1)).toBe("medium");
    expect(densityFor(layout.wideBreakpoint)).toBe("wide");
  });

  test("a zero width is compact rather than a crash", () => {
    // Expo hands back 0 for one frame on some web mounts before the window is
    // measured. Landing on the phone layout for that frame is invisible;
    // landing on `wide` paints three columns and reflows.
    expect(densityFor(0)).toBe("compact");
  });
});

describe("regions", () => {
  test("a phone is the editor, a drawer and a bottom bar", () => {
    const regions = regionsFor("compact", initialFrame);
    expect(regions.rail).toBe("hidden");
    expect(regions.explorer).toBe("hidden");
    expect(regions.bottomBar).toBe(true);
    expect(regions.statusBar).toBe(false);
    expect(regions.drawerToggle).toBe(true);
  });

  test("opening the drawer on a phone brings the scrim with it", () => {
    const regions = regionsFor("compact", { ...initialFrame, drawerOpen: true });
    expect(regions.explorer).toBe("drawer");
    expect(regions.scrim).toBe(true);
  });

  test("a medium window trades the rail's labels for the explorer column", () => {
    const regions = regionsFor("medium", initialFrame);
    expect(regions.rail).toBe("icons");
    expect(regions.explorer).toBe("column");
    expect(regions.bottomBar).toBe(false);
    expect(regions.statusBar).toBe(true);
  });

  test("a wide window shows everything, and honours a collapsed rail", () => {
    expect(regionsFor("wide", initialFrame).rail).toBe("full");
    expect(regionsFor("wide", { ...initialFrame, railCollapsed: true }).rail).toBe("icons");
  });

  test("a drawer left open does not leak into a wide layout", () => {
    // The preference is kept — resizing must not silently rewrite what somebody
    // chose — but a density with no drawer must not honour it.
    const stale: FrameState = { ...initialFrame, drawerOpen: true };
    expect(regionsFor("wide", stale).explorer).toBe("column");
    expect(regionsFor("wide", stale).scrim).toBe(false);
    expect(regionsFor("medium", stale).explorer).toBe("column");
  });

  test("a collapsed rail is meaningless on a phone rather than wrong", () => {
    const stale: FrameState = { ...initialFrame, railCollapsed: true };
    expect(regionsFor("compact", stale).rail).toBe("hidden");
  });

  /* ---------------------------------------------------------------------- */
  /*  The invariants. Each is one careless edit away, in either file.        */
  /* ---------------------------------------------------------------------- */

  test("the scrim is there exactly when a panel is over the editor", () => {
    for (const { density, state, hasExplorer } of everyFrame()) {
      const regions = regionsFor(density, state, { hasExplorer });
      expect(regions.scrim).toBe(regions.explorer === "drawer" || regions.rail === "sheet");
    }
  });

  test("a permanent column is never behind a scrim", () => {
    // `explorer` is one field, so "a column and a drawer at once" is
    // unrepresentable and asserting it would say nothing. What is
    // representable, and wrong, is a column with a scrim over it.
    for (const { density, state, hasExplorer } of everyFrame()) {
      const regions = regionsFor(density, state, { hasExplorer });
      expect(regions.explorer === "column" && regions.scrim).toBe(false);
      expect((regions.rail === "full" || regions.rail === "icons") && regions.scrim).toBe(false);
    }
  });

  test("the rail sheet and the explorer drawer are never up together", () => {
    // They come in from the same edge, over the same region, under the one
    // scrim. Two of them is a panel you cannot see behind a panel you can.
    for (const { density, state, hasExplorer } of everyFrame()) {
      const regions = regionsFor(density, state, { hasExplorer });
      expect(regions.rail === "sheet" && regions.explorer === "drawer").toBe(false);
    }
  });

  test("the rail is a sheet only where it is not a column", () => {
    // Collected rather than asserted inside the `if`. A bare conditional in a
    // sweep executes zero assertions when the condition never holds, so a
    // change that stopped producing sheets entirely — the original bug — left
    // this test green and silent.
    const sheetDensities = new Set<Density>();
    for (const { density, state, hasExplorer } of everyFrame()) {
      if (regionsFor(density, state, { hasExplorer }).rail === "sheet") {
        sheetDensities.add(density);
      }
    }
    expect([...sheetDensities]).toEqual(["compact"]);
  });

  test("the bottom bar and the status bar are never both present", () => {
    for (const { density, state, hasExplorer } of everyFrame()) {
      const regions = regionsFor(density, state, { hasExplorer });
      expect(regions.bottomBar && regions.statusBar).toBe(false);
    }
  });

  test("there is no density with nothing to read", () => {
    for (const { density, state, hasExplorer } of everyFrame()) {
      expect(regionsFor(density, state, { hasExplorer }).editor).toBe(true);
    }
  });

  test("every density has a way to reach the rail", () => {
    // The bug this pins: `compact` answered `rail: "hidden"` and offered
    // nothing in its place, so a phone had the pane it landed on and no way to
    // leave it — Map, Connections, every other context and sign-out all live
    // in the rail.
    //
    // "A control exists" is deliberately not the whole assertion. An earlier
    // version of this test checked `rail !== "hidden" || navToggle`, which at
    // compact is the literal `navToggle: true` and at every other density is a
    // constant `true` on the left — so pinning `rail` to `"hidden"` while
    // leaving the toggle in place satisfied it, and a button that opens
    // nothing is not a way to reach anything. So: either the rail is already
    // on the screen, or the control is there **and pressing it produces a
    // rail**.
    //
    // There are two routes now, not one, and the second is the reason the top
    // bar can be a toggle and one group of actions: where the layout has a file
    // tree, the switcher that opens the rail is at the *foot of that tree*
    // (`Explorer`'s `vault` slot — Obsidian's vault switcher), reached by the
    // drawer button. So the assertion is "a route exists and it produces a
    // rail", by whichever of the two the layout offers.
    for (const { density, state, hasExplorer } of everyFrame()) {
      const regions = regionsFor(density, state, { hasExplorer });
      if (regions.rail !== "hidden") continue;

      const field = railToggleFor(density);
      const pressed = regionsFor(density, { ...state, [field]: !state[field] }, { hasExplorer });
      expect(pressed.rail).not.toBe("hidden");

      // The control that reaches `railToggleFor`: the top bar's chip, or the
      // switcher in the drawer the toggle pulls in. One or the other, always.
      expect(regions.navToggle || regions.drawerToggle).toBe(true);
    }
  });

  test("the nav chip is in the bar exactly where no tree can carry the switcher", () => {
    for (const { density, state, hasExplorer } of everyFrame()) {
      const regions = regionsFor(density, state, { hasExplorer });
      expect(regions.navToggle).toBe(density === "compact" && !hasExplorer);
    }
  });

  test("the drawer toggle exists exactly where a drawer can exist", () => {
    for (const { density, state, hasExplorer } of everyFrame()) {
      const regions = regionsFor(density, state, { hasExplorer });
      // A toggle exists only where a drawer can exist AND there is something
      // to pull in. A button that opens an empty panel is worse than no button.
      expect(regions.drawerToggle).toBe(density === "compact" && hasExplorer);
    }
  });
});

describe("a route with no file tree", () => {
  // Map and Connections are app-level panes spanning every context. There is no
  // single tree that belongs beside them.
  const none = { hasExplorer: false };

  test("draws no empty column on a desktop", () => {
    const regions = regionsFor("wide", initialFrame, none);
    expect(regions.explorer).toBe("hidden");
    expect(regions.scrim).toBe(false);
  });

  test("offers no drawer button on a phone", () => {
    const regions = regionsFor("compact", initialFrame, none);
    expect(regions.drawerToggle).toBe(false);
    expect(regions.explorer).toBe("hidden");
  });

  test("a drawer already open cannot survive into such a route", () => {
    // Navigating from Browse to Map with the drawer open must not leave a scrim
    // over a pane that has nothing behind it.
    const regions = regionsFor("compact", { ...initialFrame, drawerOpen: true }, none);
    expect(regions.explorer).toBe("hidden");
    expect(regions.scrim).toBe(false);
  });

  test("gives the rail its labels back on a tablet", () => {
    // The rail collapses on a medium window to pay for the explorer column.
    // With no column to pay for, there is no reason to make the rail harder to
    // read.
    expect(regionsFor("medium", initialFrame, none).rail).toBe("full");
    expect(regionsFor("medium", initialFrame).rail).toBe("icons");
  });

  test("an explicit collapse is still honoured", () => {
    const collapsed = { ...initialFrame, railCollapsed: true };
    expect(regionsFor("medium", collapsed, none).rail).toBe("icons");
  });

  test("defaults to having one when the option is omitted", () => {
    expect(regionsFor("wide", initialFrame).explorer).toBe("column");
  });
});

describe("the rail on a phone", () => {
  test("is reachable from the top bar even on a pane with no tree", () => {
    // Map and Connections are exactly where signing in lands you, and they have
    // no explorer — so the drawer button is absent and this control is the only
    // navigation on the screen.
    const regions = regionsFor("compact", initialFrame, { hasExplorer: false });
    expect(regions.navToggle).toBe(true);
    expect(regions.drawerToggle).toBe(false);
    expect(regions.rail).toBe("hidden");
  });

  test("comes in as a sheet, over a scrim", () => {
    const regions = regionsFor("compact", { ...initialFrame, navOpen: true });
    expect(regions.rail).toBe("sheet");
    expect(regions.scrim).toBe(true);
    expect(regions.explorer).toBe("hidden");
  });

  test("wins over a drawer that state says is also open", () => {
    // The toggles clear each other, so this state is unreachable through the
    // UI. Resolving it anyway is what keeps the invariants above total.
    const both: FrameState = { ...initialFrame, navOpen: true, drawerOpen: true };
    const regions = regionsFor("compact", both);
    expect(regions.rail).toBe("sheet");
    expect(regions.explorer).toBe("hidden");
    expect(regions.scrim).toBe(true);
  });

  test("a sheet left open does not leak into a layout that has a column", () => {
    const stale: FrameState = { ...initialFrame, navOpen: true };
    expect(regionsFor("medium", stale).rail).toBe("icons");
    expect(regionsFor("wide", stale).rail).toBe("full");
    expect(regionsFor("wide", stale).scrim).toBe(false);
  });
});

describe("a panel does not survive the layout that had it", () => {
  // `railCollapsed` and `explorerWidth` are preferences and are kept across a
  // resize on purpose. "A panel is over your editor" is not a preference, and
  // at every density but compact there is nothing on screen that could put it
  // away — no sheet, no scrim, no `navToggle`, and `railToggleFor` answering
  // `"railCollapsed"`. So it waits, and comes back.

  test("clearing is a no-op at compact, where the panels belong", () => {
    const open: FrameState = { ...initialFrame, navOpen: true, drawerOpen: true };
    expect(panelsClearedFor("compact", open)).toBe(open);
  });

  test("both panels are put away at every density that has none", () => {
    const open: FrameState = { ...initialFrame, navOpen: true, drawerOpen: true };
    for (const density of DENSITIES) {
      if (density === "compact") continue;
      const cleared = panelsClearedFor(density, open);
      expect(cleared.navOpen).toBe(false);
      expect(cleared.drawerOpen).toBe(false);
    }
  });

  test("the preferences are left exactly as they were", () => {
    const state: FrameState = {
      drawerOpen: true,
      navOpen: true,
      railCollapsed: true,
      explorerWidth: 321,
    };
    const cleared = panelsClearedFor("wide", state);
    expect(cleared.railCollapsed).toBe(true);
    expect(cleared.explorerWidth).toBe(321);
  });

  test("the same object comes back when there is nothing to clear", () => {
    // This runs on every density change, so it must not manufacture a new
    // state — and therefore a re-render — for a layout that never had a panel.
    expect(panelsClearedFor("wide", initialFrame)).toBe(initialFrame);
  });
});

describe("explorer width", () => {
  test("held between the floor and the ceiling", () => {
    expect(clampExplorerWidth(300)).toBe(300);
    expect(clampExplorerWidth(10)).toBe(layout.explorerMinWidth);
    expect(clampExplorerWidth(9000)).toBe(layout.explorerMaxWidth);
  });

  test("a drag cannot hide the region by taking it to zero", () => {
    expect(clampExplorerWidth(0)).toBe(layout.explorerMinWidth);
    expect(clampExplorerWidth(-40)).toBe(layout.explorerMinWidth);
  });

  test("nonsense falls back to the resting width rather than NaN", () => {
    expect(clampExplorerWidth(Number.NaN)).toBe(layout.explorerWidth);
    expect(clampExplorerWidth(Number.POSITIVE_INFINITY)).toBe(layout.explorerWidth);
  });

  test("fractional widths from a pointer drag are rounded, not stored raw", () => {
    expect(clampExplorerWidth(287.6)).toBe(288);
  });
});

describe("the touch minimum", () => {
  test("is 44, asserted against the number and not against itself", () => {
    // Every other assertion about touch targets in this suite compares a
    // resolved style to `layout.minTouchTarget` — which proves the style reads
    // the token and nothing more. Changing the token to 10 kept all of them
    // green. This is the one place the value itself is pinned.
    expect(layout.minTouchTarget).toBe(44);
  });

  test("and the top bar is one of them plus its hairline", () => {
    // React Native Web sets `box-sizing: border-box` on every View, so a bar
    // exactly `minTouchTarget` tall with a 1px rule leaves a 43 content box —
    // and a control stretching to fill it is a pixel short of the minimum.
    expect(layout.topBarHeight).toBe(layout.minTouchTarget + 1);
  });
});

describe("toggling", () => {
  test("one command, resolved per density", () => {
    expect(explorerToggleFor("compact")).toBe("drawerOpen");
    expect(explorerToggleFor("medium")).toBeNull();
    expect(explorerToggleFor("wide")).toBeNull();
  });

  test("and it does nothing on a pane that has no tree", () => {
    // Map and Connections. This used to answer `"drawerOpen"` there: the flag
    // was set, `regionsFor` discarded it, and the keystroke looked inert. It
    // stopped being inert the moment raising one panel had to put the other
    // away — ⌘⇧E on the pane you sign in to then dismissed the rail sheet and
    // opened nothing, which is worse than the no-op it replaced.
    expect(explorerToggleFor("compact", { hasExplorer: false })).toBeNull();
    expect(explorerToggleFor("compact", { hasExplorer: true })).toBe("drawerOpen");
    expect(explorerToggleFor("medium", { hasExplorer: false })).toBeNull();
  });

  test("the rail command means bring it in on a phone and collapse it on a pointer", () => {
    // Never null: every density has a rail, so ⌘B always means something. It
    // used to toggle `railCollapsed` at compact, which is a preference no
    // compact layout reads — the command was a no-op on the one surface with
    // no other way to navigate.
    expect(railToggleFor("compact")).toBe("navOpen");
    expect(railToggleFor("medium")).toBe("railCollapsed");
    expect(railToggleFor("wide")).toBe("railCollapsed");
  });

  test("choosing a note closes the drawer, and only the drawer", () => {
    // On a phone the tree is covering the note you just asked for. On a column
    // it is a permanent region, and dismissing it because somebody clicked
    // inside it is how people stop using a file tree.
    expect(closesOnSelect("compact")).toBe(true);
    expect(closesOnSelect("medium")).toBe(false);
    expect(closesOnSelect("wide")).toBe(false);
  });
});
