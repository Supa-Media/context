import { describe, expect, test } from "@jest/globals";

import { createMapEngine, type MapData } from "../features/console/map/live/engine";
import { buildLayout, collapsesToIcon, ICON_R } from "../features/console/map/live/engine/layout";
import { ev, fakeCanvas, para, palette } from "./liveMapFixture";

/**
 * ARCHIVE IS ONE ICON — `engine/layout.ts` `collapseFolder`, the icon in
 * `engine/draw/base.ts` (Dev2, 2026-10-12: "I want the archive folder to be
 * reduced to just an icon, that way it doesnt clutter the map").
 *
 * Archive's notes are not spread out: they all sit on one small box icon
 * with the folder's name under it, draw no dots and no links, and a note
 * moved into Archive still has somewhere to land.
 *
 * Sabotage record: dropping `collapsesToIcon` from `buildIsland` fails
 * "archive takes an icon's room"; letting collapsed notes into `near` fails
 * "no dots and no links for archived notes".
 */

const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);

const data = (over: Partial<MapData> = {}): MapData => ({
  graphs: [para("ws-a", "Personal", 40)],
  actors: [],
  events: [],
  scope: { kind: "one", workspaceId: "ws-a" },
  view: "map",
  clock: { kind: "live" },
  palette,
  selfId: null,
  ...over,
});

function frame(d: MapData, w = 1200, h = 800) {
  const canvas = fakeCanvas(w, h);
  const engine = createMapEngine(canvas, { now: () => NOW, requestFrame: () => 1, cancelFrame: () => {}, reducedMotion: true });
  engine.resize(w, h, 1);
  engine.setData(d);
  canvas.ctx.calls.length = 0;
  engine.renderAt(NOW);
  engine.destroy();
  return canvas.ctx.calls;
}

describe("the Archive folder on the map", () => {
  test("only Archive collapses, however it is numbered", () => {
    expect(collapsesToIcon("4-archive")).toBe(true);
    expect(collapsesToIcon("Archive")).toBe(true);
    expect(collapsesToIcon("1-projects")).toBe(false);
    expect(collapsesToIcon("archived-ideas")).toBe(false);
    expect(collapsesToIcon("")).toBe(false);
  });

  test("archive takes an icon's room, its notes on the icon", () => {
    const layout = buildLayout([para("ws-a", "Personal", 40)]);
    const archive = layout.folders.get("ws-a\n4-archive/")!;
    expect(archive.collapsed).toBe(true);
    expect(archive.r).toBe(ICON_R);
    expect(archive.size).toBe(40);
    const projects = layout.folders.get("ws-a\n1-projects/")!;
    expect(projects.collapsed).toBeUndefined();
    expect(projects.r).toBeGreaterThan(ICON_R * 2);
    for (const n of layout.notes.values()) {
      if (n.sub.folder !== archive) continue;
      expect([n.x, n.y]).toEqual([archive.x, archive.y]);
    }
    // Projects stays the middle even when Archive holds the most.
    const heavy = para("ws-a", "Personal", 4);
    for (let i = 0; i < 300; i += 1) heavy.nodes.push({ path: `4-archive/old ${i}.md`, title: `old ${i}` });
    const big = buildLayout([heavy]);
    const middle = big.islands[0]!.folders.reduce((a, b) => (Math.hypot(a.x, a.y) <= Math.hypot(b.x, b.y) ? a : b));
    expect(middle.name).toBe("1-projects");
  });

  test("no dots and no links for archived notes, one icon and its name", () => {
    const layout = buildLayout([para("ws-a", "Personal", 40)]);
    const archive = layout.folders.get("ws-a\n4-archive/")!;
    const calls = frame(data());
    // The icon is named.
    expect(calls.some((c) => c.op === "fillText" && c.args[0] === "ARCHIVE")).toBe(true);
    const dotArcs = calls.filter((c) => c.op === "arc");
    // Every note in Archive shares one spot; with 40 there, a dot drawn there
    // for each would put 40 arcs on one point.
    const at = new Map<string, number>();
    for (const c of dotArcs) {
      const k = `${Math.round(Number(c.args[0]))},${Math.round(Number(c.args[1]))}`;
      at.set(k, (at.get(k) ?? 0) + 1);
    }
    expect(Math.max(...at.values())).toBeLessThan(5);
    expect(archive.size).toBe(40);
  });

  test("a note moved into Archive still lands, on the icon", () => {
    const layout = buildLayout([para("ws-a", "Personal", 12)], [{ workspaceId: "ws-a", path: "4-archive/done.md" }]);
    const n = layout.notes.get("ws-a\n4-archive/done.md")!;
    const archive = layout.folders.get("ws-a\n4-archive/")!;
    expect([n.x, n.y]).toEqual([archive.x, archive.y]);
    // And the engine draws the move without throwing.
    const calls = frame(data({ events: [ev.move(NOW - 500, "ws-a", "0-inbox/note 0-inbox 0.md", "4-archive/note 0-inbox 0.md")] }));
    expect(calls.length).toBeGreaterThan(0);
  });
});
