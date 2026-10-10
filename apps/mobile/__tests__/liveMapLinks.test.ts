import { describe, expect, test } from "@jest/globals";

import { createMapEngine, type MapData } from "../features/console/map/live/engine";
import { edgeAlpha } from "../features/console/map/live/engine/lod";
import { fakeCanvas, para, palette } from "./liveMapFixture";

/**
 * LINKS AT EVERY ZOOM — `engine/lod.ts` `edgeAlpha`, drawn by `drawLinks`.
 *
 * Links used to fade out entirely once notes sat closer than 8 pixels apart,
 * so a workspace of a few thousand notes framed whole, and every workspace in
 * the all-workspaces view, drew no lines at all: the map read as broken. Far
 * out they are now a faint haze, and full strength up close.
 *
 * Sabotage record: restoring `clamp((notePx(s) - 8) / 7, 0, 1)` fails both
 * tests below.
 */

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);

function linkStrokes(data: MapData) {
  const canvas = fakeCanvas(1000, 700);
  const engine = createMapEngine(canvas, { now: () => NOW, requestFrame: () => 1, cancelFrame: () => {}, reducedMotion: true });
  engine.resize(1000, 700, 1);
  engine.setData(data);
  canvas.ctx.calls.length = 0;
  engine.renderAt(NOW);
  const strokes = canvas.ctx.calls.filter((c) => c.op === "stroke" && c.strokeStyle === palette.edge && (c.alpha ?? 1) > 0);
  engine.destroy();
  return { strokes, lines: canvas.ctx.calls.filter((c) => c.op === "lineTo").length };
}

const data = (graphs: MapData["graphs"], scope: MapData["scope"]): MapData => ({
  graphs,
  actors: [],
  events: [],
  scope,
  view: "map",
  clock: { kind: "live" },
  palette,
  selfId: null,
});

describe("links", () => {
  test("a big workspace framed whole still draws its links", () => {
    const big = para("ws-a", "Personal", 600);
    const { strokes, lines } = linkStrokes(data([big], { kind: "one", workspaceId: "ws-a" }));
    expect(strokes.length).toBeGreaterThan(0);
    expect(lines).toBeGreaterThan(100);
  });

  test("the all-workspaces view draws links too", () => {
    const graphs = [para("ws-a", "Personal", 80), para("ws-b", "Supa", 60), para("ws-c", "Context", 40)];
    const { strokes } = linkStrokes(data(graphs, { kind: "all" }));
    expect(strokes.length).toBeGreaterThan(0);
  });

  test("far out a faint haze, up close full strength", () => {
    expect(edgeAlpha(0.05)).toBeGreaterThan(0.2);
    expect(edgeAlpha(0.05)).toBeLessThan(0.6);
    expect(edgeAlpha(3)).toBe(1);
  });
});
