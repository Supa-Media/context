import { describe, expect, test } from "@jest/globals";

import { createMapEngine, type MapData } from "../features/console/map/live/engine";
import { PENCILS_LIGHT } from "../features/console/map/live/engine/draw/colour";
import { linesShown, NEAR_PX } from "../features/console/map/live/engine/draw/lines";
import type { DrawEnv } from "../features/console/map/live/engine/draw/env";
import { buildLayout } from "../features/console/map/live/engine/layout";
import { withoutOrphans } from "../features/console/map/live/engine/model";
import type { MapActor } from "../features/console/map/live/engine/timeline";
import { DEFAULT_LOOK, type MapLook } from "../features/console/map/live/look";
import { WHO, ev, fakeCanvas, para, palette } from "./liveMapFixture";

/**
 * SHOW, COLOUR AND LINES — the rest of the map's settings (Dev2, 2026-11-04):
 * `engine/draw/colour.ts`, `engine/draw/lines.ts`, the show switches in
 * `engine/model.ts` and `engine/layout.ts`, and AI trails in `marks.ts`.
 *
 * Sabotage record: `dotColour` always the board's dot → "colour by
 * workspace" fails; `withoutOrphans` returning the graph → "notes with no
 * links can be left out" fails; `linesShown` always true → "lines near the
 * cursor" fails; the agent filter dropped → "AIs can be left out" fails.
 */

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
const graphs = [para("ws-a", "Personal", 10), para("ws-b", "Supa", 10)];
const plan = graphs[0]!.nodes.find((n) => n.path.startsWith("1-projects/launch/"))!.path;
const reads = graphs[0]!.nodes.filter((n) => n.path.startsWith("2-areas/")).slice(0, 3).map((n) => n.path);
const claude: MapActor = { ...WHO.claude, path: plan, doing: "read", at: NOW, reads: [...reads, plan], workspaceId: "ws-a" };

function engineWith(look: Partial<MapLook>, over: Partial<MapData> = {}) {
  const canvas = fakeCanvas(1000, 700);
  const engine = createMapEngine(canvas, { now: () => NOW, requestFrame: () => 1, cancelFrame: () => {}, reducedMotion: true });
  engine.resize(1000, 700, 1);
  engine.setData({
    graphs,
    actors: [],
    events: [],
    scope: { kind: "all" },
    view: "map",
    clock: { kind: "live" },
    palette,
    selfId: null,
    look: { ...DEFAULT_LOOK, ...look },
    ...over,
  });
  const draw = () => {
    canvas.ctx.calls.length = 0;
    return engine.renderAt(NOW) && canvas.ctx.calls;
  };
  return { engine, draw };
}

const fillColours = (calls: ReturnType<ReturnType<typeof engineWith>["draw"]>) => new Set(calls.filter((c) => c.op === "fill").map((c) => c.fillStyle));

describe("colour by", () => {
  test("workspace gives each workspace its own pencil, and one colour gives none", () => {
    const ws = fillColours(engineWith({ colorBy: "workspace" }).draw());
    expect(ws.has(PENCILS_LIGHT[0])).toBe(true);
    expect(ws.has(PENCILS_LIGHT[1])).toBe(true);
    const one = fillColours(engineWith({ colorBy: "none" }).draw());
    expect(PENCILS_LIGHT.some((p) => one.has(p))).toBe(false);
    expect(one.has(palette.dot)).toBe(true);
  });

  test("folder and topic use several pencils; pencil pressure presses the week's writing hard", () => {
    expect(PENCILS_LIGHT.filter((p) => fillColours(engineWith({ colorBy: "folder" }).draw()).has(p)).length).toBeGreaterThan(1);
    expect(PENCILS_LIGHT.filter((p) => fillColours(engineWith({ colorBy: "topic" }).draw()).has(p)).length).toBeGreaterThan(1);
    const edited = engineWith({ colorBy: "pressure" }, { events: [ev.edit(NOW - 3600_000, "ws-a", plan)] }).draw();
    const colours = fillColours(edited);
    expect(colours.has(palette.ink)).toBe(true);
    expect(colours.has(palette.dim)).toBe(true);
  });
});

describe("show", () => {
  test("notes with no links can be left out", () => {
    const g = graphs[0]!;
    const linked = withoutOrphans(g);
    expect(linked.nodes.some((n) => n.path === "index.md")).toBe(false);
    expect(linked.edges.length).toBe(g.edges.length);
    for (const [a, b] of linked.edges) expect(linked.nodes[a] && linked.nodes[b]).toBeTruthy();
    // The same link joins the same two notes as before.
    const [a0, b0] = g.edges[0]!;
    const [a1, b1] = linked.edges[0]!;
    expect([linked.nodes[a1]!.path, linked.nodes[b1]!.path]).toEqual([g.nodes[a0]!.path, g.nodes[b0]!.path]);
  });

  test("Archive can be spread out like any folder", () => {
    const shut = buildLayout(graphs).islands[0]!.folders.find((f) => f.name.includes("archive"))!;
    const open = buildLayout(graphs, [], undefined, 1, true).islands[0]!.folders.find((f) => f.name.includes("archive"))!;
    expect(shut.collapsed).toBe(true);
    expect(open.collapsed).toBeFalsy();
  });

  test("AIs can be left out, and with them their trail", () => {
    const actorShapes = (look: Partial<MapLook>) => {
      const { engine } = engineWith(look, { actors: [claude], scope: { kind: "one", workspaceId: "ws-a" } });
      return engine.renderAt(NOW).shapes.filter((s) => s.target.kind === "actor" || s.target.kind === "pile").length;
    };
    expect(actorShapes({ showAgents: true })).toBe(1);
    expect(actorShapes({ showAgents: false })).toBe(0);
  });
});

describe("AIs at work", () => {
  test("an AI's last reads are joined by one faint pencil trail ending at it", () => {
    const { draw } = engineWith({ showAgents: true }, { actors: [claude], scope: { kind: "one", workspaceId: "ws-a" } });
    const calls = draw();
    let curves = 0;
    let trail = 0;
    for (const c of calls) {
      if (c.op === "beginPath") curves = 0;
      else if (c.op === "quadraticCurveTo") curves += 1;
      else if (c.op === "stroke" && c.strokeStyle === palette.ink && (c.alpha ?? 1) <= 0.36 && curves === 4) trail += 1;
    }
    expect(trail).toBe(1);
  });
});

describe("which lines", () => {
  const a = { key: "a", x: 0, y: 0 } as never;
  const b = { key: "b", x: 500, y: 0 } as never;
  const env = (lines: MapLook["lines"], pointer: { x: number; y: number } | null | undefined, hoverKey: string | null = null) =>
    ({ style: { look: { ...DEFAULT_LOOK, lines } }, pointer, hoverKey, screen: (p: { x: number; y: number }) => p }) as unknown as DrawEnv;

  test("all draws every line, and so does any choice with no mouse to follow", () => {
    expect(linesShown(env("all", { x: 2000, y: 2000 }))(a, b)).toBe(true);
    expect(linesShown(env("near", undefined))(a, b)).toBe(true);
    expect(linesShown(env("hover", undefined))(a, b)).toBe(true);
  });

  test("lines near the cursor: only links with an end near it", () => {
    expect(linesShown(env("near", { x: 10, y: 0 }))(a, b)).toBe(true);
    expect(linesShown(env("near", { x: 250, y: NEAR_PX + 50 }))(a, b)).toBe(false);
    expect(linesShown(env("near", null))(a, b)).toBe(false);
  });

  test("on hover: only the hovered note's links", () => {
    expect(linesShown(env("hover", { x: 0, y: 0 }, "a"))(a, b)).toBe(true);
    expect(linesShown(env("hover", { x: 0, y: 0 }, "c"))(a, b)).toBe(false);
    expect(linesShown(env("hover", { x: 0, y: 0 }, null))(a, b)).toBe(false);
  });
});

describe("one line between folders", () => {
  test("far out, the links between two folders are one pencil stroke", () => {
    const g = para("ws-a", "Personal", 10);
    const inbox = g.nodes.map((n, i) => [n, i] as const).filter(([n]) => n.path.startsWith("0-inbox/")).map(([, i]) => i);
    const areas = g.nodes.map((n, i) => [n, i] as const).filter(([n]) => n.path.startsWith("2-areas/")).map(([, i]) => i);
    const crossing = { ...g, edges: [...g.edges, ...inbox.slice(0, 5).map((a, k) => [a, areas[k]!] as [number, number])] };
    const single = (calls: ReturnType<ReturnType<typeof engineWith>["draw"]>) => {
      let curves = 0;
      let n = 0;
      for (const c of calls) {
        if (c.op === "beginPath") curves = 0;
        else if (c.op === "quadraticCurveTo") curves += 1;
        else if (c.op === "stroke" && c.strokeStyle === palette.edge && curves === 1) n += 1;
      }
      return n;
    };
    const far = (mergeLines: boolean) => {
      const { engine, draw } = engineWith({ mergeLines }, { graphs: [crossing, para("ws-b", "Supa", 10)] });
      engine.zoomTo("all");
      return single(draw());
    };
    expect(far(true)).toBeGreaterThanOrEqual(1);
    expect(far(false)).toBe(0);
  });
});
