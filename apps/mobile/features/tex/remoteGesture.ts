/**
 * What a finger on `/tex/<handle>`'s remote screen means, as Chrome Remote
 * Desktop on a phone reads it. Two modes, chosen from the top bar:
 *
 *  - **trackpad** (the default): one finger drags the cursor by how far it
 *    moves, not to where it is; a tap clicks wherever the cursor is.
 *  - **touch**: a tap clicks where it lands and puts the cursor there; one
 *    finger dragged pans the zoomed picture.
 *
 * In both, two fingers either pinch, zooming the picture about their
 * midpoint, or drag together, scrolling the page under the cursor. Which one
 * is decided once per gesture, by whichever moves first past a threshold, so
 * a scroll never jitters the zoom and a pinch never scrolls the page.
 *
 * A pure reducer: a touch event and the state before it in, the state after
 * it and the actions to send out. Every action is one the screenshot Worker
 * already bounds, and nothing is sent while a finger is still down: a drag's
 * cursor move and a two-finger scroll each go once, when the fingers lift, so
 * a slow drag is one request rather than sixty.
 */

import type { TexAction } from "./texComputer";
import {
  followCursor,
  moveCursor,
  panView,
  pinchView,
  scrollFrom,
  stageToPage,
  type Point,
  type RemoteView,
  type Size,
} from "./remoteView";

export type InputMode = "trackpad" | "touch";

/** How far a finger may wander and still be a tap, in stage points. */
export const TAP_SLOP = 10;
/** How long a press may last and still be a tap. */
export const TAP_MS = 350;
/** How far two fingers must move before the gesture is a pinch or a scroll. */
export const LOCK_SLOP = 12;

export type Gesture =
  | { kind: "idle" }
  | { kind: "one"; start: Point; last: Point; at: number; moved: boolean }
  | { kind: "two"; from: [Point, Point]; last: [Point, Point]; view: RemoteView; lock: "pinch" | "scroll" | null; scrolled: Point }
  /** A two-finger gesture ended with one finger still down: ignored until it lifts. */
  | { kind: "spent" };

export const IDLE: Gesture = { kind: "idle" };

export interface Remote {
  view: RemoteView;
  /** In page CSS pixels. */
  cursor: Point;
}

export interface TouchEvent {
  type: "down" | "move" | "up" | "cancel";
  /** Every finger still on the stage after this event, in stage points. */
  touches: readonly Point[];
  /** Milliseconds, any clock, as long as it is one clock. */
  at: number;
}

export interface Step {
  gesture: Gesture;
  remote: Remote;
  actions: TexAction[];
}

const span = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const pair = (touches: readonly Point[]): [Point, Point] => [touches[0], touches[1]];

export function gestureStep(input: {
  gesture: Gesture;
  remote: Remote;
  mode: InputMode;
  stage: Size;
  page: Size;
  event: TouchEvent;
}): Step {
  const { gesture, remote, mode, stage, page, event } = input;
  const still = (next: Gesture = gesture): Step => ({ gesture: next, remote, actions: [] });
  const { touches } = event;

  if (event.type === "cancel") return { gesture: IDLE, remote, actions: [] };

  // A second finger, whatever the first was doing: a two-finger gesture from here.
  if (touches.length >= 2 && gesture.kind !== "two" && gesture.kind !== "spent") {
    const from = pair(touches);
    return still({ kind: "two", from, last: from, view: remote.view, lock: null, scrolled: { x: 0, y: 0 } });
  }

  switch (gesture.kind) {
    case "idle":
      if (event.type === "down" && touches.length === 1) {
        return still({ kind: "one", start: touches[0], last: touches[0], at: event.at, moved: false });
      }
      return still();

    case "spent":
      return touches.length === 0 ? still(IDLE) : still();

    case "one": {
      if (event.type === "move" && touches.length >= 1) {
        const now = touches[0];
        const delta = { x: now.x - gesture.last.x, y: now.y - gesture.last.y };
        const moved = gesture.moved || span(now, gesture.start) > TAP_SLOP;
        const next: Gesture = { ...gesture, last: now, moved };
        // Below the slop nothing moves, so a tap does not nudge the cursor off its target.
        if (!moved) return still(next);
        const step = gesture.moved ? delta : { x: now.x - gesture.start.x, y: now.y - gesture.start.y };
        if (mode === "trackpad") {
          const cursor = moveCursor(remote.cursor, step, stage, page, remote.view);
          return { gesture: next, remote: { cursor, view: followCursor(remote.view, cursor, stage, page) }, actions: [] };
        }
        return { gesture: next, remote: { ...remote, view: panView(remote.view, step, stage, page) }, actions: [] };
      }
      if (event.type === "up" && touches.length === 0) {
        const tap = !gesture.moved && event.at - gesture.at <= TAP_MS;
        if (mode === "trackpad") {
          if (tap) return { gesture: IDLE, remote, actions: [{ kind: "tap", ...remote.cursor, button: "left" }] };
          // The cursor ends where the finger left it: one move, so the page's hover catches up.
          return { gesture: IDLE, remote, actions: gesture.moved ? [{ kind: "move", ...remote.cursor }] : [] };
        }
        if (!tap) return still(IDLE);
        const at = stageToPage(gesture.start, stage, page, remote.view);
        if (at === null) return still(IDLE);
        return { gesture: IDLE, remote: { ...remote, cursor: at }, actions: [{ kind: "tap", ...at, button: "left" }] };
      }
      return still();
    }

    case "two": {
      if (event.type === "move" && touches.length >= 2) {
        const now = pair(touches);
        let lock = gesture.lock;
        if (lock === null) {
          const stretch = Math.abs(span(now[0], now[1]) - span(gesture.from[0], gesture.from[1]));
          const was = mid(gesture.from[0], gesture.from[1]);
          const drift = span(mid(now[0], now[1]), was);
          if (stretch > LOCK_SLOP && stretch >= drift) lock = "pinch";
          else if (drift > LOCK_SLOP) lock = "scroll";
        }
        if (lock === "pinch") {
          const view = pinchView(gesture.view, gesture.from, now, stage, page);
          return { gesture: { ...gesture, last: now, lock }, remote: { ...remote, view }, actions: [] };
        }
        if (lock === "scroll") {
          const a = mid(gesture.last[0], gesture.last[1]);
          const b = mid(now[0], now[1]);
          // The first step counts from where the fingers went down, so the threshold is not lost.
          const base = gesture.lock === null ? mid(gesture.from[0], gesture.from[1]) : a;
          const scrolled = { x: gesture.scrolled.x + b.x - base.x, y: gesture.scrolled.y + b.y - base.y };
          return still({ ...gesture, last: now, lock, scrolled });
        }
        return still({ ...gesture, last: now });
      }
      if (event.type === "up" && touches.length < 2) {
        const after: Gesture = touches.length === 0 ? IDLE : { kind: "spent" };
        if (gesture.lock !== "scroll") return still(after);
        const { dx, dy } = scrollFrom(gesture.scrolled, stage, page, remote.view);
        if (dx === 0 && dy === 0) return still(after);
        // Trackpad scrolls under the cursor; touch under the fingers, or the cursor when they were on the letterbox.
        const at =
          mode === "touch"
            ? (stageToPage(mid(gesture.from[0], gesture.from[1]), stage, page, remote.view) ?? remote.cursor)
            : remote.cursor;
        return { gesture: after, remote, actions: [{ kind: "scroll", ...at, dx, dy }] };
      }
      return still();
    }
  }
}
