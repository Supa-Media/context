/**
 * @jest-environment jsdom
 */

import { describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { FocusProbe, hover, type Mounted, mountFrame, TogglesProbe, useFrame } from "./fixtures";

describe("what toggling the explorer means", () => {
  /**
   * ⌘⇧E, reached through the frame's own API.
   *
   * On a phone the drawer button is on screen and the tests above press it. At
   * every other density there is no control for this at all — the keymap is the
   * only caller — so the command is invoked the way `console/_layout.tsx`
   * invokes it, through `useFrame()`.
   */
  function CommandProbe() {
    const frame = useFrame();
    return createElement(
      "button",
      { "data-testid": "probe-toggle-explorer", onClick: frame.toggleExplorer },
      "toggle the explorer",
    );
  }

  test("on a desktop it folds the column away and gives the width to the note", () => {
    /*
      **This reverses the assertion it replaces, and the old one is worth
      stating because it guarded a real defect.** It read "on a desktop it does
      nothing at all, rather than something else": `explorerToggleFor` answered
      `null` wherever the explorer was a permanent column, and `null` had to
      mean nothing happened, because this command used to collapse the *rail* —
      making ⌘⇧E a second ⌘B, a command named after the one region it never
      touched.

      The half that guarded the defect was "and the rail is untouched". There
      is no rail to be untouched now, so what stands in its place is the
      switcher and the note: a command that folded the tree and took the
      navigation with it would be the same failure wearing the new layout.
    */
    const app = mountFrame(1440, createElement(CommandProbe));

    app.press("probe-toggle-explorer");

    expect(app.find("explorer")).toBeNull();
    expect(app.find("switcher")).not.toBeNull();
    expect(app.find("status")).not.toBeNull();
    expect(app.find("frame-drawer")).toBeNull();
    expect(app.find("frame-scrim")).toBeNull();

    // And back, through the seam left where it was.
    app.press("explorer-seam-closed");
    expect(app.find("explorer")).not.toBeNull();
    expect(app.find("switcher")).not.toBeNull();

    app.unmount();
  });

  test("on a tablet it does the same thing, which it did not used to", () => {
    // Medium used to pay for the column with the rail's labels, so folding the
    // tree handed them back and this test watched the rail change width. There
    // is no rail to widen, so a tablet and a desktop answer alike.
    const app = mountFrame(1024, createElement(CommandProbe));

    expect(app.find("explorer")).not.toBeNull();

    app.press("probe-toggle-explorer");

    expect(app.find("explorer")).toBeNull();
    expect(app.find("switcher")).not.toBeNull();
    expect(app.find("frame-drawer")).toBeNull();
    expect(app.find("frame-scrim")).toBeNull();

    app.unmount();
  });

  test("on a pane with no tree it still does nothing at all", () => {
    // Map and Connections. Writing `explorerHidden` here would set a preference
    // on a pane that cannot show it, discovered later as a missing tree back on
    // Browse — the same shape as the defect the test above records.
    const app = mountFrame(1440, createElement(CommandProbe), { explorer: false });

    app.press("probe-toggle-explorer");

    expect(app.find("switcher")).not.toBeNull();
    expect(app.find("explorer-seam-closed")).toBeNull();
    expect(app.find("status-toggle-explorer")).toBeNull();

    app.unmount();
  });

  /**
   * **Three tests are replaced here, and what they asserted is worth keeping in
   * view because each was a real defect once.**
   *
   * *⌘B on a phone brings the rail in* — before that, ⌘B set `railCollapsed`,
   * which no compact layout reads, so the one surface with no other way to
   * navigate had a navigation chord that did nothing at all.
   *
   * *⌘⇧E on a pane with no tree leaves the rail alone* — before that, it
   * cleared `navOpen` on its way to setting a flag `regionsFor` discards, so on
   * Map, the pane you sign in to, the keystroke dismissed the only navigation
   * on the screen and opened nothing.
   *
   * *Raising the tree puts the rail away* — the two panels came in from the
   * same edge under one scrim, and a `toggleRail` that stopped clearing
   * `drawerOpen` looked right until you closed the sheet and the drawer sprang
   * open behind it.
   *
   * All three are about panels, and there are none at this density — nor is
   * there a ⌘B left to press anywhere, the rail having folded into the
   * switcher. What survives them is the *shape* of the danger: a command whose
   * density has nothing for it to do must do **nothing**, not another
   * command's job. That is one test now, and it is deliberately the strictest
   * form — the rendered output is compared before and after, so a command that
   * quietly wrote state a later render read would fail rather than pass a flag
   * check.
   */
  test("on a phone the tree's command is inert, at either route", () => {
    for (const explorer of [true, false]) {
      const app = mountFrame(390, createElement(TogglesProbe), { explorer });
      const before = app.container.innerHTML;

      app.press("probe-toggle-explorer");
      app.press("probe-toggle-explorer");

      expect(app.container.innerHTML).toBe(before);
      expect(app.find("frame-nav-sheet")).toBeNull();
      expect(app.find("frame-drawer")).toBeNull();
      expect(app.find("frame-scrim")).toBeNull();
      // And the navigation that is there is still there: a no-op that took the
      // account mark or the toolbar with it would be the old bug in a new place.
      expect(app.find("account")).not.toBeNull();
      expect(app.find("bottom")).not.toBeNull();

      app.unmount();
    }
  });
});

describe("the seams", () => {
  test("the tree's seam folds it and the closed seam brings it back", () => {
    /*
      The design: you fold a panel at its own edge, so the control that unfolds
      it is where the panel was, rather than forty points up and to the right
      in a toolbar.

      **There is one seam now and there were two.** The rail's own — a
      `PanelSeam` that narrowed the column to its marks — went with the rail
      and with ⌘B, which was the only other way to reach it. What that test
      asserted, a fold and an unfold from the panel's own edge, is asserted
      here of the panel that is left.
    */
    const app = mountFrame(1440);

    expect(app.find("explorer")).not.toBeNull();
    app.press("status-toggle-explorer");
    expect(app.find("explorer")).toBeNull();

    app.press("explorer-seam-closed");
    expect(app.find("explorer")).not.toBeNull();

    app.unmount();
  });

  test("there is no seam where there is no panel behind it", () => {
    // A control that folds something already folded is a button that lies, so
    // focus mode takes the seam with the panel.
    const app = mountFrame(1440, createElement(FocusProbe));
    expect(app.find("explorer-resizer")).not.toBeNull();

    app.press("probe-toggle-focus");
    expect(app.find("explorer-resizer")).toBeNull();
    expect(app.find("explorer-seam-closed")).toBeNull();

    app.unmount();
  });

  test("a phone has no seam at all", () => {
    const app = mountFrame(390);
    expect(app.find("explorer-seam-closed")).toBeNull();
    expect(app.find("explorer-resizer")).toBeNull();
    app.unmount();
  });

  test("the closed seam stays put underneath a peek", () => {
    // If it did not, the pointer resting on it would be resting on nothing the
    // moment the peek arrived, and the peek would close as fast as it opened.
    jest.useFakeTimers();
    const app = mountFrame(1440);
    app.press("status-toggle-explorer");

    const seam = app.find("explorer-seam-closed")!;
    hover(seam).in();
    act(() => {
      jest.advanceTimersByTime(400);
    });

    expect(app.find("explorer-peek")).not.toBeNull();
    expect(app.find("explorer-seam-closed")).not.toBeNull();

    app.unmount();
    jest.useRealTimers();
  });
});

describe("the peek", () => {
  /** A desktop with the tree folded away, which is the only state that peeks. */
  function folded(): Mounted {
    const app = mountFrame(1440);
    app.press("status-toggle-explorer");
    return app;
  }

  test("resting on the closed seam brings the tree back over the editor", () => {
    jest.useFakeTimers();
    const app = folded();
    expect(app.find("explorer")).toBeNull();

    hover(app.find("explorer-seam-closed")!).in();
    act(() => {
      jest.advanceTimersByTime(300);
    });

    expect(app.find("explorer-peek")).not.toBeNull();
    expect(app.find("explorer")).not.toBeNull();
    /*
      No scrim, which is the whole reason `peek` is an arm of `Regions.explorer`
      rather than the `drawer` with its scrim suppressed. A scrim would grey out
      and make inert the note being peeked at in order to reach.
    */
    expect(app.find("frame-scrim")).toBeNull();

    app.unmount();
    jest.useRealTimers();
  });

  test("crossing the seam on the way somewhere else opens nothing", () => {
    // The delay is the whole of what separates a rest from a traverse, and a
    // panel that opened on every pass would make the seam unusable.
    jest.useFakeTimers();
    const app = folded();
    const seam = app.find("explorer-seam-closed")!;

    hover(seam).in();
    act(() => {
      jest.advanceTimersByTime(120);
    });
    hover(seam).out();
    act(() => {
      jest.advanceTimersByTime(600);
    });

    expect(app.find("explorer-peek")).toBeNull();

    app.unmount();
    jest.useRealTimers();
  });

  test("leaving the panel closes it; leaving the seam does not", () => {
    /*
      The pointer leaving the seam is usually the pointer moving *onto* the
      panel that just opened beside it. Closing on the seam's hover-out would
      make the peek impossible to reach — it would vanish in the gap between the
      two elements.
    */
    jest.useFakeTimers();
    const app = folded();

    hover(app.find("explorer-seam-closed")!).in();
    act(() => {
      jest.advanceTimersByTime(300);
    });
    hover(app.find("explorer-seam-closed")!).out();
    act(() => {
      jest.advanceTimersByTime(600);
    });
    expect(app.find("explorer-peek")).not.toBeNull();

    // The pointer arrives on the panel — which is where it was going when it
    // left the seam — and only then leaves for good.
    hover(app.find("explorer-peek")!).in();
    hover(app.find("explorer-peek")!).out();
    expect(app.find("explorer-peek")).toBeNull();

    app.unmount();
    jest.useRealTimers();
  });

  test("the panel is not a tab stop, because it is a hover surface", () => {
    /*
      `Pressable` gives every instance a `tabIndex`, and this file's scrim
      carries the rule: labelled and roleless, a screen reader announces a stop
      it cannot describe. This one would be roleless *and* nameless, sitting in
      the tab order between the rail and the note. The tree inside it keeps its
      own semantics, which is the whole reason the wrapper needs none.

      Asserted as an attribute rather than trusted to a prop, because the
      obvious spelling — `focusable={false}` — compiles, reads correctly, and
      does nothing: react-native-web's `Pressable` honours `tabIndex` and
      ignores `focusable`. This test is how that was found.
    */
    jest.useFakeTimers();
    const app = folded();

    hover(app.find("explorer-seam-closed")!).in();
    act(() => {
      jest.advanceTimersByTime(300);
    });

    expect(app.find("explorer-peek")!.getAttribute("tabindex")).toBe("-1");
    // The seam that summoned it is the opposite case and is reachable, named.
    expect(app.find("explorer-seam-closed")!.getAttribute("aria-label")).toBe("Open the file tree");

    app.unmount();
    jest.useRealTimers();
  });

  test("pressing the seam opens the column for good, and cancels the peek", () => {
    jest.useFakeTimers();
    const app = folded();

    hover(app.find("explorer-seam-closed")!).in();
    app.press("explorer-seam-closed");

    expect(app.find("explorer")).not.toBeNull();
    expect(app.find("explorer-peek")).toBeNull();
    expect(app.find("explorer-seam-closed")).toBeNull();

    // And the timer that was pending does not bring a peek back afterwards,
    // beside a column that is already there.
    act(() => {
      jest.advanceTimersByTime(600);
    });
    expect(app.find("explorer-peek")).toBeNull();

    app.unmount();
    jest.useRealTimers();
  });

  test("a pending peek is cancelled when the frame goes away", () => {
    /*
      Navigating from Browse to Map with the pointer sitting on the seam.

      **Asserted against the timer itself, and the version this replaces is
      worth recording because it was the exact failure `docs/decisions/testing`
      is about.** It unmounted, advanced the clock and expected no throw — and
      it passed with the cleanup deleted, because React 19 removed the
      setState-on-an-unmounted-tree warning that the assertion was silently
      relying on. A guard nobody has checked is not a guard; the sabotage run
      is what checked it.

      Counting pending timers is the claim that actually fails: a timer left
      behind is a timer left behind whether or not anything downstream
      complains about it today.
    */
    jest.useFakeTimers();
    const app = folded();
    const before = jest.getTimerCount();

    hover(app.find("explorer-seam-closed")!).in();
    expect(jest.getTimerCount()).toBe(before + 1);

    app.unmount();
    expect(jest.getTimerCount()).toBe(before);

    jest.useRealTimers();
  });
});
