import { DEFAULT_FACE_GROUNDS } from "../../design/tokens/colors";
import { FACE_LOGO_DARK, FACE_LOGO_LIGHT } from "./faceLogo";

/**
 * The face somebody has before they choose one: the Supa mark on a ground
 * colour that comes from their handle (Dev2, 2026-09-28). The same handle is
 * the same colour on every device and in every session, and a person cannot
 * change it except by uploading a photo or choosing a workspace icon.
 *
 * React-free, so the editor's DOM (comment cards, typing flags) draws the same
 * face as the app's own components (`PersonFace`).
 */

export interface DefaultFace {
  index: number;
  ground: string;
  /** The mark, as a data URL, in the ink that reads on `ground`. */
  logo: string;
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
  return hash % DEFAULT_FACE_GROUNDS.length;
}

export function defaultFace(name: string | null | undefined): DefaultFace {
  const index = faceIndex(name);
  const [ground, ink] = DEFAULT_FACE_GROUNDS[index]!;
  return { index, ground, logo: ink === "dark" ? FACE_LOGO_DARK : FACE_LOGO_LIGHT };
}
