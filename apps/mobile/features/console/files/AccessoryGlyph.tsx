import { memo } from "react";
import { G, Path, Svg } from "react-native-svg";
import { ICONS } from "./contextIcons/drawings";
import { JOB_ICON_VIEW_BOX, arc, circle, drawnStrokes, inkFor, type Point, type Stroke } from "./jobIcons/geometry";

/**
 * The writing bar's keys, drawn in Context's own brush (owner, 2026-11-08:
 * "I don't love the icons on top of the keyboard … can we do context style?"),
 * and since the 2026-11-21 roast the right rail's buttons too (Dev2: "the
 * icons on the right need to match our iconography on the left").
 *
 * The same hand-drawn strokes as the folder icons (`contextIcons/`) and the
 * built-in folders (`jobIcons/geometry.ts`): the checklist is that set's own
 * drawing, the microphone and calendar its shapes pared down for a key, and the bulleted list, which the set has no use for,
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
  circle(24, 72, 7, -100, 375, 10),
  circle(76, 26, 7, -100, 375, 10),
  circle(78, 76, 7, -100, 375, 10),
  [[30, 66], [70, 32]],
  [[32, 73], [70, 75]],
];

/** Mail: an envelope, its flap folded to the middle (the Mail page, the owner's boards of 2026-11-25). */
const MAIL: readonly Stroke[] = [
  [[14, 26], [86, 26], [86, 76], [14, 76], [14, 24]],
  [[16, 28], [50, 54], [84, 28]],
];

/**
 * Agent Mail: the bots folder's robot head with an envelope's flap for a mouth, so the rail's button reads as mail
 * with agents rather than email (Dev2, 2026-11-26: "mail icon can be misleading, add robot icon to show agent").
 */
const AGENT_MAIL: readonly Stroke[] = [
  [[50, 10], [50, 24]],
  [[16, 26], [84, 26], [84, 84], [16, 84], [16, 24]],
  [[36, 40], [36, 50]],
  [[64, 40], [64, 50]],
  [[18, 60], [50, 80], [82, 60]],
];

/*
  At a key's size the set's own drawings carry too much: the calendar's dots and
  the microphone's base and cradle ran into one blot at 18px. These are the same
  shapes with only the strokes that read at that size: a calendar's page, rings
  and header; a microphone's capsule, cradle and stem, as Claude's own is drawn.
*/
const CALENDAR: readonly Stroke[] = [
  [[16, 24], [84, 24], [84, 84], [16, 84], [16, 22]],
  [[16, 44], [84, 44]],
  [[34, 12], [34, 30]],
  [[66, 12], [66, 30]],
];
const MIC: readonly Stroke[] = [
  [...arc(50, 28, 15, 15, 180, 360, 8), ...arc(50, 48, 15, 15, 0, 180, 8), [35, 27]],
  arc(50, 50, 29, 26, 0, 180, 10),
  [[50, 76], [50, 90]],
];

const GLYPHS = {
  checklist: ICONS.checklist!,
  bullets: BULLETS,
  mic: MIC,
  search: ICONS.search!,
  calendar: CALENDAR,
  people: ICONS.people!,
  page: ICONS.page!,
  key: ICONS.key!,
  links: LINKS,
  mail: MAIL,
  agentMail: AGENT_MAIL,
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
