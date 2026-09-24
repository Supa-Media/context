import type { ReactElement } from "react";
import { View } from "react-native";
import { Circle, Path, Svg } from "react-native-svg";

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
export function bar(
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
export function ring(
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
export function dot(key: string, u: number, color: string, { cx, cy, r }: { cx: number; cy: number; r: number }) {
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
export function rect(
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
 *
 * It takes a `key` like every other primitive here, and that is a fix rather
 * than symmetry: the key used to be the constant `"chevron"`, so `exchange` —
 * the one drawing with two of them — handed React two children with the same
 * key. `keyboardHide` below is the second such drawing, which is what made the
 * constant worth noticing.
 */
export function chevron(
  key: string,
  u: number,
  w: number,
  color: string,
  { cx, cy, side, angle }: { cx: number; cy: number; side: number; angle: number },
) {
  const d = side * u;
  return (
    <View
      key={key}
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
 * A padlock's shackle: an arch, open at the bottom.
 *
 * Three borders on one box rather than a ring with something drawn over its
 * lower half, for the reason `chevron` gives — a corner joined by the layout
 * engine is a clean mitre at every size — and because the alternative needs a
 * *filled* body to hide what it covers. That would cost the lock its keyhole
 * and only work over an opaque ground, and these icons are drawn on a
 * translucent capsule.
 *
 * The top radius is half the box's width, so the two corners meet in a
 * semicircle rather than in two quarter-turns with a flat between them.
 */
export function shackle(
  key: string,
  u: number,
  w: number,
  color: string,
  { x0, y0, x1, y1 }: { x0: number; y0: number; x1: number; y1: number },
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
        borderTopWidth: w,
        borderLeftWidth: w,
        borderRightWidth: w,
        borderTopLeftRadius: ((x1 - x0) / 2) * u,
        borderTopRightRadius: ((x1 - x0) / 2) * u,
        borderColor: color,
      }}
    />
  );
}

/**
 * The mirror of `shackle`: an arch open at the **top**.
 *
 * A microphone's cradle, and the one shape the set could not make out of what
 * it had. It is not a rotated shackle — `transform` is applied after layout, so
 * a turned box lands somewhere else and the "stays inside its box" check in
 * `icons.test.ts` is then measuring a box the drawing has left. Three borders
 * and the two *bottom* radii, positioned where they are declared.
 *
 * `radius` defaults to half the width, which is the semicircle the microphone
 * wants and was the only shape this could draw. `share`'s tray wants the same
 * three borders with an ordinary corner on them — a U with a semicircular foot
 * is a bowl, and the mark is a box you lift something out of — so the radius
 * is a parameter rather than a second near-identical primitive.
 */
export function cradle(
  key: string,
  u: number,
  w: number,
  color: string,
  {
    x0,
    y0,
    x1,
    y1,
    radius,
  }: { x0: number; y0: number; x1: number; y1: number; radius?: number },
) {
  const corner = (radius ?? (x1 - x0) / 2) * u;
  return (
    <View
      key={key}
      style={{
        position: "absolute",
        left: x0 * u,
        top: y0 * u,
        width: (x1 - x0) * u,
        height: (y1 - y0) * u,
        borderBottomWidth: w,
        borderLeftWidth: w,
        borderRightWidth: w,
        borderBottomLeftRadius: corner,
        borderBottomRightRadius: corner,
        borderColor: color,
      }}
    />
  );
}

/**
 * The escape hatch: one drawing as stroked paths, in the same unit space.
 *
 * `lid` used to live here — an eyelid as one rounded border — and it is gone
 * with its only caller. It is worth saying what it could not do, because the
 * eye has now been drawn wrong twice and the reason was the same both times.
 *
 * A rounded border draws a *tapering* stroke. Where a border of width `w` meets
 * one of width zero, the corner between them is drawn as a wedge running to a
 * point, so an arc made this way is at full weight in the middle and at nothing
 * by the ends. Worse, a corner radius is clamped by the box's own height, so a
 * wide shallow arc keeps a dead-straight run across its middle — which is how
 * the first eye came out as two flat bars with a dot between them, a toggle
 * switch. Fixing the flat run by stretching a semicircle sideways only exposed
 * the taper underneath. Walking the true arc as round-capped `bar`s holds the
 * weight and beads at every joint, because the caps that let segments join are
 * the same caps that bulge past a tight curve.
 *
 * A stroked path has none of those problems: one weight all the way round, and
 * the ends meet where they are told to. **`icons.test.ts` asserts exactly
 * that** — it is the guard that would have caught both earlier attempts.
 *
 * `viewBox="0 0 1 1"` keeps path data in the same fractions of the box every
 * other primitive here uses, so a drawing is still readable beside them and
 * still independent of the size asked for. `strokeWidth` is `w / u` for the
 * same reason: the weight arrives in points from `strokeFor` and has to be
 * expressed in the viewBox's units, or a 32pt icon would be drawn at a 20pt
 * icon's proportions.
 */
export function glyph(
  key: string,
  u: number,
  w: number,
  color: string,
  { paths, circles = [] }: { paths: string[]; circles?: { cx: number; cy: number; r: number }[] },
) {
  return (
    <Svg key={key} width={u} height={u} viewBox="0 0 1 1">
      {paths.map((d, index) => (
        <Path
          key={`p${index}`}
          d={d}
          fill="none"
          stroke={color}
          strokeWidth={w / u}
          // Round on both counts. A mitre at the pencil's 48° lead spikes well
          // past the box at any weight this set uses; a butt cap leaves the
          // collar's ends square against a barrel drawn round.
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ))}
      {circles.map((circle, index) => (
        <Circle
          key={`c${index}`}
          cx={circle.cx}
          cy={circle.cy}
          r={circle.r}
          fill="none"
          stroke={color}
          strokeWidth={w / u}
        />
      ))}
    </Svg>
  );
}

/** The shape a family's draw functions take: unit box, stroke weight, colour. */
export type DrawFn = (u: number, w: number, c: string) => ReactElement | ReactElement[];
