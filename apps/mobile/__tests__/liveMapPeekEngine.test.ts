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
  const drag = (x: number, y: number, steps: number) => {
    t += 1000;
    const at = (i: number) => ({ clientX: x + i * 12, clientY: y, pointerId: 1, pointerType: "touch", timeStamp: t + i, preventDefault: () => {} });
    listeners.get("pointerdown")?.(at(0));
    for (let i = 1; i <= steps; i += 1) listeners.get("pointermove")?.(at(i));
    listeners.get("pointerup")?.(at(steps));
  };
  return { canvas, tap, drag };
}

function engineWith(options: MapEngineOptions) {
  const { canvas, tap, drag } = touchCanvas();
  const engine = createMapEngine(canvas, { now: () => 0, requestFrame: () => 1, cancelFrame: () => {}, reducedMotion: true, minimap: false, ...options });
  engine.resize(W, H, 1);
  return { engine, tap, drag };
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

describe("clearing the clicked note", () => {
  // Dev2, 2026-11-05: "unselecting a note doesnt work". A workspace and its folders are click
  // targets that cover most of the map, so a click on them must clear the note too.
  const spotOf = (engine: ReturnType<typeof createMapEngine>, kind: "folder" | "workspace") => {
    engine.renderAt(0);
    for (let y = 0; y < H; y += 3) for (let x = 0; x < W; x += 3) if (engine.hitTest(x, y)?.kind === kind) return { x, y };
    throw new Error(`no ${kind} on the canvas`);
  };

  test("a single click on a folder or a workspace clears the note, and opens nothing", () => {
    const opened: unknown[] = [];
    let empty = 0;
    const { engine, tap } = engineWith({ onOpenNote: (note) => opened.push(note), onTapEmpty: () => (empty += 1) });
    engine.setData(mapData());
    const folder = spotOf(engine, "folder");
    tap(folder.x, folder.y);
    // Every workspace at once: each one's whole area is a target.
    engine.setData({ ...mapData(), graphs: [para("ws-a", "Personal", 12), para("ws-b", "Team", 12)], scope: { kind: "all" } });
    const island = spotOf(engine, "workspace");
    tap(island.x, island.y);
    expect(empty).toBe(2);
    expect(opened).toEqual([]);
  });
});

describe("dragging", () => {
  // Dev2, 2026-11-04: a clicked note stays selected while you drag round to see what it links to;
  // only a tap on empty space or on another note changes it.
  test("a drag is no tap: it neither opens a note nor clears one", () => {
    const opened: unknown[] = [];
    let empty = 0;
    const { engine, drag } = engineWith({ onOpenNote: (note) => opened.push(note), onTapEmpty: () => (empty += 1) });
    engine.setData(mapData());
    engine.renderAt(0);
    drag(2, H - 2, 6);
    drag(400, 300, 6);
    expect(empty).toBe(0);
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
