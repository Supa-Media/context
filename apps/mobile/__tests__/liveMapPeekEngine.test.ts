/**
 * THE ENGINE'S HALF OF THE NOTE CARD.
 *
 * A tap on a dot says where it landed, so the card can sit beside the dot; a
 * tap on nothing says so, so the card can close; and a camera handed back
 * (the map coming back after a note was opened from it) is where the map
 * draws, before or after its first data.
 */
import { describe, expect, test } from "@jest/globals";
import { createMapEngine, type MapEngineOptions } from "../features/console/map/live/engine/engine";
import type { MapData } from "../features/console/map/live/engine/model";
import { fakeCanvas, palette, para } from "./liveMapFixture";

const W = 1000;
const H = 700;

function mapData(): MapData {
  return { graphs: [para("ws-a", "Personal", 12)], actors: [], events: [], scope: { kind: "one", workspaceId: "ws-a" }, view: "map", clock: { kind: "live" }, palette, selfId: null };
}

/** A canvas whose pointer listeners the test can fire. */
function touchCanvas() {
  const canvas = fakeCanvas(W, H);
  const listeners = new Map<string, (e: unknown) => void>();
  (canvas as unknown as { addEventListener: (t: string, f: (e: unknown) => void) => void }).addEventListener = (type, fn) => listeners.set(type, fn);
  let t = 0;
  const tap = (x: number, y: number) => {
    t += 1000;
    const e = { clientX: x, clientY: y, pointerId: 1, pointerType: "touch", timeStamp: t, preventDefault: () => {} };
    listeners.get("pointerdown")?.(e);
    listeners.get("pointerup")?.(e);
  };
  return { canvas, tap };
}

function engineWith(options: MapEngineOptions) {
  const { canvas, tap } = touchCanvas();
  const engine = createMapEngine(canvas, { now: () => 0, requestFrame: () => 1, cancelFrame: () => {}, reducedMotion: true, minimap: false, ...options });
  engine.resize(W, H, 1);
  return { engine, tap };
}

/** A point on the canvas over a note, found the way a finger would: by looking. */
function noteAt(engine: ReturnType<typeof createMapEngine>): { x: number; y: number; path: string } {
  engine.renderAt(0);
  for (let y = 0; y < H; y += 3) {
    for (let x = 0; x < W; x += 3) {
      const hit = engine.hitTest(x, y);
      if (hit?.kind === "note") return { x, y, path: hit.path };
    }
  }
  throw new Error("no note on the canvas");
}

describe("taps", () => {
  test("a tap on a note says which note and where the finger was", () => {
    const opened: unknown[] = [];
    const { engine, tap } = engineWith({ onOpenNote: (note) => opened.push(note) });
    engine.setData(mapData());
    engine.zoomTo("notes");
    const spot = noteAt(engine);
    tap(spot.x, spot.y);
    expect(opened).toEqual([{ workspaceId: "ws-a", path: spot.path, at: { x: spot.x, y: spot.y } }]);
  });

  test("a tap on nothing says so, and opens nothing", () => {
    const opened: unknown[] = [];
    let empty = 0;
    const { engine, tap } = engineWith({ onOpenNote: (note) => opened.push(note), onTapEmpty: () => (empty += 1) });
    engine.setData(mapData());
    engine.renderAt(0);
    expect(engine.hitTest(2, H - 2)).toBeNull();
    tap(2, H - 2);
    expect(empty).toBe(1);
    expect(opened).toEqual([]);
  });
});

describe("putting the camera back", () => {
  test("handed back after the data, it is where the map draws", () => {
    const { engine } = engineWith({});
    engine.setData(mapData());
    const fitted = engine.getCamera()!.cam;
    const left = { x: fitted.x + 40, y: fitted.y - 25, s: fitted.s * 2 };
    engine.restoreCamera(left);
    expect(engine.getCamera()!.cam).toEqual(left);
  });

  test("handed back before the data, it waits for it rather than being fitted over", () => {
    const first = engineWith({});
    first.engine.setData(mapData());
    const fitted = first.engine.getCamera()!.cam;
    const left = { x: fitted.x + 40, y: fitted.y - 25, s: fitted.s * 2 };
    const { engine } = engineWith({});
    engine.restoreCamera(left);
    engine.setData(mapData());
    expect(engine.getCamera()!.cam).toEqual(left);
    // And the next data, with nothing changed, leaves it alone.
    engine.setData({ ...mapData(), events: [] });
    expect(engine.getCamera()!.cam).toEqual(left);
  });
});
