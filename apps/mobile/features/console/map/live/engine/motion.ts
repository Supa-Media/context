import type { MapLook } from "../look";
import { OPENING_S, openingDelays, type Opening, type OpeningKind } from "./draw/sketch";
import type { Layout } from "./layout";

/**
 * The map's own motion, apart from what people do on it (Dev2, 2026-11-04):
 * the opening it plays once, the 3D tilt that follows the mouse, and the very
 * slight breathing of the dots. Nothing here ever moves a note away from the
 * pointer: notes stay where they are to be clicked.
 */

/** The opening, played once: the first time the map has notes, unless reduced motion. */
export function createOpening(enabled: boolean, now: () => number) {
  let done = !enabled;
  let playing: { kind: OpeningKind; start: number } | null = null;
  return {
    /** Start it if it has not played; true when it started. */
    start(kind: OpeningKind, reduced: boolean): boolean {
      if (done) return false;
      done = true;
      if (reduced) return false;
      playing = { kind, start: now() };
      return true;
    },
    /** Where it is this frame, or null once over. */
    at(layout: Layout, reduced: boolean): Opening | null {
      if (playing === null) return null;
      const t = (now() - playing.start) / 1000;
      if (reduced || t > OPENING_S[playing.kind] + 0.6) {
        playing = null;
        return null;
      }
      return { kind: playing.kind, t, delay: openingDelays(layout, playing.kind) };
    },
    get active(): boolean {
      return playing !== null;
    },
  };
}

/** How far the drawing leans at most, in pixels of parallax for the nearest folder. */
export const DEPTH_PX = 16;

/**
 * The 3D tilt: the mouse's place over the map, eased, from -1 to 1 on each
 * axis. Folders sit at different depths, so leaning the view moves near ones
 * more than far ones.
 */
export function createTilt() {
  let aim = { x: 0, y: 0 };
  let cur = { x: 0, y: 0 };
  return {
    aimAt(x: number, y: number): void {
      aim = { x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)) };
    },
    /** Ease toward the aim over `dt` ms; true while still moving. */
    step(dt: number, reduced: boolean): boolean {
      if (reduced) {
        cur = { x: 0, y: 0 };
        return false;
      }
      const k = 1 - Math.exp(-dt / 140);
      cur = { x: cur.x + (aim.x - cur.x) * k, y: cur.y + (aim.y - cur.y) * k };
      const moving = Math.abs(aim.x - cur.x) > 0.002 || Math.abs(aim.y - cur.y) > 0.002;
      if (!moving) cur = { ...aim };
      return moving;
    },
    get value(): { x: number; y: number } {
      return cur;
    },
  };
}

/** How much a dot's radius breathes either way, as a share of it. */
export const BREATH = 0.07;

/** Whether the dots breathe in this look. */
export const breathes = (look: MapLook): boolean => look.motion === "breathe";
