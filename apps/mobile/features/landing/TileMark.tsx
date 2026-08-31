import { StyleSheet, View } from "react-native";
import { Line } from "../design/components/Line";
import type { Point } from "../design/geometry";
import { useColors, type Colors } from "../design/theme";

/**
 * The abstract line-art marks on the four floating tiles.
 *
 * The mockup draws these as inline `<svg>` paths on a 44×44 viewBox. Without
 * `react-native-svg` they are rebuilt from the same coordinates using `Line`
 * (a rotated View) plus bordered circles and rectangles — every one of these
 * four glyphs happens to be straight strokes and simple shapes, so nothing is
 * lost but the round line caps.
 */

export const GLYPH_SIZE = 44;

export interface Glyph {
  strokes: Array<[Point, Point]>;
  circles?: Array<{ c: Point; r: number }>;
  rects?: Array<{ x: number; y: number; w: number; h: number; r: number }>;
  /**
   * The palette token to draw in, not a colour.
   *
   * These four glyphs used to carry `#FB9256`, `#F2F2F4` and `#7DA6F5` —
   * `warm`, `text` and `codeKey` typed out by hand. Copies of a palette are
   * how a second appearance ships with three marks still painted for the
   * first one, so the constant names the token and `TileMark` resolves it.
   */
  color: keyof Colors;
  width?: number;
}

/** A burst — `M22 5v34 M5 22h34 M10 10l24 24 M34 10L10 34` */
export const BURST: Glyph = {
  color: "warm",
  strokes: [
    [{ x: 22, y: 5 }, { x: 22, y: 39 }],
    [{ x: 5, y: 22 }, { x: 39, y: 22 }],
    [{ x: 10, y: 10 }, { x: 34, y: 34 }],
    [{ x: 34, y: 10 }, { x: 10, y: 34 }],
  ],
};

/** A cube — `M22 4l16 9v18l-16 9-16-9V13z` plus its three internal edges. */
export const CUBE: Glyph = {
  color: "text",
  strokes: [
    [{ x: 22, y: 4 }, { x: 38, y: 13 }],
    [{ x: 38, y: 13 }, { x: 38, y: 31 }],
    [{ x: 38, y: 31 }, { x: 22, y: 40 }],
    [{ x: 22, y: 40 }, { x: 6, y: 31 }],
    [{ x: 6, y: 31 }, { x: 6, y: 13 }],
    [{ x: 6, y: 13 }, { x: 22, y: 4 }],
    [{ x: 22, y: 22 }, { x: 38, y: 13 }],
    [{ x: 22, y: 22 }, { x: 22, y: 40 }],
    [{ x: 22, y: 22 }, { x: 6, y: 13 }],
  ],
};

/** A document — a rounded rect with three rules. */
export const DOCUMENT: Glyph = {
  color: "text",
  rects: [{ x: 8, y: 6, w: 28, h: 32, r: 3 }],
  strokes: [
    [{ x: 15, y: 15 }, { x: 29, y: 15 }],
    [{ x: 15, y: 22 }, { x: 29, y: 22 }],
    [{ x: 15, y: 29 }, { x: 23, y: 29 }],
  ],
};

/** A hub — one node with four satellites, which is the product in one mark. */
export const HUB: Glyph = {
  color: "codeKey",
  circles: [
    { c: { x: 22, y: 22 }, r: 5.5 },
    { c: { x: 9, y: 11 }, r: 3.6 },
    { c: { x: 35, y: 11 }, r: 3.6 },
    { c: { x: 9, y: 33 }, r: 3.6 },
    { c: { x: 35, y: 33 }, r: 3.6 },
  ],
  strokes: [
    [{ x: 18.4, y: 18.4 }, { x: 11.6, y: 13.6 }],
    [{ x: 25.6, y: 18.4 }, { x: 32.4, y: 13.6 }],
    [{ x: 18.4, y: 25.6 }, { x: 11.6, y: 30.4 }],
    [{ x: 25.6, y: 25.6 }, { x: 32.4, y: 30.4 }],
  ],
};

export function TileMark({ glyph, size = GLYPH_SIZE }: { glyph: Glyph; size?: number }) {
  const ink = useColors()[glyph.color];
  const k = size / GLYPH_SIZE;
  const stroke = (glyph.width ?? 2.1) * k;
  const scale = (p: Point): Point => ({ x: p.x * k, y: p.y * k });

  return (
    <View style={[styles.glyph, { width: size, height: size, opacity: 0.92 }]} aria-hidden>
      {glyph.rects?.map((rect, index) => (
        <View
          key={`r-${index}`}
          style={{
            position: "absolute",
            left: rect.x * k,
            top: rect.y * k,
            width: rect.w * k,
            height: rect.h * k,
            borderRadius: rect.r * k,
            borderWidth: stroke,
            borderColor: ink,
          }}
        />
      ))}
      {glyph.circles?.map((circle, index) => (
        <View
          key={`c-${index}`}
          style={{
            position: "absolute",
            left: (circle.c.x - circle.r) * k,
            top: (circle.c.y - circle.r) * k,
            width: circle.r * 2 * k,
            height: circle.r * 2 * k,
            borderRadius: circle.r * k,
            borderWidth: stroke,
            borderColor: ink,
          }}
        />
      ))}
      {glyph.strokes.map(([from, to], index) => (
        <Line
          key={`s-${index}`}
          from={scale(from)}
          to={scale(to)}
          color={ink}
          thickness={stroke}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  glyph: { position: "relative" },
});
