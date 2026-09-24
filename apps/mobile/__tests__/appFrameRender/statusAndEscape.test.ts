/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import { createElement, useEffect, useState } from "react";
import { FocusProbe, hover, mountFrame, useFrame } from "./fixtures";

describe("the status bar's panel toggle", () => {
  /**
   * **There was a second toggle here and it is gone rather than folded.**
   *
   * `status-toggle-rail` reported the rail's three states — `full`, `icons`
   * and `off` — and pressed ⌘B. The rail folded into `SwitcherMenu`, so that
   * control would have been a button reporting `off` forever and toggling
   * nothing: the one shape `frame.ts`'s "what is deliberately kept" list
   * refuses, a control with no region behind it. `PanelToggle`'s `half` arm
   * went with it, because the tree is drawn or it is not.
   *
   * What those tests asserted — that a keyboard can reach the state, that the
   * readout tracks the region, and that pressing one in focus mode is a way
   * out — is asserted here of the toggle that is left.
   */
  test("it is there on a desktop, and it says what is folded", () => {
    // The seam is the gesture and the status bar is the state. This is the half
    // that never moves, and the only one a keyboard reaches by tabbing.
    const app = mountFrame(1440);

    expect(app.find("status-toggle-rail")).toBeNull();
    expect(app.find("status-toggle-explorer")!.getAttribute("aria-checked")).toBe("true");

    app.press("status-toggle-explorer");
    expect(app.find("status-toggle-explorer")!.getAttribute("aria-checked")).toBe("false");
    expect(app.find("explorer")).toBeNull();

    app.press("status-toggle-explorer");
    expect(app.find("explorer")).not.toBeNull();

    app.unmount();
  });

  test("a phone has no status bar to put it in", () => {
    const app = mountFrame(390);
    expect(app.find("status-toggle-rail")).toBeNull();
    expect(app.find("status-toggle-explorer")).toBeNull();
    app.unmount();
  });

  test("it is absent on a pane with no tree, leaving the bar to the counts", () => {
    const app = mountFrame(1440, "the note", { explorer: false });
    expect(app.find("status")).not.toBeNull();
    expect(app.find("status-toggle-rail")).toBeNull();
    expect(app.find("status-toggle-explorer")).toBeNull();
    app.unmount();
  });

  test("it survives focus mode, which is what makes it leavable", () => {
    // Focus removes the panel, not the instruments. A mode that hides its own
    // escape hatch is one people enter exactly once.
    const app = mountFrame(1440, createElement(FocusProbe));

    app.press("probe-toggle-focus");

    expect(app.find("status")).not.toBeNull();
    expect(app.find("status-toggle-explorer")).not.toBeNull();
    expect(app.find("frame-focus-edge")).not.toBeNull();

    // And pressing it is a way out: a command naming a panel that is not on
    // the screen brings the panels back rather than writing a preference
    // nobody can see change.
    app.press("status-toggle-explorer");
    expect(app.find("explorer")).not.toBeNull();

    app.unmount();
  });

  test("the focus edge offers a way back before the pointer reaches the toggle", () => {
    const app = mountFrame(1440, createElement(FocusProbe));
    app.press("probe-toggle-focus");

    const edge = app.find("frame-focus-edge")!;
    expect(app.find("frame-focus-exit")).toBeNull();
    hover(edge).in();
    expect(app.find("frame-focus-exit")).not.toBeNull();

    app.press("frame-focus-edge");
    expect(app.find("explorer")).not.toBeNull();

    app.unmount();
  });
});

/**
 * ESCAPE CLOSES THE NEAREST THING, AND SAYS WHETHER IT CLOSED ANYTHING.
 *
 * `keymap.ts` promises Escape "closes whatever is open, wherever you are", and
 * the console keeps that promise by calling `closeOverlays()` — which knew
 * about the panels this component renders itself. Anything else over the console was outside the promise: the find bar
 * in the editor could be opened with ⌘F and then only closed from inside the
 * editor, which is what came back as "isn't dismissable".
 *
 * A panel the frame does not render registers a closer instead. The rules are
 * the three below: nearest first, the boolean is honest, and a panel that
 * unmounted is not a panel.
 */
describe("a panel the frame does not render can still be closed by Escape", () => {
  interface Probe {
    /** Whether the imagined panel is up. */
    open: boolean;
    /** How many times the frame asked it to close. */
    asked: number;
    /** What `closeOverlays()` answered, press by press. */
    answers: boolean[];
  }

  function probe(): Probe {
    return { open: false, asked: 0, answers: [] };
  }

  /** The panel's half: it registers a closer for as long as it is mounted. */
  function Registrant({ state }: { state: Probe }) {
    const { registerDismissable } = useFrame();
    useEffect(
      () =>
        registerDismissable(() => {
          state.asked += 1;
          if (!state.open) return false;
          state.open = false;
          return true;
        }),
      [registerDismissable, state],
    );
    return null;
  }

  /** The console's half: Escape, and a panel that can go away. */
  function DismissProbe({ state }: { state: Probe }) {
    const frame = useFrame();
    const [mounted, setMounted] = useState(true);
    return createElement(
      "span",
      null,
      mounted ? createElement(Registrant, { state }) : null,
      createElement(
        "button",
        {
          "data-testid": "probe-escape",
          onClick: () => state.answers.push(frame.closeOverlays()),
        },
        "escape",
      ),
      createElement(
        "button",
        { "data-testid": "probe-unmount", onClick: () => setMounted(false) },
        "close the note",
      ),
    );
  }

  test("Escape closes it, and answers that it closed something", () => {
    const state = probe();
    state.open = true;
    const app = mountFrame(1440, createElement(DismissProbe, { state }));

    app.press("probe-escape");

    expect(state.open).toBe(false);
    expect(state.answers).toEqual([true]);

    app.unmount();
  });

  /**
   * The boolean is not decoration. `Shortcuts` returns it from the `dismiss`
   * command, and `useKeymap` only calls `preventDefault` on a `true` — so a
   * closer that closed nothing answering `true` would take the browser's own
   * Escape away from a console with nothing open on it.
   */
  test("with nothing open it answers false, so Escape still reaches the browser", () => {
    const state = probe();
    const app = mountFrame(1440, createElement(DismissProbe, { state }));

    app.press("probe-escape");

    expect(state.asked).toBe(1);
    expect(state.answers).toEqual([false]);

    app.unmount();
  });

  /**
   * Nearest first, which is last registered first.
   *
   * A find bar lies over the note inside the console the drawer covers, so one
   * Escape must not take both — the next press is what the thing behind it is
   * for. The two panels this component renders itself (the drawer, the rail
   * sheet) are behind every registered closer for the same reason, and are
   * closed only once none of them answered.
   */
  test("the nearer panel closes, and the one behind it is not even asked", () => {
    const near = probe();
    const far = probe();
    near.open = true;
    far.open = true;
    const app = mountFrame(
      1440,
      createElement(
        "span",
        null,
        // Registered first, so it is the one further from the person.
        createElement(Registrant, { state: far }),
        createElement(DismissProbe, { state: near }),
      ),
    );

    app.press("probe-escape");

    expect(near.open).toBe(false);
    expect(far.open).toBe(true);
    expect(far.asked).toBe(0);

    app.press("probe-escape");

    expect(far.open).toBe(false);
    expect(near.answers).toEqual([true, true]);

    app.unmount();
  });

  /**
   * A note closed with the find bar open leaves a closer pointing at an editor
   * that no longer exists. Registration is for the life of the mount, and the
   * frame must not hold the last one — that is a leak on the app's most
   * frequent unmount, and an Escape answering `true` for a panel nobody can see.
   */
  test("a panel that unmounted is not asked again", () => {
    const state = probe();
    state.open = true;
    const app = mountFrame(1440, createElement(DismissProbe, { state }));

    app.press("probe-unmount");
    app.press("probe-escape");

    expect(state.asked).toBe(0);
    expect(state.open).toBe(true);
    expect(state.answers).toEqual([false]);

    app.unmount();
  });
});
