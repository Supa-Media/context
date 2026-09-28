import { DEFAULT_FACE_PALETTES } from "../../design/tokens/colors";

/**
 * The face somebody has before they choose one: a drawn head and shoulders
 * whose colours come from their handle (Dev2, 2026-09-28). The same handle is
 * the same colours on every device and in every session, and a person cannot
 * change them except by uploading a photo or choosing a workspace icon.
 *
 * React-free, so the editor's DOM (comment cards, typing flags) draws the same
 * figure as the app's own components (`PersonFace`), from `defaultFaceSvg`.
 */

export interface DefaultFace {
  index: number;
  groundTop: string;
  groundBottom: string;
  shirt: string;
  skin: string;
  hair: string;
}

/**
 * FNV-1a over the handle's lowercase characters, without its `@`, so `@Seyi`,
 * `@seyi` and `seyi` are one person. Deliberately a fixed algorithm rather
 * than anything seeded: the whole point is that it never changes.
 */
export function faceIndex(name: string | null | undefined): number {
  const key = (name ?? "").trim().replace(/^@/, "").toLowerCase();
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % DEFAULT_FACE_PALETTES.length;
}

export function defaultFace(name: string | null | undefined): DefaultFace {
  const index = faceIndex(name);
  const [groundTop, groundBottom, shirt, skin, hair] = DEFAULT_FACE_PALETTES[index]!;
  return { index, groundTop, groundBottom, shirt, skin, hair };
}

/**
 * The figure's shapes on a 100×100 box, shared by both renderers: shoulders,
 * then the face, then the hair over the top of it, which is what leaves the
 * chin showing as a crescent in the mockup.
 */
export const FACE_SHAPES = {
  shirt: { cx: 50, cy: 108, rx: 46, ry: 40 },
  skin: { cx: 50, cy: 46, r: 22 },
  hair: { cx: 50, cy: 32, r: 24 },
} as const;
