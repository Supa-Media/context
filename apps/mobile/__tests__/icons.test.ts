/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The icon set.
 *
 * These are drawn from `View`s rather than typed as characters, which removes
 * the problem the toolbar had — `☰` 17px wide beside `⌕` at 10.6 — and
 * introduces a different one: **a drawing that renders nothing looks like a
 * control that renders nothing, and nothing about that is loud.** A missing
 * glyph is a visible box or a question mark; a missing icon is air inside a
 * button that still has its accessible name, on a phone with no hover to
 * reveal what was meant to be there.
 *
 * So this file walks `ICON_NAMES` — the list is a value for exactly this
 * reason — and holds every icon to the four claims the component's header
 * makes:
 *
 *  - it draws *something*;
 *  - it occupies exactly `size × size`, so a row of them aligns without
 *    per-icon nudging;
 *  - it stays inside that box, because an icon that overhangs is one that
 *    clips against its neighbour at some other size;
 *  - it is decorative on both platforms' terms, and it says which icon it is.
 *
 * The geometry is asserted in *unit* terms wherever possible. Every drawing is
 * fractions of the box (see the component), so a claim checked at one size is
 * a claim about the drawing rather than about one call.
 */

const { Icon, ICON_NAMES, strokeFor } =
  require("../features/design/components/Icon") as typeof import("../features/design/components/Icon");

interface Mounted {
  box: HTMLElement;
  strokes: HTMLElement[];
  unmount: () => void;
}

function mount(name: (typeof ICON_NAMES)[number], size: number): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(createElement(Icon, { name, size, color: "rgb(1, 2, 3)" }));
  });

  const box = host.firstElementChild as HTMLElement;
  return {
    box,
    strokes: Array.from(box.children) as HTMLElement[],
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

/** react-native-web writes the geometry inline; jsdom will not compute it. */
function px(node: HTMLElement, property: string): number {
  return Number.parseFloat(window.getComputedStyle(node).getPropertyValue(property));
}

describe("every icon in the set", () => {
  test.each(ICON_NAMES)("%s draws at least one stroke", (name) => {
    // The whole reason `ICON_NAMES` is a value. `draw` is a `switch` with no
    // `default`: a name added to the list and not to the switch renders an
    // empty box, which the compiler now also catches — this is the second line
    // of defence, and the one that survives a `draw` returning `[]`.
    const icon = mount(name, 24);
    expect(icon.strokes.length).toBeGreaterThan(0);
    icon.unmount();
  });

  test.each(ICON_NAMES)("%s occupies exactly the size it was asked for", (name) => {
    for (const size of [14, 20, 32]) {
      const icon = mount(name, size);
      expect(px(icon.box, "width")).toBe(size);
      expect(px(icon.box, "height")).toBe(size);
      icon.unmount();
    }
  });

  test.each(ICON_NAMES)("%s stays inside its box", (name) => {
    /*
      Bounds, not appearance. An icon that hangs a stroke outside the box
      overlaps whatever is beside it, and in a toolbar of evenly-spaced targets
      that reads as one button being slightly wrong rather than as a bug.

      Rotated strokes are exempt from the *width* half of this: `transform` is
      applied after layout, so a bar declared 0.6 wide and turned 45° is inside
      its box on paper and outside it on screen by design — that is how the
      chevrons and the tick are drawn at all. Their declared boxes are still
      checked, which is what catches a stroke positioned off the edge.
    */
    const size = 24;
    const icon = mount(name, size);

    for (const stroke of icon.strokes) {
      const left = px(stroke, "left");
      const top = px(stroke, "top");
      expect(left).toBeGreaterThanOrEqual(-0.01);
      expect(top).toBeGreaterThanOrEqual(-0.01);
      expect(left + px(stroke, "width")).toBeLessThanOrEqual(size + 0.01);
      expect(top + px(stroke, "height")).toBeLessThanOrEqual(size + 0.01);
    }

    icon.unmount();
  });

  test.each(ICON_NAMES)("%s is decorative, and says which icon it is", (name) => {
    const icon = mount(name, 20);

    // The web tree. Every icon sits inside a control that carries the
    // accessible name; an icon that were not hidden would be a second,
    // nameless node inside it.
    expect(icon.box.getAttribute("aria-hidden")).not.toBeNull();

    // And the attribute a test can read. Without it "the chevron turns over
    // when the sheet opens" is unassertable, because a drawing has no text —
    // see `appFrameRender.test.ts`, which reads exactly this.
    expect(icon.box.getAttribute("data-icon")).toBe(name);

    icon.unmount();
  });
});

describe("one stroke weight for the whole set", () => {
  test("the weight scales with the size rather than being fixed", () => {
    // The claim the header makes: a 16pt icon and a 24pt icon look like the
    // same family. A fixed weight makes the small one heavy and the large one
    // spindly, which is what a set assembled from several sources looks like.
    expect(strokeFor(32)).toBeGreaterThan(strokeFor(16));
    expect(strokeFor(16) / 16).toBeCloseTo(strokeFor(32) / 32, 1);
  });

  test("it lands on a half point, and never below one", () => {
    // Half points because a half point is a whole pixel at 2x and 3x. Rounding
    // to integers instead makes a 16pt icon 25% heavier or lighter than a 20pt
    // one from the same set.
    for (let size = 8; size <= 48; size += 1) {
      const w = strokeFor(size);
      expect(w * 2).toBe(Math.round(w * 2));
      expect(w).toBeGreaterThanOrEqual(1);
    }
  });

  test("every stroke in one icon is drawn at that weight", () => {
    /*
      The set's whole premise. `plus` is two bars and nothing else — one of
      them turned, which `transform` applies after layout, so both are still
      declared at the weight. An icon whose strokes disagreed with each other
      would be the Unicode problem again, drawn rather than typed.
    */
    const size = 24;
    const icon = mount("plus", size);
    expect(icon.strokes.length).toBe(2);
    for (const stroke of icon.strokes) {
      expect(px(stroke, "height")).toBe(strokeFor(size));
    }
    icon.unmount();
  });
});
