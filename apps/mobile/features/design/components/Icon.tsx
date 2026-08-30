import type { ReactElement } from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import { colors } from "../tokens";

/**
 * The icon set, drawn from `View`s.
 *
 * ## Why this exists
 *
 * Every control in this app used to carry a Unicode character — `☰` for the
 * file tree, `⌕` for search, `＋` for new, `✓` for save. `BottomBar` measured
 * them in Chromium at 19px and found `☰` 17px wide, `＋` 19 and `⌕` **10.6**,
 * and drew the correct conclusion for a toolbar of four of them: a bare-glyph
 * row "reads as three buttons and a smudge". Its answer was a caption under
 * every one, which normalises the row and is also how a phone toolbar ends up
 * looking like a 2011 tab bar rather than like Obsidian's.
 *
 * These are the same size as each other because they are drawn in the same box
 * at the same stroke width, which is what an icon set *is*. The captions are
 * no longer load-bearing, and `BottomBar` says so where it used to argue for
 * them.
 *
 * ## Why not an icon font or an SVG library
 *
 * `react-native-svg` is the obvious answer and it is a **native** dependency:
 * it lands in `native-deps.json`, needs a new development build on both
 * platforms before anybody can see a single icon, and buys nothing this app
 * needs — there is no icon here with a curve a rectangle cannot fake, and the
 * two that have one (the search lens, a dot) are circles, which `borderRadius`
 * draws exactly. An icon font is worse again: a binary in the repo, a load
 * that can fail, and a glyph box we would be back to fighting.
 *
 * A `View` with a background colour is a `<div>` on web and a layer on native.
 * Rotation is `transform`, which both platforms have. That is the whole
 * toolkit, and it costs no dependency and no build.
 *
 * ## The rules
 *
 * - **One box.** Every icon occupies exactly `size × size`, so a row of them
 *   aligns without per-icon nudging. Nothing draws outside it.
 * - **One stroke.** `strokeFor` derives the weight from the size, so a 16pt
 *   icon and a 24pt icon look like the same family rather than like two.
 *   Callers may override it; almost none should.
 * - **Geometry is fractions of the box**, never points. An icon asked for at
 *   28 is the same drawing as one asked for at 16, and adding a point of size
 *   cannot silently move a stroke off centre.
 * - **Decorative, always.** An icon is `aria-hidden` and has no accessible
 *   name of its own — the control around it carries one. There is no `label`
 *   prop, because a prop that is usually omitted is how a screen reader ends
 *   up announcing "button".
 * - **It says which icon it is, in the DOM.** `data-icon="chevronDown"`, via
 *   `dataSet` — which react-native-web renders as a data attribute and native
 *   ignores. A glyph could be asserted by reading the text content of the
 *   control; an icon drawn from `View`s has no text at all, so without this a
 *   test can only check that *something* decorative is present, and "the
 *   chevron turns over when the sheet opens" becomes unassertable. That is
 *   exactly the shape of guard this repo keeps finding was never checked.
 */

/**
 * Every icon in the set, as a value.
 *
 * An array with the type derived from it, rather than a union with the names
 * typed again in a test. `draw` below is a `switch` with no `default`, so a
 * name added to the union and not to the `switch` returns `undefined` — an
 * icon that renders an empty box of the right size, in a control that still
 * has its accessible name, on a surface with no hover to reveal what it was
 * meant to be. Nothing about that is loud.
 *
 * With the names as a value, `icons.test.ts` walks the whole set and asserts
 * each one draws something. The list is the guard; the union follows it.
 *
 * **It holds what is drawn today and nothing else.** A first pass also carried
 * a hamburger, a sliders mark, a book, a share arrow and a wastebasket, none of
 * which had a caller — a set of speculative marks is a set nobody checks, and
 * the one that eventually gets used is the one drawn against no real control.
 * Add an icon when a control needs it, in the same change as the control.
 */
export const ICON_NAMES = [
  /** The sidebar toggle, as Obsidian draws it: a pane with its leading column filled. */
  "panelLeft",
  "search",
  "plus",
  "check",
  "close",
  "chevronLeft",
  "chevronRight",
  "chevronUp",
  "chevronDown",
  "arrowLeft",
  "arrowRight",
  "more",
  "folder",
  "file",
  /** The Map pane: nodes with edges between them. */
  "constellation",
  /** The Connections pane: a two-way exchange, which is what a grant is. */
  "exchange",
] as const;

export type IconName = (typeof ICON_NAMES)[number];

/**
 * The stroke weight for a box of this size.
 *
 * Rounded to a half point rather than to a whole one: on a 2x or 3x screen a
 * half point is a whole pixel, and clamping to integers makes a 16pt icon
 * either 25% heavier or 25% lighter than a 20pt one from the same set.
 */
export function strokeFor(size: number): number {
  return Math.max(1, Math.round(size * 0.09 * 2) / 2);
}

/**
 * `dataSet`, spread rather than written as a prop.
 *
 * react-native-web turns `dataSet={{ icon: "search" }}` into
 * `data-icon="search"` and React Native drops it as an unknown prop, which is
 * the behaviour wanted on both — but it is not in React Native's `ViewProps`,
 * so the type has to be widened somewhere. Widened here, in one named place,
 * the way `AppFrame` handles `inert` and `css.ts` handles gradients, rather
 * than with an `as any` at the call site.
 */
function iconData(name: IconName): Record<string, unknown> {
  return { dataSet: { icon: name } };
}

export function Icon({
  name,
  size = 20,
  color = colors.text2,
  strokeWidth,
  style,
}: {
  name: IconName;
  size?: number;
  color?: string;
  /** Override the derived weight. Almost nothing should. */
  strokeWidth?: number;
  style?: ViewStyle;
}) {
  const w = strokeWidth ?? strokeFor(size);
  return (
    <View
      style={[styles.box, { width: size, height: size }, style]}
      {...iconData(name)}
      aria-hidden
      // Native's half of the same claim: `aria-hidden` is a web attribute and
      // is dropped on iOS and Android, where an unlabelled `View` inside a
      // labelled control is still walked by VoiceOver unless it is told not
      // to be.
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
    >
      {draw(name, size, color, w)}
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/*                                  drawing                                   */
/* -------------------------------------------------------------------------- */

/**
 * One stroke, positioned by its **centre** in unit coordinates.
 *
 * Centres rather than corners because every measurement that matters here is a
 * centre — a bar sits on a line, a rotation happens about a midpoint — and
 * converting to a top-left at each call site is where the off-by-half-a-stroke
 * errors live.
 */
function bar(
  key: string,
  u: number,
  w: number,
  color: string,
  { cx, cy, length, angle = 0 }: { cx: number; cy: number; length: number; angle?: number },
) {
  const px = length * u;
  return (
    <View
      key={key}
      style={{
        position: "absolute",
        left: cx * u - px / 2,
        top: cy * u - w / 2,
        width: px,
        height: w,
        borderRadius: w / 2,
        backgroundColor: color,
        ...(angle === 0 ? null : { transform: [{ rotate: `${angle}deg` }] }),
      }}
    />
  );
}

/** A circle outline, centred in unit coordinates. */
function ring(
  key: string,
  u: number,
  w: number,
  color: string,
  { cx, cy, r }: { cx: number; cy: number; r: number },
) {
  const d = r * 2 * u;
  return (
    <View
      key={key}
      style={{
        position: "absolute",
        left: cx * u - d / 2,
        top: cy * u - d / 2,
        width: d,
        height: d,
        borderRadius: d / 2,
        borderWidth: w,
        borderColor: color,
      }}
    />
  );
}

/** A filled dot, centred in unit coordinates. */
function dot(key: string, u: number, color: string, { cx, cy, r }: { cx: number; cy: number; r: number }) {
  const d = r * 2 * u;
  return (
    <View
      key={key}
      style={{
        position: "absolute",
        left: cx * u - d / 2,
        top: cy * u - d / 2,
        width: d,
        height: d,
        borderRadius: d / 2,
        backgroundColor: color,
      }}
    />
  );
}

/** A rectangle outline, positioned by its edges in unit coordinates. */
function rect(
  key: string,
  u: number,
  w: number,
  color: string,
  {
    x0,
    y0,
    x1,
    y1,
    radius = 0.14,
    fill,
  }: { x0: number; y0: number; x1: number; y1: number; radius?: number; fill?: string },
) {
  return (
    <View
      key={key}
      style={{
        position: "absolute",
        left: x0 * u,
        top: y0 * u,
        width: (x1 - x0) * u,
        height: (y1 - y0) * u,
        borderRadius: radius * u,
        ...(fill === undefined ? { borderWidth: w, borderColor: color } : { backgroundColor: fill }),
      }}
    />
  );
}

/**
 * A chevron: a square carrying two adjacent borders, turned to point.
 *
 * Two borders rather than two rotated bars, because a corner joined by the
 * layout engine is a clean mitre at every size and two bars meeting at a point
 * are two bars with a notch between them at exactly the sizes a phone uses.
 */
function chevron(
  u: number,
  w: number,
  color: string,
  { cx, cy, side, angle }: { cx: number; cy: number; side: number; angle: number },
) {
  const d = side * u;
  return (
    <View
      key="chevron"
      style={{
        position: "absolute",
        left: cx * u - d / 2,
        top: cy * u - d / 2,
        width: d,
        height: d,
        borderTopWidth: w,
        borderRightWidth: w,
        borderColor: color,
        transform: [{ rotate: `${angle}deg` }],
      }}
    />
  );
}

/**
 * The drawing, as one or more absolutely-positioned strokes.
 *
 * The return type is written out rather than inferred: inferred, a `switch`
 * missing a case widens to `… | undefined` and compiles, which is the silent
 * empty box `ICON_NAMES` exists to catch. Written, the compiler catches it
 * first and the test is the second line of defence rather than the only one.
 */
function draw(name: IconName, u: number, c: string, w: number): ReactElement | ReactElement[] {
  switch (name) {
    case "panelLeft":
      return [
        rect("frame", u, w, c, { x0: 0.11, y0: 0.16, x1: 0.89, y1: 0.84, radius: 0.16 }),
        rect("pane", u, w, c, {
          x0: 0.11 + w / u,
          y0: 0.16 + w / u,
          x1: 0.37,
          y1: 0.84 - w / u,
          radius: 0.1,
          fill: c,
        }),
      ];

    case "search":
      return [
        ring("lens", u, w, c, { cx: 0.43, cy: 0.43, r: 0.26 }),
        // From the lens's lower-right edge to the corner, on the same 45° the
        // lens's centre lies on, so the handle reads as continuous with it.
        bar("handle", u, w, c, { cx: 0.74, cy: 0.74, length: 0.28, angle: 45 }),
      ];

    case "plus":
      return [
        bar("h", u, w, c, { cx: 0.5, cy: 0.5, length: 0.62 }),
        bar("v", u, w, c, { cx: 0.5, cy: 0.5, length: 0.62, angle: 90 }),
      ];

    case "check":
      return [
        bar("short", u, w, c, { cx: 0.325, cy: 0.625, length: 0.3, angle: 45 }),
        bar("long", u, w, c, { cx: 0.585, cy: 0.5, length: 0.6, angle: -48 }),
      ];

    case "close":
      return [
        bar("a", u, w, c, { cx: 0.5, cy: 0.5, length: 0.66, angle: 45 }),
        bar("b", u, w, c, { cx: 0.5, cy: 0.5, length: 0.66, angle: -45 }),
      ];

    case "chevronRight":
      return chevron(u, w, c, { cx: 0.44, cy: 0.5, side: 0.4, angle: 45 });
    case "chevronLeft":
      return chevron(u, w, c, { cx: 0.56, cy: 0.5, side: 0.4, angle: -135 });
    case "chevronDown":
      return chevron(u, w, c, { cx: 0.5, cy: 0.44, side: 0.4, angle: 135 });
    case "chevronUp":
      return chevron(u, w, c, { cx: 0.5, cy: 0.56, side: 0.4, angle: -45 });

    case "arrowLeft":
      return [
        bar("shaft", u, w, c, { cx: 0.52, cy: 0.5, length: 0.62 }),
        chevron(u, w, c, { cx: 0.34, cy: 0.5, side: 0.34, angle: -135 }),
      ];
    case "arrowRight":
      return [
        bar("shaft", u, w, c, { cx: 0.48, cy: 0.5, length: 0.62 }),
        chevron(u, w, c, { cx: 0.66, cy: 0.5, side: 0.34, angle: 45 }),
      ];

    case "more":
      return [
        dot("a", u, c, { cx: 0.19, cy: 0.5, r: 0.075 }),
        dot("b", u, c, { cx: 0.5, cy: 0.5, r: 0.075 }),
        dot("c", u, c, { cx: 0.81, cy: 0.5, r: 0.075 }),
      ];

    case "folder":
      return [
        // The tab, drawn as a bar so the body's rounded top-left corner is not
        // fighting a second rounded corner two points above it.
        bar("tab", u, w, c, { cx: 0.28, cy: 0.24, length: 0.26 }),
        rect("body", u, w, c, { x0: 0.12, y0: 0.24, x1: 0.88, y1: 0.8, radius: 0.12 }),
      ];

    case "file":
      /*
        Three rules of decreasing length, not two centred ones. Two lines
        centred in a tall rounded rectangle is a battery, which is what the
        first draft of this drew — a document is recognised by its *ragged*
        right edge, so the last rule is short and they sit above centre rather
        than around it.
      */
      return [
        rect("body", u, w, c, { x0: 0.2, y0: 0.1, x1: 0.8, y1: 0.9, radius: 0.11 }),
        bar("l1", u, w, c, { cx: 0.5, cy: 0.36, length: 0.3 }),
        bar("l2", u, w, c, { cx: 0.5, cy: 0.52, length: 0.3 }),
        bar("l3", u, w, c, { cx: 0.42, cy: 0.68, length: 0.14 }),
      ];

    case "constellation":
      return [
        bar("e1", u, w, c, { cx: 0.36, cy: 0.42, length: 0.36, angle: -40 }),
        bar("e2", u, w, c, { cx: 0.6, cy: 0.6, length: 0.44, angle: 42 }),
        dot("n1", u, c, { cx: 0.2, cy: 0.55, r: 0.1 }),
        dot("n2", u, c, { cx: 0.52, cy: 0.28, r: 0.1 }),
        dot("n3", u, c, { cx: 0.78, cy: 0.74, r: 0.1 }),
      ];

    case "exchange":
      return [
        bar("top", u, w, c, { cx: 0.46, cy: 0.34, length: 0.6 }),
        chevron(u, w, c, { cx: 0.66, cy: 0.34, side: 0.28, angle: 45 }),
        bar("bottom", u, w, c, { cx: 0.54, cy: 0.66, length: 0.6 }),
        chevron(u, w, c, { cx: 0.34, cy: 0.66, side: 0.28, angle: -135 }),
      ];

  }
}

const styles = StyleSheet.create({
  box: { position: "relative" },
});
