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

const { Icon, ICON_NAMES, strokeFor, strokeKeys } =
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

/* -------------------------------------------------------------------------- *
 *                          reading a path icon                               *
 * -------------------------------------------------------------------------- */

/**
 * Two icons in the set — `eye` and `pencil` — are stroked `<Path>`s rather than
 * stacks of `View`s, because a rounded border cannot hold one weight around a
 * shallow curve. See the header of `Icon.tsx`.
 *
 * That is only allowed to be a different *drawing technique*, never a hole in
 * the set-wide guards below. A path icon that skipped "stays inside its box"
 * would be two icons quietly dropped from a check the other forty pass, which
 * is the exact shape of false green this project keeps finding. So the geometry
 * is read back out of the DOM and held to the same claims: the arcs are
 * sampled, not reduced to their endpoints, because an arc's bulge is the part
 * that leaves the box.
 */
function asGlyph(node: HTMLElement | undefined): Element | null {
  return node !== undefined && node.tagName.toLowerCase() === "svg" ? node : null;
}

interface Point {
  x: number;
  y: number;
}

/** Sample an elliptical arc, via the endpoint-to-centre conversion in the SVG spec. */
function arcPoints(
  from: Point,
  to: Point,
  rx: number,
  ry: number,
  largeArc: boolean,
  sweep: boolean,
): Point[] {
  const halfDx = (from.x - to.x) / 2;
  const halfDy = (from.y - to.y) / 2;

  // Radii that cannot span the chord are scaled up, which is what a renderer
  // does — and is why the eye's derived radius is checked rather than assumed.
  const lambda = (halfDx * halfDx) / (rx * rx) + (halfDy * halfDy) / (ry * ry);
  const grow = lambda > 1 ? Math.sqrt(lambda) : 1;
  const radiusX = rx * grow;
  const radiusY = ry * grow;

  const top =
    radiusX * radiusX * radiusY * radiusY -
    radiusX * radiusX * halfDy * halfDy -
    radiusY * radiusY * halfDx * halfDx;
  const bottom = radiusX * radiusX * halfDy * halfDy + radiusY * radiusY * halfDx * halfDx;
  const factor = (largeArc === sweep ? -1 : 1) * Math.sqrt(Math.max(0, top / bottom));

  const centreX = (factor * (radiusX * halfDy)) / radiusY + (from.x + to.x) / 2;
  const centreY = (-factor * (radiusY * halfDx)) / radiusX + (from.y + to.y) / 2;

  const angleAt = (point: Point) =>
    Math.atan2((point.y - centreY) / radiusY, (point.x - centreX) / radiusX);
  const start = angleAt(from);
  let span = angleAt(to) - start;
  if (sweep && span < 0) {
    span += 2 * Math.PI;
  }
  if (!sweep && span > 0) {
    span -= 2 * Math.PI;
  }

  const sampled: Point[] = [];
  const steps = 64;
  for (let step = 0; step <= steps; step += 1) {
    const at = start + (span * step) / steps;
    sampled.push({
      x: centreX + radiusX * Math.cos(at),
      y: centreY + radiusY * Math.sin(at),
    });
  }
  return sampled;
}

/** The points of one `d`. Only the commands this file emits are understood. */
function pathPoints(d: string): Point[] {
  const tokens = d.match(/[A-Za-z]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? [];
  const points: Point[] = [];
  let at: Point = { x: 0, y: 0 };
  let opened: Point = { x: 0, y: 0 };
  let index = 0;
  const next = () => Number.parseFloat(tokens[index++]);

  while (index < tokens.length) {
    const command = tokens[index++];
    if (command === "M" || command === "L") {
      at = { x: next(), y: next() };
      if (command === "M") {
        opened = at;
      }
      points.push(at);
    } else if (command === "A") {
      const rx = next();
      const ry = next();
      const rotation = next();
      const largeArc = next();
      const sweep = next();
      const end = { x: next(), y: next() };
      // The sampler above assumes an unrotated ellipse. Nothing here draws one
      // any other way, and a silent wrong answer is worse than a failure.
      expect(rotation).toBe(0);
      points.push(...arcPoints(at, end, rx, ry, largeArc === 1, sweep === 1));
      at = end;
    } else if (command === "Z") {
      at = opened;
      points.push(at);
    } else {
      throw new Error(`icons.test.ts cannot read the path command "${command}"`);
    }
  }
  return points;
}

/** Every drawn point of a path icon, in viewBox units. */
function glyphPoints(glyph: Element): Point[] {
  const points: Point[] = [];
  glyph.querySelectorAll("path").forEach((node) => {
    points.push(...pathPoints(node.getAttribute("d") ?? ""));
  });
  glyph.querySelectorAll("circle").forEach((node) => {
    const cx = Number(node.getAttribute("cx"));
    const cy = Number(node.getAttribute("cy"));
    const r = Number(node.getAttribute("r"));
    for (let step = 0; step < 64; step += 1) {
      const at = (step / 64) * 2 * Math.PI;
      points.push({ x: cx + r * Math.cos(at), y: cy + r * Math.sin(at) });
    }
  });
  return points;
}

/** The stroke weight of every drawn element, in viewBox units. */
function glyphWeights(glyph: Element): number[] {
  return Array.from(glyph.querySelectorAll("path, circle")).map((node) =>
    Number(node.getAttribute("stroke-width")),
  );
}

describe("every icon in the set", () => {
  /**
   * Two strokes in one drawing may not share a key.
   *
   * `exchange` — the Connections mark — is two bars and two chevrons, and
   * `chevron` used to hardcode `key="chevron"` while every other primitive took
   * one. So opening the rail on a phone raised React's "Encountered two
   * children with the same key" over the panel, which is what the owner
   * photographed. Nothing was missing from the drawing, and that is why it
   * survived: the only symptom was a red toast in a development build.
   *
   * Read off the drawing rather than off the DOM or off React's warning. A key
   * never reaches the DOM, and React 19 does not warn for this shape on a first
   * mount — verified before writing this, with the duplicate restored — so a
   * test that listened for the complaint would pass on the broken code.
   */
  test.each(ICON_NAMES)("%s draws no two strokes under one key", (name) => {
    const keys = strokeKeys(name);
    expect(keys).toEqual(keys.filter((key, index) => keys.indexOf(key) === index));
  });

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
    const glyph = asGlyph(icon.strokes[0]);

    if (glyph === null) {
      for (const stroke of icon.strokes) {
        const left = px(stroke, "left");
        const top = px(stroke, "top");
        expect(left).toBeGreaterThanOrEqual(-0.01);
        expect(top).toBeGreaterThanOrEqual(-0.01);
        expect(left + px(stroke, "width")).toBeLessThanOrEqual(size + 0.01);
        expect(top + px(stroke, "height")).toBeLessThanOrEqual(size + 0.01);
      }
    } else {
      // Same claim in the other technique's terms. A stroke is centred on the
      // outline, so half of it hangs outside — the drawing has to keep that
      // half inside the box too, or the mark clips its neighbour in a toolbar.
      expect(glyph.getAttribute("viewBox")).toBe("0 0 1 1");
      const half = strokeFor(size) / size / 2;
      for (const point of glyphPoints(glyph)) {
        expect(point.x - half).toBeGreaterThanOrEqual(-0.001);
        expect(point.y - half).toBeGreaterThanOrEqual(-0.001);
        expect(point.x + half).toBeLessThanOrEqual(1.001);
        expect(point.y + half).toBeLessThanOrEqual(1.001);
      }
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

/**
 * THE EYE IS AN EYE.
 *
 * It has now been drawn wrong twice, the same way both times, and the reason
 * was never the ratio — it was that **a rounded border cannot hold one stroke
 * weight around a curve.**
 *
 * The first attempt was a `shackle` over a `cradle` — the padlock's arch and
 * its mirror — whose left and right borders closed the almond into a capsule
 * with a dot in it. That is a toggle switch, and it read as one in the
 * console's toolbar: the owner's report was a screenshot of the row with "can
 * you make the eye icon look more like an Eye".
 *
 * The second dropped the side borders for a single arc per lid. But a corner
 * radius is clamped by its box's height, so a wide shallow lid keeps a straight
 * run across the middle — the switch again — and stretching a semicircle to
 * remove it only exposed what the borders were doing at the ends: a corner
 * between borders of different widths is drawn as a wedge running to a point,
 * so the stroke arrived at each canthus at nothing. The owner's reply was a
 * reference drawing: one weight the whole way round, meeting in points.
 *
 * So the mark is a stroked path, and these are the guards that would have
 * failed on both earlier attempts. The last one is the finding:
 * **one weight all the way round.** It is cheap, it is exact, and it is the
 * thing that was wrong each time.
 */
describe("the eye", () => {
  const size = 24;

  function glyphOf(name: "eye" | "pencil") {
    const icon = mount(name, size);
    const glyph = asGlyph(icon.strokes[0]);
    if (glyph === null) {
      throw new Error(`${name} is no longer drawn as a path`);
    }
    return { glyph, unmount: icon.unmount };
  }

  test("one weight all the way round — the claim a rounded border cannot make", () => {
    const { glyph, unmount } = glyphOf("eye");
    const weights = glyphWeights(glyph);

    // Every drawn element, lids and iris alike, at the set's derived weight —
    // expressed in viewBox units, because the drawing is unit-space and the
    // weight arrives in points.
    expect(weights.length).toBeGreaterThan(1);
    for (const weight of weights) {
      expect(weight).toBeCloseTo(strokeFor(size) / size, 10);
    }

    // And nothing tapers it back off: a stroked path has no per-end width, so
    // the absence of these is the guarantee the borders could not give.
    glyph.querySelectorAll("path, circle").forEach((node) => {
      expect(node.getAttribute("stroke-dasharray")).toBeNull();
      expect(node.getAttribute("vector-effect")).toBeNull();
    });

    unmount();
  });

  test("the outline closes, so there is no gap at either canthus", () => {
    const { glyph, unmount } = glyphOf("eye");
    const outline = glyph.querySelector("path");
    const d = outline?.getAttribute("d") ?? "";

    // One closed path rather than two arcs hoping to land on each other. A gap
    // of even a hundredth of the box reads at 20pt as a broken outline.
    expect(d.trim().endsWith("Z")).toBe(true);

    // And the drawn ends actually coincide: both lids are arcs between the same
    // two points, so the outline meets at the same place at both canthi rather
    // than merely being told to close.
    const points = pathPoints(d);
    const first = points[0];
    const last = points[points.length - 1];
    expect(last.x).toBeCloseTo(first.x, 10);
    expect(last.y).toBeCloseTo(first.y, 10);

    unmount();
  });

  test("and it is wider than it is tall, which is what makes it an eye rather than a leaf", () => {
    const { glyph, unmount } = glyphOf("eye");
    const points = pathPoints(glyph.querySelector("path")?.getAttribute("d") ?? "");
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);

    expect(width / height).toBeGreaterThan(1.5);
    // Measured from the sampled arcs, so this is the drawn height rather than
    // the declared one — the bulge is the whole shape.
    expect(height).toBeGreaterThan(0.5);

    unmount();
  });

  test("the iris is a ring inside the almond, not a filled dot", () => {
    const { glyph, unmount } = glyphOf("eye");
    const iris = glyph.querySelector("circle");

    // Filled, it reads as a bullet in a bracket at small sizes.
    expect(iris?.getAttribute("fill")).toBe("none");
    expect(iris?.getAttribute("stroke")).toBe("rgb(1, 2, 3)");

    // And large enough to be an iris rather than a pupil: it is what stops the
    // mark reading as a lens, and it is the reason the lids have to hold their
    // weight out to the canthi at all.
    const radius = Number(iris?.getAttribute("r"));
    const points = pathPoints(glyph.querySelector("path")?.getAttribute("d") ?? "");
    const ys = points.map((point) => point.y);
    const halfHeight = (Math.max(...ys) - Math.min(...ys)) / 2;
    expect(radius / halfHeight).toBeGreaterThan(0.5);
    expect(radius).toBeLessThan(halfHeight);

    unmount();
  });

  test("the pencil is the other half of the same control, and holds one weight too", () => {
    const { glyph, unmount } = glyphOf("pencil");

    for (const weight of glyphWeights(glyph)) {
      expect(weight).toBeCloseTo(strokeFor(size) / size, 10);
    }

    // The barrel is closed and the collar is a separate stroke across it —
    // one path would have to double back along a shoulder to reach the collar,
    // drawing that edge twice at double weight.
    const paths = Array.from(glyph.querySelectorAll("path"));
    expect(paths).toHaveLength(2);
    expect(paths[0].getAttribute("d")?.trim().endsWith("Z")).toBe(true);
    expect(paths[1].getAttribute("d")?.includes("Z")).toBe(false);

    // Round on both counts: a mitre at the lead's 48° point spikes past the box.
    for (const path of paths) {
      expect(path.getAttribute("stroke-linejoin")).toBe("round");
      expect(path.getAttribute("stroke-linecap")).toBe("round");
    }

    unmount();
  });
});
