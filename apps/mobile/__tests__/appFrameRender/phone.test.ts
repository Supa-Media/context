/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import { createElement } from "react";
import {
  bottomChromeHeight,
  FocusProbe,
  layout,
  mockInsets,
  mountFrame,
  styleOf,
  TogglesProbe,
} from "./fixtures";

describe("a phone", () => {
  /**
   * The toolbar's gap from the bottom of the glass, which is one number and not
   * two added together.
   *
   * `BottomBar` is a floating pill and needs a gap under it; a notched phone's
   * home indicator inset already *is* a gap. Summing them is the "bar floating
   * 68px above the home indicator" that file warns about, and because the frame
   * is `100dvh` and clips, the overflow comes out of the editor rather than
   * growing the frame. So the frame takes whichever is larger — and `BottomBar`
   * itself sets nothing on that edge, which the toolbar's own suite asserts
   * separately.
   *
   * Driven from both sides: a browser with no inset must still get a gap, and a
   * notched phone must not get one on top of its inset.
   *
   * The floor is `floatingGap` (25), measured off Obsidian — its bar ends about
   * 25pt above the bottom of the glass. It used to be `floatingInset` (10),
   * which is near enough to the edge that the pill read as attached to it.
   */
  test("the toolbar's bottom gap is the larger of the inset and the float, never both", () => {
    mockInsets.bottom = 0;
    let app = mountFrame(390);
    let band = app.find("bottom")!.parentElement!;
    expect(Number.parseFloat(styleOf(band, "padding-bottom"))).toBe(layout.floatingGap);
    app.unmount();

    mockInsets.bottom = 34;
    app = mountFrame(390);
    band = app.find("bottom")!.parentElement!;
    expect(Number.parseFloat(styleOf(band, "padding-bottom"))).toBe(34);
    app.unmount();

    // Left as the suite found it: `mockInsets` is module-level and shared.
    mockInsets.bottom = 0;
  });

  /**
   * And its gap from the *side* edges, which is the frame's too.
   *
   * The pill used to be sized by its own contents and centred, so the inset
   * either side was whatever was left over — a number that changes with how
   * many actions the current route offers. A device measured it at 78pt on a
   * context the reader is only a member of, where there is no New note.
   *
   * So the slot carries the inset and the bar fills it, and that is why this is
   * asserted here rather than in `bottomBar.test.ts`: the toolbar cannot know
   * how wide the glass is, and the number was never its to hold.
   *
   * **The arithmetic that used to sit under this is gone from here on purpose.**
   * It read `440 − 2 × inset === 336`, pinning the reference's own pill width —
   * and the inset is 24 now rather than 52, because the sliver of note it
   * bought is what paid for the bottom row's seventh key. The reason to move it
   * rather than update it is that it is a claim about *how many targets fit*,
   * which is the toolbar's, and `bottomBar.test.ts` now computes both rows from
   * the tokens. What belongs here is only that the frame is the one spending
   * the number.
   */
  test("the toolbar is inset from the side edges by the frame, not by its contents", () => {
    const app = mountFrame(440);
    const band = app.find("bottom")!.parentElement!;

    expect(Number.parseFloat(styleOf(band, "padding-left"))).toBe(layout.bottomBarInset);
    expect(Number.parseFloat(styleOf(band, "padding-right"))).toBe(layout.bottomBarInset);
    app.unmount();
  });

  test("is the editor and a bottom toolbar, with no rail", () => {
    const app = mountFrame(390);

    expect(app.text()).toContain("the note");
    expect(app.find("bottom")).not.toBeNull();
    expect(app.find("status")).toBeNull();
    expect(app.find("rail-full")).toBeNull();
    expect(app.find("rail-icons")).toBeNull();
    // The tree is not merely off-screen — it is not mounted, so it costs
    // nothing. It used to be "until it is asked for"; nothing asks now.
    expect(app.find("explorer")).toBeNull();

    app.unmount();
  });

  /* ------------------------------------------------------------------ *
   * No left panel, at either route.
   *
   * A block of tests replaces a longer one, and what it replaced is worth
   * naming: a drawer the toggle brought in, a rail sheet the switcher brought
   * in, one scrim they shared, a chevron that turned over, and the rule that
   * raising one put the other away. All of it worked. What it cost was that
   * every switch of context was a press to open a panel, a press to choose,
   * and a scrim over the note in between — and the panel was also the only
   * route to the app's other places, so one control carried two jobs.
   *
   * `features/app/frame.ts` has the argument. These are the assertions that
   * none of it is drawn any more, which is a different claim from "the flags
   * are false" and is the one a person would notice.
   * ------------------------------------------------------------------ */

  test("no drawer, no sheet, no scrim, and no control claiming to open either", () => {
    for (const explorer of [true, false]) {
      const app = mountFrame(390, "the note", { explorer });
      expect(app.find("frame-drawer")).toBeNull();
      expect(app.find("frame-nav-sheet")).toBeNull();
      expect(app.find("frame-scrim")).toBeNull();
      expect(app.find("frame-drawer-toggle")).toBeNull();
      expect(app.find("frame-nav-toggle")).toBeNull();
      expect(app.find("rail-sheet")).toBeNull();
      app.unmount();
    }
  });

  /**
   * **The three branches that can still draw a panel, at every density and both
   * routes, in one place.**
   *
   * The block above and the pointer-layout ones cover most of this between
   * them, and "most" was the problem: the rail sheet was asserted absent at 390
   * and at 1440 and not at 1024, so the claim in `frame.ts` — that the drawings
   * are kept *and* unreachable — was true of a grid nobody had walked.
   *
   * It matters because those branches are deliberately kept. `frame.ts` keeps
   * the `sheet` and `drawer` arms of `Regions`, the `scrim`, and the two panel
   * flags on `FrameState`, because `AppFrame`'s API is held outside this
   * feature and retiring the representation is one coordinated change made
   * where those callers are. Kept code with nothing measuring its
   * unreachability is how "kept" becomes "back" without anybody deciding.
   */
  test.each([390, 1024, 1440])("no panel is drawn over the editor at %ipt", (width) => {
    for (const explorer of [true, false]) {
      const app = mountFrame(width, "the note", { explorer });
      expect(app.find("frame-drawer")).toBeNull();
      expect(app.find("frame-nav-sheet")).toBeNull();
      expect(app.find("frame-scrim")).toBeNull();
      // The peek is a panel over the editor too, and at rest it is not up —
      // nothing has folded the tree away, so there is no seam to rest on.
      expect(app.find("explorer-peek")).toBeNull();
      app.unmount();
    }
  });

  /**
   * **`rail: "hidden"` has left the kept-but-unreachable list, and this is the
   * assertion that says which density reaches it.**
   *
   * The block above asserts that three drawings stay unreachable. That claim
   * used to cover a fourth thing implicitly — the rail's `hidden` arm — and
   * focus mode reaches it now at medium and wide. Stating *where* is what stops
   * "kept" from quietly becoming "reachable again" in the other direction:
   * without this, deleting focus mode's branch would leave the arm unreachable
   * and nothing would notice.
   */
  test("focus mode folds the explorer away, the rail having gone already", () => {
    for (const width of [1024, 1440]) {
      const app = mountFrame(width, createElement(FocusProbe));
      // No rail at any density now: it is `SwitcherMenu` under the name in the
      // title bar. What focus still has to fold is the tree.
      expect(app.find("rail-full")).toBeNull();
      expect(app.find("rail-icons")).toBeNull();
      expect(app.find("explorer")).not.toBeNull();

      app.press("probe-toggle-focus");

      expect(app.find("rail-full")).toBeNull();
      expect(app.find("rail-icons")).toBeNull();
      expect(app.find("rail-sheet")).toBeNull();
      expect(app.find("explorer")).toBeNull();
      // And nothing came in over the note in its place.
      expect(app.find("frame-scrim")).toBeNull();
      expect(app.find("explorer-peek")).toBeNull();
      app.unmount();
    }
  });

  test("a phone has no focus mode, because it has no panels to fold", () => {
    const app = mountFrame(390, createElement(FocusProbe));

    app.press("probe-toggle-focus");

    // Unchanged, and in particular still carrying its bottom row: a chord that
    // wrote `focus` here would be setting a mode compact never reads, which is
    // the ⌘B failure this frame has had twice.
    expect(app.find("bottom")).not.toBeNull();
    expect(app.find("frame-focus-edge")).toBeNull();
    expect(app.find("rail-full")).toBeNull();

    app.unmount();
  });

  /**
   * **Both commands are no-ops here, driven through the frame's own API.**
   *
   * `appFrame.test.ts` asserts that `railToggleFor` and `explorerToggleFor`
   * answer `null` at compact. That is the rule; this is the frame obeying it,
   * and the two are worth having separately because the frame used to
   * implement a rule of its own — ⌘⇧E toggled the *rail* on any layout with an
   * explorer column, a duplicate of ⌘B that never touched the region it is
   * named after.
   *
   * "Does nothing" is asserted as *nothing appears and nothing disappears*,
   * rather than as a flag staying false: a command that quietly wrote state a
   * later render read would pass the weaker version.
   */
  test("⌘⇧E does nothing at all on a phone", () => {
    const app = mountFrame(390, createElement(TogglesProbe));
    const before = app.container.innerHTML;

    app.press("probe-toggle-explorer");
    app.press("probe-toggle-explorer");

    expect(app.find("frame-nav-sheet")).toBeNull();
    expect(app.find("frame-drawer")).toBeNull();
    expect(app.find("frame-scrim")).toBeNull();
    expect(app.find("bottom")).not.toBeNull();
    expect(app.container.innerHTML).toBe(before);

    app.unmount();
  });

  test("a stale panel flag from an older bundle draws nothing either", () => {
    // `FrameState` still carries `drawerOpen` and `panelsClearedFor` still
    // clears it — see `frame.ts` on why the representation outlived the panel.
    // What must not happen is a device that had it set coming back to a scrim.
    const app = mountFrame(390, "the note", { explorer: false });
    app.resize(1440);
    app.resize(390);
    expect(app.find("frame-nav-sheet")).toBeNull();
    expect(app.find("frame-drawer")).toBeNull();
    expect(app.find("frame-scrim")).toBeNull();
    app.unmount();
  });

  /* ------------------------------------------------------------------ *
   * The two slots that replaced them.
   * ------------------------------------------------------------------ */

  /**
   * The order is the assertion, and it is asserted as document order rather
   * than as "both are present".
   *
   * A pinned account mark, then the trailing capsule. Put the capsule first and
   * it stops being at the trailing edge; put the account after it and the one
   * sign-out in the product is no longer the thing at the leading corner.
   *
   * **There was a third slot between them and it is gone**: the contexts were a
   * `contextStrip` here, and a floating bar meant the note ran behind them at
   * every scroll position. They are the first row of `NavBand` now, inside the
   * scroller — `contextStrip.test.ts` and `noteChrome.test.ts` hold that end.
   *
   * SABOTAGE: rendered `topTrailing` before `accountSlot`. Fails here.
   */
  test("the top row is an account mark and the trailing group", () => {
    const app = mountFrame(390);
    const row = app.find("account")!.parentElement!.parentElement!;
    const order = [...row.querySelectorAll("[data-testid]")]
      .map((node) => (node as HTMLElement).dataset.testid)
      .filter((id) => id === "account" || id === "trailing");
    expect(order).toEqual(["account", "trailing"]);
    app.unmount();
  });

  /**
   * SABOTAGE: `flexShrink: 1` on `accountLead`. Fails here only.
   */
  test("the account mark is pinned rather than shrinkable", () => {
    // It holds the product's only sign-out. A flex child that may shrink is one
    // that whatever lands beside it later squeezes.
    const app = mountFrame(390);
    const lead = app.find("account")!.parentElement!;
    expect(styleOf(lead, "flex-shrink")).toBe("0");
    app.unmount();
  });

  /**
   * SABOTAGE: rendered the slot at every density (`compact ?` → `true ?`).
   * Fails here and in "the switcher chip is the pointer layout's" — the two
   * directions of the same swap, which is the right blast radius.
   */
  test("the account slot is not drawn on a pointer layout", () => {
    // It is the phone's leading slot. A pointer layout puts the switcher there
    // instead — `topBarLeadFor` is the fork — and everything the account block
    // offers is in that menu, under the workspace's own name.
    for (const width of [1024, 1440]) {
      const app = mountFrame(width);
      expect(app.find("account")).toBeNull();
      expect(app.find("switcher")).not.toBeNull();
      app.unmount();
    }
  });

  test("and the switcher chip is the pointer layout's, not the phone's", () => {
    // It used to be drawn at every density, and to be *pressable* on a phone —
    // it was how the rail sheet came in. The contexts are the navigation band
    // now, so the chip has nothing to say here that the band does not say
    // better.
    const app = mountFrame(390);
    expect(app.find("switcher")).toBeNull();
    app.unmount();

    const desktop = mountFrame(1440);
    expect(desktop.find("switcher")).not.toBeNull();
    desktop.unmount();
  });

  test("a frame given no account slot still draws its row rather than crashing", () => {
    // The landing page's picture of the console passes none, so an absent
    // leading slot is an ordinary state rather than an error one.
    const app = mountFrame(390, "the note", { accountSlot: false });
    expect(app.find("app-frame")).not.toBeNull();
    expect(app.text()).toContain("the note");
    expect(app.find("bottom")).not.toBeNull();
    app.unmount();
  });

  /**
   * ANYTHING FLOATING ABOVE THIS FRAME HAS TO KNOW THE TOOLBAR IS THERE.
   *
   * The persistent recording bar is mounted at the root of `(app)` — above every
   * route, so a recording is visible from wherever somebody is — which puts it
   * above this frame in the tree and out of reach of any context it provides. It
   * is a pill of exactly these dimensions in exactly this slot, so without this
   * height it would lie on top of the console's toolbar for the length of a
   * meeting. `features/app/bottomChrome.ts` is the seam; this is the assertion
   * that the frame actually publishes through it.
   *
   * **The panel half of this test is gone with the panels.** It pressed the
   * drawer toggle, checked the reservation dropped to zero because the toolbar
   * is put away under a panel, and checked it came back. `toolbarHidden` still
   * reads `regions.scrim`, and no density raises one — so what is left is the
   * publish and the teardown, which is the half a screen after this one
   * depends on.
   */
  test("the frame publishes the height of its floating toolbar, and takes it back", () => {
    const app = mountFrame(390);
    expect(bottomChromeHeight()).toBe(layout.bottomBarHeight);

    app.unmount();
    // A frame that has gone away leaves nothing behind, or every screen after
    // this one draws its bar 76pt up for a toolbar that is not there.
    expect(bottomChromeHeight()).toBe(0);
  });

  test("nothing is inert, because nothing is over the editor", () => {
    // The sheet used to put the note out of reach of the keyboard and the
    // screen reader, which was right while there was a sheet. With no panel at
    // this density, an `inert` editor would be a note nobody can Tab into and
    // nothing on screen to explain why.
    const app = mountFrame(390);
    expect(app.find("app-frame")!.querySelector("[inert]")).toBeNull();
    app.unmount();
  });

  test("search is on the toolbar, not doubled into the top bar", () => {
    // The one screen with least room must not carry the same control twice.
    const app = mountFrame(390);
    expect(app.find("frame-search")).toBeNull();
    app.unmount();
  });
});
