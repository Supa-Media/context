import { describe, expect, test } from "@jest/globals";

import { createMapEngine, type MapData } from "../features/console/map/live/engine";
import { buildLayout } from "../features/console/map/live/engine/layout";
import { OPENING_S, openingDelays, scribbleAlpha, scribbleOf } from "../features/console/map/live/engine/draw/sketch";
import { DEFAULT_LOOK, type MapLook } from "../features/console/map/live/look";
import { fakeCanvas, isDotColour, para, palette } from "./liveMapFixture";

/**
 * THE MAP AS A PENCIL DRAWING — `engine/draw/sketch.ts` (Dev2, 2026-11-04).
 *
 * Far out every folder is a pencil scribble and, across workspaces, every
 * workspace gets a loose pencil loop; zooming in, the scribble fades and the
 * notes come through. The first time the map has notes it is drawn in, as the
 * settings pick, and with reduced motion it simply appears.
 *
 * Sabotage record: `scribbleAlpha` always 0 → "far out, folders are
 * scribbles" fails; `maybeOpen` not called → "the map is drawn in" fails;
 * the opening not ending → "and then it stops" fails.
 */

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
const graphs = [para("ws-a", "Personal", 14), para("ws-b", "Supa", 14)];

function engineWith(look: Partial<MapLook> = {}, opts: { opening?: boolean; reducedMotion?: boolean; all?: boolean } = {}) {
  let clock = NOW;
  let frames = 0;
  let pending: (() => void) | null = null;
  const canvas = fakeCanvas(1000, 700);
  const engine = createMapEngine(canvas, {
    now: () => clock,
    requestFrame: (cb: () => void) => {
      pending = cb;
      return (frames += 1);
    },
    cancelFrame: () => {},
    reducedMotion: opts.reducedMotion ?? false,
    opening: opts.opening ?? false,
  });
  engine.resize(1000, 700, 1);
  const data: MapData = {
    graphs,
    actors: [],
    events: [],
    scope: opts.all ? { kind: "all" } : { kind: "one", workspaceId: "ws-a" },
    view: "map",
    clock: { kind: "live" },
    palette,
    selfId: null,
    look: { ...DEFAULT_LOOK, ...look },
  };
  engine.setData(data);
  const draw = (at = clock) => {
    clock = at;
    canvas.ctx.calls.length = 0;
    engine.renderAt(at);
    return canvas.ctx.calls;
  };
  /** Run the frame the engine asked for, at `at`; true when it asked for another. */
  const tick = (at: number) => {
    clock = at;
    const cb = pending;
    pending = null;
    cb?.();
    return pending !== null;
  };
  return { engine, draw, tick };
}

type Calls = ReturnType<ReturnType<typeof engineWith>["draw"]>;
/** Each stroke with how many segments of each kind its path holds. */
function strokes(calls: Calls, color: string) {
  const out: Array<{ curves: number; lines: number }> = [];
  let curves = 0;
  let lines = 0;
  for (const c of calls) {
    if (c.op === "beginPath") curves = lines = 0;
    else if (c.op === "quadraticCurveTo") curves += 1;
    else if (c.op === "lineTo") lines += 1;
    else if (c.op === "stroke" && c.strokeStyle === color) out.push({ curves, lines });
  }
  return out;
}
const dots = (calls: Calls) => calls.filter((c) => c.op === "fill" && isDotColour(c.fillStyle));
const arcs = (calls: Calls) => {
  // Arcs and rects in the resting dots' one path.
  const i = calls.findIndex((c) => c.op === "fill" && isDotColour(c.fillStyle));
  let n = 0;
  for (let j = i - 1; j >= 0 && calls[j]!.op !== "beginPath"; j -= 1) if (calls[j]!.op === "arc" || calls[j]!.op === "rect") n += 1;
  return i < 0 ? 0 : n;
};

describe("far out", () => {
  test("scribbles fade in as notes crowd together, and out as they part", () => {
    expect(scribbleAlpha(10, 1)).toBe(0);
    expect(scribbleAlpha(0.05, 1)).toBe(1);
    expect(scribbleAlpha(0.05, 1)).toBeGreaterThan(scribbleAlpha(0.5, 1.8) - 1e-9);
  });

  test("a folder's scribble stays inside it and is the same every time", () => {
    const layout = buildLayout(graphs);
    const f = layout.islands[0]!.folders.find((x) => !x.collapsed)!;
    const a = scribbleOf(f);
    expect(scribbleOf(f)).toBe(a);
    for (let i = 0; i < a.length; i += 2) expect(Math.hypot(a[i]!, a[i + 1]!)).toBeLessThanOrEqual(0.86);
    const again = scribbleOf({ ...f });
    expect(Array.from(again)).toEqual(Array.from(a));
  });

  test("far out, folders are scribbles and workspaces get pencil loops; up close, neither", () => {
    const { engine, draw } = engineWith({}, { all: true });
    const far = draw();
    expect(strokes(far, palette.edge).some((s) => s.curves > 100)).toBe(true);
    expect(strokes(far, palette.ink).filter((s) => s.lines >= 90).length).toBe(4);
    engine.zoomTo("notes");
    const near = draw(NOW + 10_000);
    expect(strokes(near, palette.edge).some((s) => s.curves > 100)).toBe(false);
    expect(strokes(near, palette.ink).filter((s) => s.lines >= 90).length).toBe(0);
  });
});

describe("the opening", () => {
  test("the map is drawn in: nothing at first, everything once it is over, and then it stops", () => {
    const { draw, tick } = engineWith({ opening: "sketch" }, { opening: true });
    expect(tick(NOW + 500)).toBe(true);
    expect(dots(draw(NOW))).toHaveLength(0);
    expect(arcs(draw(NOW))).toBe(0);
    const mid = arcs(draw(NOW + 1_200));
    const done = arcs(draw(NOW + (OPENING_S.sketch + 1) * 1000));
    expect(mid).toBeGreaterThan(0);
    expect(done).toBeGreaterThan(mid);
    // Once over, nothing keeps the frame loop running.
    expect(tick(NOW + (OPENING_S.sketch + 2) * 1000)).toBe(false);
  });

  test("note names wait for their notes", () => {
    const { draw, engine } = engineWith({ opening: "bloom" }, { opening: true });
    engine.zoomTo("notes");
    const names = (calls: Calls) => calls.filter((c) => c.op === "fillText").length;
    const first = names(draw(NOW + 10));
    const last = names(draw(NOW + (OPENING_S.bloom + 1) * 1000));
    expect(last).toBeGreaterThan(first);
  });

  test("with reduced motion, or with the opening off, the map simply appears", () => {
    const reduced = engineWith({}, { opening: true, reducedMotion: true });
    const off = engineWith({}, { opening: false });
    const full = arcs(off.draw(NOW));
    expect(full).toBeGreaterThan(0);
    expect(arcs(reduced.draw(NOW))).toBe(full);
  });

  test("each opening has its own order", () => {
    const layout = buildLayout(graphs);
    const sketch = openingDelays(layout, "sketch");
    const order = openingDelays(layout, "order");
    const zoom = openingDelays(layout, "zoom");
    expect(sketch.size).toBe(layout.notes.size);
    expect([...zoom.values()].every((d) => d >= 0.9)).toBe(true);
    expect([...order.keys()].some((k) => order.get(k) !== sketch.get(k))).toBe(true);
  });
});
