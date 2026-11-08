import { memo } from "react";
import { G, Path, Svg } from "react-native-svg";
import { ICONS } from "./contextIcons/drawings";
import { JOB_ICON_VIEW_BOX, drawnStrokes, inkFor, type Point, type Stroke } from "./jobIcons/geometry";

/**
 * The writing bar's keys, drawn in Context's own brush (owner, 2026-11-08:
 * "I don't love the icons on top of the keyboard … can we do context style?").
 *
 * The same hand-drawn strokes as the folder icons (`contextIcons/`) and the
 * built-in folders (`jobIcons/geometry.ts`): the checklist and microphone are
 * that set's own drawings, and the bulleted list, which the set has no use for,
 * is drawn here in the same 100-unit box.
 *
 * Decorative: every key carries its own accessible name.
 */

const dot = (x: number, y: number): Point[] => [[x - 0.6, y], [x + 0.6, y]];

const BULLETS: readonly Stroke[] = [
  dot(20, 28), [[38, 28], [84, 28]],
  dot(20, 50), [[38, 50], [84, 50]],
  dot(20, 72), [[38, 72], [84, 72]],
];

const GLYPHS = {
  checklist: ICONS.checklist!,
  bullets: BULLETS,
  mic: ICONS.mic!,
} as const;

export type AccessoryGlyphName = keyof typeof GLYPHS;

export const AccessoryGlyph = memo(function AccessoryGlyph({
  name,
  size,
  color,
}: {
  name: AccessoryGlyphName;
  size: number;
  color: string;
}) {
  const strokes = drawnStrokes(`accessory:${name}`, name, GLYPHS[name]);
  const { width, dryWidth, dryOpacity } = inkFor(size);
  return (
    <Svg width={size} height={size} viewBox={JOB_ICON_VIEW_BOX} fill="none">
      <G stroke={color} strokeLinecap="round" strokeLinejoin="round" fill="none">
        {strokes.map((stroke, index) => (
          <G key={index}>
            <Path d={stroke.d} strokeWidth={width} />
            {dryWidth === undefined ? null : <Path d={stroke.dry} strokeWidth={dryWidth} opacity={dryOpacity} />}
          </G>
        ))}
      </G>
    </Svg>
  );
});
