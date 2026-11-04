import { describe, expect, test } from "@jest/globals";

import { createMapEngine, type MapData } from "../features/console/map/live/engine";
import { DEFAULT_LOOK, type MapLook } from "../features/console/map/live/look";
import type { MapActor } from "../features/console/map/live/engine/timeline";
import { WHO, ev, fakeCanvas, isDotColour, para, palette } from "./liveMapFixture";

/**
 * READING MARKS AND TRACED LINKS — `engine/draw/marks.ts` (Dev2, 2026-11-04).
 *
 * Somebody reading a note is a mark on the note, as the map's settings pick it
 * (a pencil circle by default, a pulse, or a halo), never a stream of dots to
 * the reader. Clicking a note traces its links in pen: one stroke per note one
 * link away, while the rest of the map steps back.
 *
 * Sabotage record: `drawReadingMarks` ignoring `look.reading` → "each marker
 * draws its own way" fails; `drawTrace` not called → "a clicked note traces
 * its links in pen" fails; `TRACE_REST` set to 1 → "the rest steps back"
 * fails.
 */

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
const ws = para("ws-a", "Personal", 12);
const plan = ws.nodes.find((n) => n.path.startsWith("1-projects/launch/"))!.path;
const reader: MapActor = { ...WHO.claude, path: plan, doing: "read", at: NOW, reads: [plan], workspaceId: "ws-a" };

function engineWith(look: Partial<MapLook>, actors: MapActor[] = [reader], reducedMotion = false) {
  const canvas = fakeCanvas(1000, 700);
  const engine = createMapEngine(canvas, { now: () => NOW, requestFrame: () => 1, cancelFrame: () => {}, reducedMotion, onFollow: () => {} });
  engine.resize(1000, 700, 1);
  const data: MapData = {
    graphs: [ws],
    actors,
    events: [ev.read(NOW - 5_000, "ws-a", plan)],
    scope: { kind: "one", workspaceId: "ws-a" },
    view: "map",
    clock: { kind: "live" },
    palette,
    selfId: null,
    look: { ...DEFAULT_LOOK, ...look },
  };
  engine.setData(data);
  return { canvas, engine };
}

const inkStrokes = (calls: ReturnType<typeof fakeCanvas>["ctx"]["calls"]) => calls.filter((c) => c.op === "stroke" && c.strokeStyle === palette.ink);
const inkFills = (calls: ReturnType<typeof fakeCanvas>["ctx"]["calls"]) => calls.filter((c) => c.op === "fill" && c.fillStyle === palette.ink && (c.alpha ?? 1) < 0.3);

describe("somebody reading a note", () => {
  test("each marker draws its own way, and none streams dots to the reader", () => {
    const circle = engineWith({ reading: "circle" });
    circle.canvas.ctx.calls.length = 0;
    circle.engine.renderAt(NOW);
    const c = circle.canvas.ctx.calls;
    expect(inkStrokes(c).length).toBeGreaterThan(0);
    // The pencil circle is drawn with lines, round the note.
    expect(c.filter((x) => x.op === "lineTo").length).toBeGreaterThan(20);
    expect(inkFills(c)).toEqual([]);

    const halo = engineWith({ reading: "halo" });
    halo.canvas.ctx.calls.length = 0;
    halo.engine.renderAt(NOW);
    expect(inkFills(halo.canvas.ctx.calls).length).toBe(2);
    expect(inkStrokes(halo.canvas.ctx.calls)).toEqual([]);

    const pulse = engineWith({ reading: "pulse" });
    pulse.canvas.ctx.calls.length = 0;
    pulse.engine.renderAt(NOW);
    expect(inkStrokes(pulse.canvas.ctx.calls).length).toBe(1);
    expect(inkFills(pulse.canvas.ctx.calls)).toEqual([]);
  });

  test("with nobody reading there is no mark", () => {
    const { canvas, engine } = engineWith({}, []);
    canvas.ctx.calls.length = 0;
    engine.renderAt(NOW);
    expect(inkStrokes(canvas.ctx.calls)).toEqual([]);
  });
});

describe("clicking a note", () => {
  const linked = ws.edges.filter(([a, b]) => ws.nodes[a]!.path === plan || ws.nodes[b]!.path === plan).length;

  test("a clicked note traces its links in pen", () => {
    expect(linked).toBeGreaterThan(0);
    const { canvas, engine } = engineWith({ sketch: 0 }, []);
    engine.select({ workspaceId: "ws-a", path: plan });
    canvas.ctx.calls.length = 0;
    engine.renderAt(NOW);
    const calls = canvas.ctx.calls;
    const pen = inkStrokes(calls);
    expect(pen.length).toBe(1);
    // One curve per linked note, in the path that pen strokes.
    const i = calls.indexOf(pen[0]!);
    let curves = 0;
    for (let j = i - 1; j >= 0 && calls[j]!.op !== "beginPath"; j -= 1) if (calls[j]!.op === "quadraticCurveTo") curves += 1;
    expect(curves).toBe(linked);
  });

  test("the rest steps back while a note is traced, and comes back after", () => {
    const { canvas, engine } = engineWith({}, []);
    const restAlpha = () => {
      canvas.ctx.calls.length = 0;
      engine.renderAt(NOW);
      const fills = canvas.ctx.calls.filter((c) => c.op === "fill" && isDotColour(c.fillStyle));
      return fills[0]?.alpha ?? 1;
    };
    expect(restAlpha()).toBe(1);
    engine.select({ workspaceId: "ws-a", path: plan });
    expect(restAlpha()).toBeLessThan(0.5);
    engine.select(null);
    expect(restAlpha()).toBe(1);
  });
});
