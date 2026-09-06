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
import {
  bottomChromeHeight,
  floatingStackBottom,
  setBottomChromeHeight,
  subscribeBottomChrome,
} from "../features/app/bottomChrome";

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
  test("a phone is the editor and a bottom bar, and nothing else", () => {
    const regions = regionsFor("compact", initialFrame);
    expect(regions.rail).toBe("hidden");
    expect(regions.explorer).toBe("hidden");
    expect(regions.bottomBar).toBe(true);
    expect(regions.statusBar).toBe(false);
    expect(regions.drawerToggle).toBe(false);
  });

  test("a drawer flag on a phone opens nothing, and raises no scrim", () => {
    // The flag is still representable — `FrameState` keeps both, and a bundle
    // that ran before this change could have written one. What it must not do
    // is put a panel over a layout whose navigation is the strip along the top.
    const regions = regionsFor("compact", { ...initialFrame, drawerOpen: true });
    expect(regions.explorer).toBe("hidden");
    expect(regions.scrim).toBe(false);
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

  test("no density produces a sheet, and the sweep says so out loud", () => {
    // Collected rather than asserted inside an `if`, and that is the half of
    // this test worth keeping through the change. A bare conditional in a
    // sweep runs zero assertions when the condition never holds, so the
    // version that asserted `["compact"]` inside the loop would have gone
    // green and silent the day sheets stopped being produced — which is
    // exactly the day this is. Collecting makes "none" an assertion.
    const sheetDensities = new Set<Density>();
    for (const { density, state, hasExplorer } of everyFrame()) {
      if (regionsFor(density, state, { hasExplorer }).rail === "sheet") {
        sheetDensities.add(density);
      }
    }
    expect([...sheetDensities]).toEqual([]);
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

  /**
   * **This replaces a retired assertion, which is written out here rather than
   * deleted.**
   *
   * It read *every density has a way to reach the rail*: for every compact
   * layout `navToggle || drawerToggle` was true, and pressing whichever existed
   * produced a rail. Its reason was recorded and was right at the time —
   * `compact` once answered `rail: "hidden"` with nothing in its place, so a
   * phone had the pane it landed on and no way to leave it (Map, Connections,
   * every other context and sign-out all lived in the rail), and "landing on
   * the map after signing in was the end of the session".
   *
   * The *reason* expired, not the requirement. A phone's navigation is no
   * longer behind a control: the context strip runs along the top of every
   * compact layout and the bottom row sits within thumb reach below it, neither
   * is a panel, and neither has to be summoned. `compact` answers
   * `rail: "hidden"` again — with two things in its place instead of nothing.
   *
   * So the rule is restated as what is now true, and deliberately as the same
   * *shape* of claim. Asserting the toggles are merely *absent* would be the
   * weaker test that an empty phone also passes, which is the trap the retired
   * version's own comment describes about `rail !== "hidden" || navToggle`; so
   * the positive half — both bands are claimed, at every state, with or without
   * a file tree — is asserted first and separately.
   *
   * `AppFrame` "knows about geometry and nothing else", so this cannot see
   * whether the strip has any contexts in it. What it can pin is that compact
   * always has the two bands and never puts a panel over them.
   */
  test("every compact layout has a context strip and a bottom row", () => {
    for (const { density, state, hasExplorer } of everyFrame()) {
      if (density !== "compact") continue;
      const regions = regionsFor(density, state, { hasExplorer });

      // The top band the strip lives in. It is the compact top row, and
      // `statusBar: false` is the same fact from the other end — the bottom
      // edge is the toolbar's, so the top one is the chrome's.
      expect(regions.statusBar).toBe(false);
      // The bottom row, which is what carries the seventh key.
      expect(regions.bottomBar).toBe(true);
      // And nothing is over either of them. A scrim made both unreachable,
      // which is what a panel did to this layout.
      expect(regions.scrim).toBe(false);
    }
  });

  test("no compact layout has a panel, or a control claiming to open one", () => {
    // The other half, asserted separately because it fails separately: a
    // leftover toggle is a button that opens nothing, and a leftover sheet is a
    // panel nothing on the screen can put away.
    for (const { density, state, hasExplorer } of everyFrame()) {
      if (density !== "compact") continue;
      const regions = regionsFor(density, state, { hasExplorer });
      expect(regions.rail).toBe("hidden");
      expect(regions.explorer).toBe("hidden");
      expect(regions.navToggle).toBe(false);
      expect(regions.drawerToggle).toBe(false);
    }
  });

  test("no density offers a toggle, because no density has a panel to open", () => {
    // The sweep, so a density that grows a toggle back without growing the
    // panel it names fails here rather than on somebody's phone.
    for (const { density, state, hasExplorer } of everyFrame()) {
      const regions = regionsFor(density, state, { hasExplorer });
      expect(regions.navToggle).toBe(false);
      expect(regions.drawerToggle).toBe(false);
    }
  });

  test("both toggles are genuine no-ops at compact", () => {
    // "Does nothing" has to mean *nothing*, not "does the other one". The
    // failure this pins is ⌘B writing `railCollapsed` on a layout that never
    // reads it — how the phone once had no navigation and no error either.
    expect(railToggleFor("compact")).toBeNull();
    for (const { state, hasExplorer } of everyFrame()) {
      expect(explorerToggleFor("compact", { hasExplorer })).toBeNull();
      // And the regions do not move whichever way the panel flags point, so a
      // stale flag from a wider layout cannot resurrect a sheet.
      const off = regionsFor(
        "compact",
        { ...state, navOpen: false, drawerOpen: false },
        { hasExplorer },
      );
      const on = regionsFor(
        "compact",
        { ...state, navOpen: true, drawerOpen: true },
        { hasExplorer },
      );
      expect(on).toEqual(off);
    }
  });
});

describe("medium and wide are untouched by the phone's change", () => {
  // The scope of the redesign, asserted rather than assumed: the rail column
  // and the explorer column are exactly what they were, at every state.
  test("a tablet still has an explorer column and an icon rail", () => {
    for (const { density, state, hasExplorer } of everyFrame()) {
      if (density !== "medium") continue;
      const regions = regionsFor(density, state, { hasExplorer });
      expect(regions.explorer).toBe(hasExplorer ? "column" : "hidden");
      expect(regions.rail).toBe(hasExplorer || state.railCollapsed ? "icons" : "full");
      expect(regions.statusBar).toBe(true);
      expect(regions.bottomBar).toBe(false);
    }
  });

  test("a desktop still has both columns, and ⌘B still collapses the rail", () => {
    for (const { density, state, hasExplorer } of everyFrame()) {
      if (density !== "wide") continue;
      const regions = regionsFor(density, state, { hasExplorer });
      expect(regions.explorer).toBe(hasExplorer ? "column" : "hidden");
      expect(regions.rail).toBe(state.railCollapsed ? "icons" : "full");
      expect(regions.statusBar).toBe(true);
    }
    expect(railToggleFor("wide")).toBe("railCollapsed");
    expect(railToggleFor("medium")).toBe("railCollapsed");
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

describe("the rail is not on a phone at all", () => {
  test("there is no chip in the bar, on a pane with a tree or without one", () => {
    // Map and Connections are exactly where signing in lands you and they have
    // no explorer, so this used to be the only navigation on the screen. It is
    // the strip now, which is on the screen at both routes rather than behind
    // a control at one of them.
    for (const hasExplorer of [false, true]) {
      const regions = regionsFor("compact", initialFrame, { hasExplorer });
      expect(regions.navToggle).toBe(false);
      expect(regions.drawerToggle).toBe(false);
      expect(regions.rail).toBe("hidden");
    }
  });

  test("a nav flag brings in no sheet and no scrim", () => {
    const regions = regionsFor("compact", { ...initialFrame, navOpen: true });
    expect(regions.rail).toBe("hidden");
    expect(regions.scrim).toBe(false);
    expect(regions.explorer).toBe("hidden");
  });

  test("nor do both flags together, which is the state that used to need a rule", () => {
    // The two panels shared one place on the screen, so `regionsFor` had to
    // decide which won. There is nothing to decide between now, and the state
    // is still worth driving: it is what a bundle from before this change
    // could have left on a device.
    const both: FrameState = { ...initialFrame, navOpen: true, drawerOpen: true };
    const regions = regionsFor("compact", both);
    expect(regions.rail).toBe("hidden");
    expect(regions.explorer).toBe("hidden");
    expect(regions.scrim).toBe(false);
  });

  test("and a stale flag still does not leak into a layout that has a column", () => {
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

  test("compact is no longer exempt, because compact no longer has panels", () => {
    // This used to assert the opposite — `panelsClearedFor("compact", open)`
    // returned the same object, because compact was the one density that had
    // somewhere to put a panel. It does not, so a flag left over from a bundle
    // that did is cleared here rather than left for a `regionsFor` that no
    // longer reads it.
    const open: FrameState = { ...initialFrame, navOpen: true, drawerOpen: true };
    const cleared = panelsClearedFor("compact", open);
    expect(cleared.navOpen).toBe(false);
    expect(cleared.drawerOpen).toBe(false);
  });

  test("both panels are put away at every density", () => {
    const open: FrameState = { ...initialFrame, navOpen: true, drawerOpen: true };
    for (const density of DENSITIES) {
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
  test("⌘⇧E has nothing to toggle at any density", () => {
    // It used to answer `"drawerOpen"` at compact-with-a-tree. There is no
    // drawer at any density now, so the one arm that named a field is gone and
    // the honest answer everywhere is `null` — which the *command* must then
    // treat as nothing, not as a licence to toggle the rail instead.
    expect(explorerToggleFor("compact")).toBeNull();
    expect(explorerToggleFor("medium")).toBeNull();
    expect(explorerToggleFor("wide")).toBeNull();
  });

  test("and the tree flag does not resurrect one", () => {
    // The flag is still on the signature and is still what would decide if a
    // density grew a drawer back. It decides nothing today, in either
    // direction, which is the thing to pin — the older failure here was the
    // opposite one: `"drawerOpen"` answered on Map and Connections, where the
    // flag was set, `regionsFor` discarded it, and the keystroke looked inert
    // while writing state.
    expect(explorerToggleFor("compact", { hasExplorer: false })).toBeNull();
    expect(explorerToggleFor("compact", { hasExplorer: true })).toBeNull();
    expect(explorerToggleFor("medium", { hasExplorer: false })).toBeNull();
  });

  test("⌘B collapses the rail on a pointer and does nothing on a phone", () => {
    // It used to answer `"navOpen"` at compact, back when the rail was a sheet
    // the command brought in. Before *that* it answered `"railCollapsed"`
    // there, which is a preference no compact layout reads — a command that
    // was a no-op on the one surface with no other way to navigate. The
    // difference now is where the navigation went: the strip and the bottom
    // row, on the screen, rather than nothing.
    expect(railToggleFor("compact")).toBeNull();
    expect(railToggleFor("medium")).toBe("railCollapsed");
    expect(railToggleFor("wide")).toBe("railCollapsed");
  });

  test("choosing a note dismisses nothing, because the tree covers nothing", () => {
    // This used to be true at compact: the drawer was over the note you had
    // just asked for, so leaving it open opened every note behind a panel.
    // With no drawer at any density, the remaining case is the column — and
    // dismissing a permanent region because somebody clicked inside it is how
    // people stop using a file tree.
    expect(closesOnSelect("compact")).toBe(false);
    expect(closesOnSelect("medium")).toBe(false);
    expect(closesOnSelect("wide")).toBe(false);
  });
});

describe("two floating things at the same edge", () => {
  /*
    The console's toolbar and the persistent recording bar are both pills in the
    same 66pt of glass, and both are drawn at the bottom of the screen. The bar
    is mounted at the root of `(app)` so a recording is visible from wherever
    somebody is; the toolbar belongs to whichever console screen is underneath
    it. `AppFrame` already says what happens when two of them meet — "two
    floating bars in the same 66pt of glass is worse than either" — and answers
    it for the keyboard accessory by hiding the toolbar. Hiding a screen's
    navigation for the length of a meeting is not an answer, so the bar stacks.
  */
  test("with nothing underneath, a bar sits where the reference puts it", () => {
    // A browser or an un-notched phone: the measured 25pt, not flush.
    expect(floatingStackBottom(0, 0)).toBe(layout.floatingGap);
    // A notched phone: the home indicator's own inset, which is already a gap.
    // `max`, never a sum — a bar hovering 59pt up is the bug the token warns of.
    expect(floatingStackBottom(34, 0)).toBe(34);
  });

  test("with the console's toolbar underneath, it clears it rather than covering it", () => {
    const clear = layout.bottomBarHeight + layout.floatingInset;
    expect(floatingStackBottom(34, layout.bottomBarHeight)).toBe(34 + clear);
    expect(floatingStackBottom(0, layout.bottomBarHeight)).toBe(layout.floatingGap + clear);
    // Which is exactly the room the frame reserves above its own toolbar, so
    // the two are the same distance apart as the toolbar is from the glass.
    expect(floatingStackBottom(34, layout.bottomBarHeight) - 34 - layout.bottomBarHeight).toBe(
      layout.floatingInset,
    );
  });

  test("a screen with no chrome at that edge pays nothing for the possibility", () => {
    // Map, Connections, Settings and every meetings screen. A constant offset
    // "just in case" would leave a hand's width of empty ground under the bar.
    expect(floatingStackBottom(34, 0)).toBe(floatingStackBottom(34, -1));
    expect(bottomChromeHeight()).toBe(0);
  });

  test("the published height is a number a frame owns, and it is idempotent", () => {
    const seen: number[] = [];
    const stop = subscribeBottomChrome(() => seen.push(bottomChromeHeight()));
    setBottomChromeHeight(layout.bottomBarHeight);
    setBottomChromeHeight(layout.bottomBarHeight);
    setBottomChromeHeight(0);
    stop();
    // Two notifications, not three: the frame publishes from an effect that
    // runs on every render, and a store that notified unconditionally would
    // re-render every subscriber on every keystroke in the editor.
    expect(seen).toEqual([layout.bottomBarHeight, 0]);
    expect(bottomChromeHeight()).toBe(0);
  });
});
