import type { MapLook } from "../look";
import { OPENING_S, openingDelays, type Opening, type OpeningKind } from "./draw/sketch";
import type { Layout } from "./layout";

/**
 * The map's own motion, apart from what people do on it (Dev2, 2026-11-04):
 * the opening it plays each time it is opened, the 3D tilt that follows the
 * mouse, and the dots breathing. Nothing here ever moves a note away from the
 * pointer: notes stay where they are to be clicked.
 *
 * All of it is the approved prototype's motion, numbers included
 * (`map-pop/round2`): Dev2 found the first build "lack luster" next to it.
 */

/**
 * How long after the map first has notes its opening may still start. Whether
 * the viewer asked for reduced motion is only known a moment after the page
 * mounts (`useReducedMotion` starts `true` so nothing drifts before it is
 * known), and the map's notes are often there before that: an opening that
 * gave up on the first "reduced" never played at all.
 */
export const OPENING_WINDOW_MS = 1500;

/** The opening, played once each time the map is opened, unless reduced motion. */
export function createOpening(enabled: boolean, now: () => number) {
  let done = !enabled;
  let firstAsked: number | null = null;
  let playing: { kind: OpeningKind; start: number } | null = null;
  return {
    /** Start it if it has not played and may still; true when it started. */
    start(kind: OpeningKind, reduced: boolean): boolean {
      if (done) return false;
      if (firstAsked === null) firstAsked = now();
      if (now() - firstAsked > OPENING_WINDOW_MS) {
        done = true;
        return false;
      }
      // Reduced motion, or not known yet: wait, without giving it up.
      if (reduced) return false;
      done = true;
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

/** How far the view turns at most with the mouse, in radians: side to side, and up and down. */
export const YAW_MAX = 0.45;
export const PITCH_MAX = 0.25;

/** How far a point's depth is from the eye, in pixels, for the perspective. */
export const EYE_PX = 900;

/** The tilt's own easing: how many milliseconds it takes to go most of the way to the mouse. */
export const TILT_EASE_MS = 270;

/**
 * The 3D tilt: the mouse's place over the map, eased, from -1 to 1 on each
 * axis (`YAW_MAX` and `PITCH_MAX` turn it into angles). With no mouse over the
 * map it sways slowly on its own, so the depth is there to see.
 */
export function createTilt() {
  let aim: { x: number; y: number } | null = null;
  let cur = { x: 0, y: 0 };
  return {
    /** Lean toward the mouse; null when the mouse is not over the map, to sway. */
    aimAt(x: number | null, y = 0): void {
      aim = x === null ? null : { x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)) };
    },
    /** Ease toward the aim over `dt` ms (`t` is the time, for the sway); true while it is following the mouse. */
    step(dt: number, reduced: boolean, t = 0): boolean {
      if (reduced) {
        cur = { x: 0, y: 0 };
        return false;
      }
      const target = aim ?? sway(t);
      const k = 1 - Math.exp(-dt / TILT_EASE_MS);
      cur = { x: cur.x + (target.x - cur.x) * k, y: cur.y + (target.y - cur.y) * k };
      if (aim === null) return false;
      const moving = Math.abs(aim.x - cur.x) > 0.002 || Math.abs(aim.y - cur.y) > 0.002;
      if (!moving) cur = { ...aim };
      return moving;
    },
    /** Swaying on its own (no mouse over the map). */
    get idle(): boolean {
      return aim === null;
    },
    get value(): { x: number; y: number } {
      return cur;
    },
  };
}

/** The slow sway with no mouse over the map, as the prototype's: a quarter of the reach, never in step. */
export function sway(t: number): { x: number; y: number } {
  const s = t / 1000;
  return { x: (Math.sin(s * 0.3) * 0.25) / YAW_MAX, y: (Math.cos(s * 0.23) * 0.12) / PITCH_MAX };
}

/** How far a breathing dot drifts either way, in pixels, and how fast. */
export const BREATH_PX = 0.9;
export const BREATH_HZ = 0.9;

/** Where a breathing dot is drawn off its place this moment: `seed` keeps neighbours out of step. */
export function breathOffset(t: number, seed: number): { x: number; y: number } {
  const s = t / 1000;
  return { x: Math.sin(s * BREATH_HZ + seed * 1.7) * BREATH_PX, y: Math.cos(s * BREATH_HZ * 1.13 + seed * 2.3) * BREATH_PX };
}

/** Whether the dots breathe in this look. */
export const breathes = (look: MapLook): boolean => look.motion === "breathe";

/** The ambient frame rate, while only the sway and the breathing move: smooth, and half the cost of every frame. */
export const AMBIENT_FRAME_MS = 33;

/** Over this many notes, the ambient frame runs at half that rate. */
export const BIG_MAP_NOTES = 5000;
