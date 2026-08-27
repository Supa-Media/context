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
 * The two invariant sweeps run over every combination of density, both
 * toggles and the explorer flag, so a new density or a new region cannot be
 * added without either satisfying them or failing loudly.
 */

import { describe, expect, test } from "@jest/globals";
import {
  clampExplorerWidth,
  closesOnSelect,
  densityFor,
  explorerToggleFor,
  initialFrame,
  regionsFor,
  type Density,
  type FrameState,
} from "../features/app/frame";
import { layout } from "../features/design/tokens";

const DENSITIES: Density[] = ["compact", "medium", "wide"];

/** Every combination of the toggles and the explorer flag, at every density. */
function everyFrame(): { density: Density; state: FrameState; hasExplorer: boolean }[] {
  const frames: { density: Density; state: FrameState; hasExplorer: boolean }[] = [];
  for (const density of DENSITIES) {
    for (const drawerOpen of [false, true]) {
      for (const railCollapsed of [false, true]) {
        for (const hasExplorer of [false, true]) {
          frames.push({
            density,
            hasExplorer,
            state: { drawerOpen, railCollapsed, explorerWidth: layout.explorerWidth },
          });
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
  /*  The two invariants. Both are one careless edit away, in either file.   */
  /* ---------------------------------------------------------------------- */

  test("the explorer is never a column and a drawer at once", () => {
    for (const { density, state, hasExplorer } of everyFrame()) {
      const regions = regionsFor(density, state, { hasExplorer });
      expect(regions.scrim).toBe(regions.explorer === "drawer");
    }
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

describe("toggling", () => {
  test("one command, resolved per density", () => {
    expect(explorerToggleFor("compact")).toBe("drawerOpen");
    expect(explorerToggleFor("medium")).toBeNull();
    expect(explorerToggleFor("wide")).toBeNull();
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
