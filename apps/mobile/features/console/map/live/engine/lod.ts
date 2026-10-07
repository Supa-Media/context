import { SPACING } from "./pack";
import { band, clamp } from "./math";

/**
 * Level of detail: what is drawn, and how strongly, at a given scale.
 *
 * Everything is keyed to how big a thing is *on screen*, not to the named zoom
 * level, so a small workspace framed whole already shows note names and faces
 * (it is close enough), while a big one at the same level shows bubbles and
 * piles. Each rule fades over a band rather than switching, so zooming never
 * pops.
 */

/** Pixels between neighbouring notes at scale `s`. */
export const notePx = (s: number): number => SPACING * s;

/** A workspace's name and total: legible once it is a bubble, gone once you are inside it. */
export const islandLabelAlpha = (pr: number): number => band(pr, 40, 70, 420, 640);

/** "PROJECTS 312" over a folder bubble. */
export const folderLabelAlpha = (pr: number): number => band(pr, 9, 16, 330, 520);

/** A subfolder's dashed rim. */
export const subRimAlpha = (pr: number): number => clamp((pr - 16) / 20, 0, 1);

/** A subfolder's name. */
export const subLabelAlpha = (pr: number): number => band(pr, 34, 56, 300, 460);

/** Links between notes. */
export const edgeAlpha = (s: number): number => clamp((notePx(s) - 8) / 7, 0, 1);

/** Note names (still subject to collisions). */
export const noteLabelAlpha = (s: number): number => clamp((notePx(s) - 17) / 5, 0, 1);

/** Radius of a resting note dot; hubs grow once there is room to tell them apart. */
export function dotRadius(s: number, deg: number): number {
  const px = notePx(s);
  const base = clamp(0.7 + px * 0.13, 1, 4.6);
  const hub = clamp((px - 10) / 8, 0, 1) * Math.sqrt(deg) * 1.1;
  return base + Math.min(hub, 4.2);
}

/** One face per note up close; further out, a pile per container. */
export const FACES_APART_PX = 18;
export const facesApart = (s: number): boolean => notePx(s) >= FACES_APART_PX;

/** Name tags beside faces. */
export const flagsShown = (s: number): boolean => notePx(s) >= FACES_APART_PX;

/** Paths between workspaces, which only make sense once several fit on screen. */
export const highwayAlpha = (islandPx: number, viewMin: number): number =>
  clamp((viewMin * 0.62 - islandPx) / (viewMin * 0.2), 0, 1);

/** The corner overview, once zoomed in well past "all". */
export const minimapAlpha = (s: number, allScale: number): number => clamp((s / allScale - 1.4) / 0.6, 0, 1);
