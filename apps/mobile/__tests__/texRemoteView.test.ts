/**
 * `/tex/<handle>`'s remote screen, without a renderer: where the picture sits,
 * how a pinch moves it, where a point on the glass lands on the page, and what
 * each finger gesture sends. `texComputerRender.test.ts` proves the screen
 * draws from these.
 *
 * ## Sabotage record
 *
 * Applied, run, named test seen failing, reverted (2026-10-12):
 *  1. `stageToPage` ignoring `view.zoom` → "a point maps through zoom and pan"
 *     fails.
 *  2. `fitFrame` stretching to the stage instead of letterboxing → "the page
 *     is letterboxed, centred, at its own aspect" fails.
 *  3. `clampView` without the zoom limits → "zoom stays between the limits
 *     and the picture on the stage" fails.
 *  4. A trackpad tap clicking where the finger is, not at the cursor →
 *     "trackpad: a tap clicks where the cursor is, not where the finger is"
 *     fails.
 *  5. The two-finger lock removed (every move both pinches and scrolls) →
 *     "two fingers dragged together scroll and never zoom" fails.
 */

import { describe, expect, test } from "@jest/globals";
import {
  MAX_SCROLL,
  MAX_ZOOM,
  clampView,
  fitFrame,
  followCursor,
  moveCursor,
  pageToStage,
  pinchView,
  restingView,
  scrollFrom,
  stageToPage,
  zoomAt,
  type Point,
  type RemoteView,
} from "../features/tex/remoteView";
import { IDLE, TAP_MS, gestureStep, type Gesture, type InputMode, type Remote } from "../features/tex/remoteGesture";
import type { TexAction } from "../features/tex/texComputer";

/** An iPhone's stage under the top bar, and a desktop-sized page. */
const STAGE = { width: 390, height: 700 };
const PAGE = { width: 1280, height: 860 };
/** 390 / 1280: one stage point is this many page pixels' reciprocal. */
const RATIO = 390 / 1280;

describe("where the picture sits", () => {
  test("the page is letterboxed, centred, at its own aspect", () => {
    const fit = fitFrame(STAGE, PAGE)!;
    expect(fit.width).toBe(390);
    expect(fit.height).toBeCloseTo(860 * RATIO, 6);
    expect(fit.x).toBe(0);
    expect(fit.y).toBeCloseTo((700 - 860 * RATIO) / 2, 6);
    // A tall page on a wide stage letterboxes the other way.
    const side = fitFrame({ width: 1000, height: 500 }, { width: 400, height: 800 })!;
    expect(side).toEqual({ x: 375, y: 0, width: 250, height: 500 });
    expect(fitFrame({ width: 0, height: 700 }, PAGE)).toBeNull();
    expect(fitFrame(STAGE, { width: 1280, height: Number.NaN })).toBeNull();
  });

  test("zoom stays between the limits and the picture on the stage", () => {
    const rest = restingView(STAGE, PAGE);
    expect(clampView({ zoom: 0.2, x: 50, y: 50 }, STAGE, PAGE)).toEqual(rest);
    const big = clampView({ zoom: 40, x: 0, y: 0 }, STAGE, PAGE);
    expect(big.zoom).toBe(MAX_ZOOM);
    // Dragged too far either way, the picture stops at the stage's edge.
    const right = clampView({ zoom: 3, x: 500, y: 500 }, STAGE, PAGE);
    expect(right.x).toBe(0);
    expect(right.y).toBe(0);
    const left = clampView({ zoom: 3, x: -5000, y: -5000 }, STAGE, PAGE);
    expect(left.x).toBeCloseTo(390 - 390 * 3, 6);
    expect(left.y).toBeCloseTo(700 - 860 * RATIO * 3, 6);
    // At 2x the picture is still shorter than the stage: centred vertically, not pinned.
    const two = clampView({ zoom: 2, x: -100, y: -300 }, STAGE, PAGE);
    expect(two.y).toBeCloseTo((700 - 860 * RATIO * 2) / 2, 6);
    expect(two.x).toBe(-100);
  });
});

describe("where a point lands on the page", () => {
  test("a point maps through zoom and pan, and back", () => {
    const rest = restingView(STAGE, PAGE);
    // The middle of the stage is the middle of the page at rest.
    expect(stageToPage({ x: 195, y: 350 }, STAGE, PAGE, rest)).toEqual({ x: 640, y: 430 });
    // Zoomed 2x about the page's top left: a stage point is half as many page pixels.
    const view: RemoteView = { zoom: 2, x: 0, y: rest.y };
    expect(stageToPage({ x: 195, y: rest.y + 100 }, STAGE, PAGE, view)).toEqual({ x: 320, y: Math.round((100 / RATIO / 2) * 10) / 10 });
    // Panned left by 100 points at 2x: 100 points further into the page, 164.1 page px.
    const panned = { ...view, x: -100 };
    expect(stageToPage({ x: 0, y: rest.y }, STAGE, PAGE, panned)).toEqual({ x: Math.round((100 / RATIO / 2) * 10) / 10, y: 0 });
    // And the cursor is drawn exactly where a tap would land on it.
    const back = pageToStage({ x: 900, y: 300 }, STAGE, PAGE, panned)!;
    expect(stageToPage(back, STAGE, PAGE, panned)).toEqual({ x: 900, y: 300 });
  });

  test("the letterbox is not the page", () => {
    const rest = restingView(STAGE, PAGE);
    expect(stageToPage({ x: 100, y: 5 }, STAGE, PAGE, rest)).toBeNull();
    expect(stageToPage({ x: 100, y: 695 }, STAGE, PAGE, rest)).toBeNull();
    expect(stageToPage({ x: 0, y: rest.y }, STAGE, PAGE, rest)).toEqual({ x: 0, y: 0 });
  });

  test("a pinch zooms about the fingers' midpoint and keeps it under them", () => {
    const rest = restingView(STAGE, PAGE);
    const from: [Point, Point] = [{ x: 150, y: 350 }, { x: 250, y: 350 }];
    const to: [Point, Point] = [{ x: 100, y: 350 }, { x: 300, y: 350 }];
    const under = stageToPage({ x: 200, y: 350 }, STAGE, PAGE, rest)!;
    const view = pinchView(rest, from, to, STAGE, PAGE);
    expect(view.zoom).toBeCloseTo(2, 6);
    const after = stageToPage({ x: 200, y: 350 }, STAGE, PAGE, view)!;
    expect(after.x).toBeCloseTo(under.x, 0);
    expect(after.y).toBeCloseTo(under.y, 0);
    // Pinching in past the whole page settles back at rest.
    expect(pinchView(view, to, from, STAGE, PAGE).zoom).toBeCloseTo(1, 6);
    expect(pinchView(rest, to, from, STAGE, PAGE)).toEqual(rest);
    expect(zoomAt(rest, { x: 195, y: 350 }, 99, STAGE, PAGE).zoom).toBe(MAX_ZOOM);
  });

  test("the cursor moves one to one with the finger, and stays on the page", () => {
    const rest = restingView(STAGE, PAGE);
    expect(moveCursor({ x: 640, y: 430 }, { x: 39, y: 0 }, STAGE, PAGE, rest)).toEqual({ x: 768, y: 430 });
    expect(moveCursor({ x: 640, y: 430 }, { x: 39, y: 0 }, STAGE, PAGE, { ...rest, zoom: 4 }).x).toBe(672);
    expect(moveCursor({ x: 10, y: 10 }, { x: -500, y: -500 }, STAGE, PAGE, rest)).toEqual({ x: 0, y: 0 });
    expect(moveCursor({ x: 10, y: 10 }, { x: 5000, y: 5000 }, STAGE, PAGE, rest)).toEqual({ x: 1280, y: 860 });
  });

  test("zoomed in, the view follows the cursor to the edge", () => {
    const view: RemoteView = clampView({ zoom: 4, x: 0, y: -200 }, STAGE, PAGE);
    const followed = followCursor(view, { x: 1200, y: 100 }, STAGE, PAGE);
    const at = pageToStage({ x: 1200, y: 100 }, STAGE, PAGE, followed)!;
    expect(at.x).toBeLessThanOrEqual(390 - 32 + 0.001);
    expect(at.x).toBeGreaterThanOrEqual(0);
    // A cursor already on the stage leaves the view alone.
    const inside = stageToPage({ x: 195, y: 350 }, STAGE, PAGE, view)!;
    expect(followCursor(view, inside, STAGE, PAGE)).toEqual(view);
  });

  test("two fingers up scroll the page down, bounded", () => {
    const rest = restingView(STAGE, PAGE);
    expect(scrollFrom({ x: 0, y: -100 }, STAGE, PAGE, rest)).toEqual({ dx: 0, dy: Math.round(100 / RATIO) });
    expect(scrollFrom({ x: 30, y: 0 }, STAGE, PAGE, rest)).toEqual({ dx: -Math.round(30 / RATIO), dy: 0 });
    expect(scrollFrom({ x: 0, y: -100_000 }, STAGE, PAGE, rest).dy).toBe(MAX_SCROLL);
    expect(Object.is(scrollFrom({ x: 0, y: 0 }, STAGE, PAGE, rest).dy, 0)).toBe(true);
    // Railed: a thumb's sideways drift does not slide the page; a real diagonal does.
    expect(scrollFrom({ x: 5, y: -100 }, STAGE, PAGE, rest).dx).toBe(0);
    expect(scrollFrom({ x: 60, y: -100 }, STAGE, PAGE, rest).dx).toBe(-Math.round(60 / RATIO));
  });
});

/** Runs a gesture: each entry is the fingers on the glass after it, and when. */
function play(mode: InputMode, events: Array<[type: "down" | "move" | "up", touches: Point[], at: number]>, remote?: Remote) {
  let gesture: Gesture = IDLE;
  let state: Remote = remote ?? { view: restingView(STAGE, PAGE), cursor: { x: 640, y: 430 } };
  const sent: TexAction[] = [];
  for (const [type, touches, at] of events) {
    const step = gestureStep({ gesture, remote: state, mode, stage: STAGE, page: PAGE, event: { type, touches, at } });
    gesture = step.gesture;
    state = step.remote;
    sent.push(...step.actions);
  }
  return { gesture, remote: state, sent };
}

describe("what a finger means", () => {
  test("trackpad: a tap clicks where the cursor is, not where the finger is", () => {
    const run = play("trackpad", [
      ["down", [{ x: 20, y: 300 }], 0],
      ["up", [], 120],
    ]);
    expect(run.sent).toEqual([{ kind: "tap", x: 640, y: 430, button: "left" }]);
    expect(run.gesture).toEqual(IDLE);
  });

  test("trackpad: a drag moves the cursor by the distance, then hovers there once", () => {
    const run = play("trackpad", [
      ["down", [{ x: 20, y: 300 }], 0],
      ["move", [{ x: 40, y: 300 }], 30],
      ["move", [{ x: 59, y: 300 }], 60],
      ["up", [], 90],
    ]);
    expect(run.remote.cursor).toEqual({ x: 768, y: 430 });
    expect(run.sent).toEqual([{ kind: "move", x: 768, y: 430 }]);
  });

  test("a long press without moving is not a click", () => {
    expect(play("trackpad", [["down", [{ x: 20, y: 300 }], 0], ["up", [], TAP_MS + 50]]).sent).toEqual([]);
    expect(play("touch", [["down", [{ x: 195, y: 350 }], 0], ["up", [], TAP_MS + 50]]).sent).toEqual([]);
  });

  test("touch: a tap clicks where it lands and takes the cursor there", () => {
    const run = play("touch", [
      ["down", [{ x: 195, y: 350 }], 0],
      ["move", [{ x: 197, y: 351 }], 40],
      ["up", [], 100],
    ]);
    expect(run.sent).toEqual([{ kind: "tap", x: 640, y: 430, button: "left" }]);
    expect(run.remote.cursor).toEqual({ x: 640, y: 430 });
    // On the letterbox, nothing.
    expect(play("touch", [["down", [{ x: 195, y: 10 }], 0], ["up", [], 80]]).sent).toEqual([]);
  });

  test("touch: one finger dragged pans the zoomed picture and sends nothing", () => {
    const zoomed = { view: clampView({ zoom: 3, x: -200, y: -100 }, STAGE, PAGE), cursor: { x: 0, y: 0 } };
    const run = play("touch", [
      ["down", [{ x: 200, y: 300 }], 0],
      ["move", [{ x: 260, y: 330 }], 50],
      ["up", [], 400],
    ], zoomed);
    expect(run.sent).toEqual([]);
    expect(run.remote.view.x).toBeCloseTo(zoomed.view.x + 60, 6);
  });

  test("a pinch zooms and sends nothing", () => {
    const run = play("trackpad", [
      ["down", [{ x: 150, y: 350 }], 0],
      ["down", [{ x: 150, y: 350 }, { x: 250, y: 350 }], 5],
      ["move", [{ x: 100, y: 350 }, { x: 300, y: 350 }], 40],
      ["up", [{ x: 300, y: 350 }], 80],
      ["up", [], 90],
    ]);
    expect(run.remote.view.zoom).toBeCloseTo(2, 6);
    expect(run.sent).toEqual([]);
    expect(run.gesture).toEqual(IDLE);
  });

  test("two fingers dragged together scroll and never zoom", () => {
    const run = play("trackpad", [
      ["down", [{ x: 150, y: 400 }, { x: 250, y: 400 }], 0],
      ["move", [{ x: 150, y: 380 }, { x: 251, y: 380 }], 20],
      ["move", [{ x: 150, y: 300 }, { x: 252, y: 300 }], 40],
      ["up", [], 60],
    ]);
    expect(run.remote.view.zoom).toBe(1);
    expect(run.sent).toEqual([{ kind: "scroll", x: 640, y: 430, dx: 0, dy: Math.round(100 / RATIO) }]);
  });

  test("touch: a scroll lands under the fingers", () => {
    const run = play("touch", [
      ["down", [{ x: 145, y: 350 }, { x: 245, y: 350 }], 0],
      ["move", [{ x: 145, y: 330 }, { x: 245, y: 330 }], 40],
      ["up", [], 60],
    ]);
    expect(run.sent).toEqual([{ kind: "scroll", x: 640, y: 430, dx: 0, dy: Math.round(20 / RATIO) }]);
  });

  test("a finger left down after two-finger work does nothing until it lifts", () => {
    const run = play("trackpad", [
      ["down", [{ x: 150, y: 350 }, { x: 250, y: 350 }], 0],
      ["up", [{ x: 150, y: 350 }], 30],
      ["move", [{ x: 10, y: 10 }], 40],
      ["up", [], 60],
    ]);
    expect(run.sent).toEqual([]);
    expect(run.remote.cursor).toEqual({ x: 640, y: 430 });
  });

  test("a cancelled gesture sends nothing", () => {
    const step = gestureStep({
      gesture: { kind: "one", start: { x: 1, y: 1 }, last: { x: 1, y: 1 }, at: 0, moved: false },
      remote: { view: restingView(STAGE, PAGE), cursor: { x: 0, y: 0 } },
      mode: "trackpad",
      stage: STAGE,
      page: PAGE,
      event: { type: "cancel", touches: [], at: 10 },
    });
    expect(step.actions).toEqual([]);
    expect(step.gesture).toEqual(IDLE);
  });
});
