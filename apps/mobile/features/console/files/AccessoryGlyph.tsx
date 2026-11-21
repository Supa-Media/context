import { memo } from "react";
import { G, Path, Svg } from "react-native-svg";
import { ICONS } from "./contextIcons/drawings";
import { JOB_ICON_VIEW_BOX, circle, drawnStrokes, inkFor, type Point, type Stroke } from "./jobIcons/geometry";

/**
 * The writing bar's keys, drawn in Context's own brush (owner, 2026-11-08:
 * "I don't love the icons on top of the keyboard … can we do context style?"),
 * and since the 2026-11-21 roast the right rail's buttons and every microphone
 * key too (Dev2: "the icons on the right need to match our iconography on the
 * left"; "I hate the essentially emoji icon here … like our drawn microphone").
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

/** A panel with its side column: the column on the left, or mirrored on the right. */
const panel = (columnX: number): readonly Stroke[] => [
  [[14, 22], [86, 22], [86, 78], [14, 78], [14, 20]],
  [[columnX, 22], [columnX, 78]],
];

/** The live map: three notes joined by their links. */
const LINKS: readonly Stroke[] = [
  circle(26, 70, 9, -100, 375, 10),
  circle(74, 28, 9, -100, 375, 10),
  circle(76, 74, 9, -100, 375, 10),
  [[33, 64], [67, 34]],
  [[35, 71], [67, 73]],
];

const GLYPHS = {
  checklist: ICONS.checklist!,
  bullets: BULLETS,
  mic: ICONS.mic!,
  search: ICONS.search!,
  calendar: ICONS.calendar!,
  people: ICONS.people!,
  page: ICONS.page!,
  links: LINKS,
  panelLeft: panel(36),
  panelRight: panel(64),
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
