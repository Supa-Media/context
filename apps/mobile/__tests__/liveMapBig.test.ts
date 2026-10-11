import { beforeEach, describe, expect, test } from "@jest/globals";

import { expandAnswer, graphFromAnswer } from "../features/console/map/live/convert";
import { createMapEngine, buildLayout, type MapData } from "../features/console/map/live/engine";
import { notesNear } from "../features/console/map/live/engine/grid";
import { presentAt } from "../features/console/map/live/engine/timeline";
import { GRAPH_CACHE_MAX_AGE_MS, cachedGraph, forgetGraphs, holdGraph } from "../features/console/map/live/graphCache";
import { endSession, currentEpoch } from "../features/offline/epoch";
import { ev, fakeCanvas, graph, palette } from "./liveMapFixture";

/**
 * A MAP OF EVERY NOTE — the map draws all of a workspace (decided by the
 * owner, 2026-10-08), so its cost per frame must follow what is on screen,
 * not how many notes there are, and its answer arrives compact and is kept
 * in memory for the next visit.
 *
 * Sabotage record: `notesNear` answering no notes → "zoomed in, every note on
 * screen is drawn" fails; `notesNear` ignoring the rectangle → "zoomed in,
 * a frame touches only what is near" fails; `presentAt` caching a set past a
 * create that is still to come → "a note created later is absent before it"
 * fails; `cachedGraph` ignoring the epoch → "a sign-out forgets" fails.
 */

const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);

function big(count: number) {
  const paths: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const root = ["0-inbox", "1-projects", "2-areas", "3-resources"][i % 4]!;
    paths.push(`${root}/${i % 3 ? `sub${i % 9}/` : ""}note ${i}.md`);
  }
  return graph("ws-a", "Personal", paths.sort());
}

const data = (g: ReturnType<typeof big>, over: Partial<MapData> = {}): MapData => ({
  graphs: [g],
  actors: [],
  events: [],
  scope: { kind: "one", workspaceId: "ws-a" },
  view: "map",
  clock: { kind: "live" },
  palette,
  selfId: null,
  ...over,
});

describe("drawing a big workspace", () => {
  const g = big(6_000);
  const W = 1000;
  const H = 700;

  function zoomedIn() {
    const canvas = fakeCanvas(W, H);
    const engine = createMapEngine(canvas, { now: () => NOW, requestFrame: () => 1, cancelFrame: () => {}, reducedMotion: true });
    engine.resize(W, H, 1);
    engine.setData(data(g));
    engine.zoomTo("notes");
    engine.renderAt(NOW + 10_000);
    const frame = engine.renderAt(NOW + 20_000);
    const cam = engine.getCamera()!.cam;
    return { frame, cam };
  }

  test("zoomed in, every note on screen is drawn", () => {
    const { frame, cam } = zoomedIn();
    const layout = buildLayout([g]);
    const drawn = new Set(frame.shapes.filter((s) => s.target.kind === "note").map((s) => (s.target as { path: string }).path));
    let onScreen = 0;
    for (const n of layout.notes.values()) {
      const x = (n.x - cam.x) * cam.s + W / 2;
      const y = (n.y - cam.y) * cam.s + H / 2;
      if (x < 0 || x > W || y < 0 || y > H) continue;
      onScreen += 1;
      expect([n.path, drawn.has(n.path)]).toEqual([n.path, true]);
    }
    expect(onScreen).toBeGreaterThan(20);
  });

  test("zoomed in, a frame touches only what is near", () => {
    const { frame } = zoomedIn();
    const notes = frame.shapes.filter((s) => s.target.kind === "note");
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.length).toBeLessThan(g.nodes.length / 4);
  });

  test("notesNear finds every note inside the rectangle", () => {
    const layout = buildLayout([g]);
    const inside = [...layout.notes.values()].filter((n) => n.x >= -40 && n.x <= 60 && n.y >= -30 && n.y <= 70);
    const near = new Set([...notesNear(layout, -40, -30, 60, 70)].map((n) => n.key));
    for (const n of inside) expect(near.has(n.key)).toBe(true);
    expect(near.size).toBeLessThan(layout.notes.size);
  });
});

describe("who is present, every frame", () => {
  const g = big(40);
  const later = g.nodes[5]!.path;

  test("with nothing still to come, the same set comes back frame after frame", () => {
    // The engine hands the same graphs every frame until its data changes.
    const graphs = [g];
    const a = presentAt(graphs, [ev.read(NOW - 1, "ws-a", later)], NOW);
    const b = presentAt(graphs, [ev.read(NOW - 1, "ws-a", later)], NOW + 16);
    expect(a.size).toBe(40);
    expect(b).toBe(a);
  });

  test("a note created later is absent before it", () => {
    const graphs = [g];
    const events = [ev.create(NOW + 1_000, "ws-a", later)];
    expect(presentAt(graphs, events, NOW).has(`ws-a\n${later}`)).toBe(false);
    expect(presentAt(graphs, events, NOW + 2_000).has(`ws-a\n${later}`)).toBe(true);
    // And the cached whole set was not edited along the way.
    expect(presentAt(graphs, [], NOW).has(`ws-a\n${later}`)).toBe(true);
  });
});

describe("the compact answer", () => {
  test("decodes to the same graph as the object answer", () => {
    const nodes = [
      { path: "0-inbox/a.md", title: "a" },
      { path: "1-projects/plan.md", title: "plan" },
      { path: "1-projects/x/notes", title: "notes" },
    ];
    const edges = [[0, 1], [1, 2], [2, 1]];
    const ws = { id: "w", slug: "w", name: "W", kind: "personal" };
    const object = graphFromAnswer({ nodes, edges }, ws);
    const compact = graphFromAnswer(
      { nodes: [], edges: [], pathChunks: [[nodes[0]!.path, nodes[1]!.path], [nodes[2]!.path]], linkChunks: [[0, 1, 1], [2, 2, 1]] },
      ws,
    );
    expect(compact).toEqual(object);
    expect(expandAnswer({ nodes, edges })).toEqual({ nodes, edges });
  });
});

describe("the map kept in memory", () => {
  beforeEach(() => forgetGraphs());
  const answer = { nodes: [{ path: "a.md", title: "a" }], edges: [] };

  test("an answer read this session is there on the next visit", () => {
    holdGraph("w", answer, currentEpoch(), NOW);
    expect(cachedGraph("w", NOW + 60_000)).toBe(answer);
    expect(cachedGraph("other", NOW)).toBeUndefined();
  });

  test("a sign-out forgets, and a read that lands after it is not kept", () => {
    const before = currentEpoch();
    holdGraph("w", answer, before, NOW);
    endSession();
    expect(cachedGraph("w", NOW)).toBeUndefined();
    holdGraph("w", answer, before, NOW);
    expect(cachedGraph("w", NOW)).toBeUndefined();
  });

  test("an old answer is not drawn", () => {
    holdGraph("w", answer, currentEpoch(), NOW);
    expect(cachedGraph("w", NOW + GRAPH_CACHE_MAX_AGE_MS + 1)).toBeUndefined();
  });
});
