import { describe, expect, test } from "@jest/globals";

import {
  NO_INSET,
  camForLevel,
  camLerp,
  cameraInfo,
  fitIsland,
  focusAt,
  levelFor,
  levelScales,
  toScreen,
  toWorld,
  trailFor,
  visibleRect,
  zoom01,
  type Viewport,
} from "../features/console/map/live/engine/camera";
import { buildLayout } from "../features/console/map/live/engine/layout";
import { crumbsOf } from "../features/console/map/live/ui/breadcrumb";
import { para } from "./liveMapFixture";

/**
 * THE LIVE MAP'S CAMERA — `engine/camera.ts`.
 *
 * Semantic zoom has four levels (all workspaces, a workspace, its folders, its
 * notes). The level is read off the camera's scale, nearest in log space to
 * the scale that frames each level round whatever is in the middle; the
 * breadcrumb is as deep as the level. These pin that, plus the two
 * properties the camera's maths must keep: world↔screen are inverses, and an
 * animated move between cameras starts and ends exactly where it should.
 *
 * Sabotage record: `levelFor` comparing linear rather than log distances
 *   → "levels go far to near as the scale grows" fails.
 */

const vp: Viewport = { w: 1200, h: 800, inset: NO_INSET };
const layout = buildLayout([para("ws-a", "Personal", 30), para("ws-b", "Supa", 60)]);
const all = { kind: "all" } as const;

describe("camera", () => {
  test("world and screen are inverses, inset included", () => {
    const v: Viewport = { w: 390, h: 760, inset: { top: 0, right: 0, bottom: 300, left: 0 } };
    const cam = { x: 40, y: -20, s: 1.7 };
    const p = { x: 123, y: 45 };
    const back = toWorld(cam, v, toScreen(cam, v, p));
    expect(back.x).toBeCloseTo(p.x, 9);
    expect(back.y).toBeCloseTo(p.y, 9);
  });

  test("an inset moves the framing into the uncovered rect", () => {
    const v: Viewport = { w: 390, h: 760, inset: { top: 0, right: 0, bottom: 300, left: 0 } };
    const cam = fitIsland(v, layout.islands[0]!);
    const centre = toScreen(cam, v, { x: cam.x, y: cam.y });
    const r = visibleRect(v);
    expect(r.h).toBe(460);
    expect(centre.y).toBeCloseTo(r.y + r.h / 2, 6);
  });

  test("an animated move starts and ends on its cameras and zooms at a constant rate", () => {
    const a = { x: 0, y: 0, s: 0.5 };
    const b = { x: 300, y: -100, s: 8 };
    expect(camLerp(a, b, 0)).toEqual(a);
    const end = camLerp(a, b, 1);
    expect(end.x).toBeCloseTo(b.x, 9);
    expect(end.y).toBeCloseTo(b.y, 9);
    expect(end.s).toBeCloseTo(b.s, 9);
    // Log-space: halfway in time is the geometric mean of the scales.
    expect(camLerp(a, b, 0.5).s).toBeCloseTo(Math.sqrt(0.5 * 8), 9);
  });

  test("each level's own framing reads as that level", () => {
    for (const level of ["all", "workspace", "folders", "notes"] as const) {
      const cam = camForLevel(layout, vp, { x: 0, y: 0, s: 1 }, all, level);
      expect(cameraInfo(layout, vp, cam, all).level).toBe(level);
    }
  });

  test("levels go far to near as the scale grows, and zoom runs 0..1 with them", () => {
    const focus = focusAt(layout, { x: layout.islands[1]!.x, y: layout.islands[1]!.y, s: 1 });
    const ls = levelScales(layout, vp, focus, all);
    expect(ls.levels).toEqual(["all", "workspace", "folders", "notes"]);
    for (let i = 1; i < ls.scales.length; i += 1) expect(ls.scales[i]!).toBeGreaterThan(ls.scales[i - 1]!);
    expect(levelFor(ls.scales[0]! * 0.5, ls)).toBe("all");
    expect(levelFor(ls.scales[3]! * 3, ls)).toBe("notes");
    expect(zoom01(ls.scales[0]!, ls)).toBe(0);
    expect(zoom01(ls.scales[3]!, ls)).toBe(1);
    let last = -1;
    for (let s = ls.scales[0]!; s <= ls.scales[3]!; s *= 1.2) {
      const z = zoom01(s, ls);
      expect(z).toBeGreaterThanOrEqual(last);
      last = z;
    }
  });

  test("one workspace has no 'all' level", () => {
    const one = { kind: "one", workspaceId: "ws-a" } as const;
    const single = buildLayout([para("ws-a", "Personal", 30)]);
    const ls = levelScales(single, vp, focusAt(single, { x: 0, y: 0, s: 1 }), one);
    expect(ls.levels).toEqual(["workspace", "folders", "notes"]);
  });

  test("the breadcrumb is as deep as the level, named by what is in the middle", () => {
    const supa = layout.islands.find((i) => i.name === "Supa")!;
    const projects = supa.folders.find((f) => f.label === "Projects")!;
    const launch = projects.subs.find((s) => s.label === "Launch")!;
    const focus = { island: supa, folder: projects, sub: launch };
    expect(trailFor("all", focus, all)).toEqual(["All workspaces"]);
    expect(trailFor("workspace", focus, all)).toEqual(["All workspaces", "Supa"]);
    expect(trailFor("folders", focus, all)).toEqual(["All workspaces", "Supa", "Projects"]);
    expect(trailFor("notes", focus, all)).toEqual(["All workspaces", "Supa", "Projects", "Launch"]);
    expect(trailFor("folders", focus, { kind: "one", workspaceId: "ws-b" })).toEqual(["Supa", "Projects"]);
  });

  test("the camera's info names the subfolder it is looking into", () => {
    const supa = layout.islands.find((i) => i.name === "Supa")!;
    const launch = supa.folders.find((f) => f.label === "Projects")!.subs.find((s) => s.label === "Launch")!;
    const cam = camForLevel(layout, vp, { x: launch.x, y: launch.y, s: 1 }, all, "notes");
    const info = cameraInfo(layout, vp, cam, all);
    expect(info.level).toBe("notes");
    expect(info.trail).toEqual(["All workspaces", "Supa", "Projects", "Launch"]);
    expect(info.zoom).toBeGreaterThan(0.9);
  });
});

describe("the breadcrumb over the map", () => {
  const stopsAll = { all: 0, workspace: 0.3, folders: 0.6, notes: 1 };
  const stopsOne = { workspace: 0, folders: 0.5, notes: 1 };

  test("every workspace: each crumb zooms out to its level", () => {
    const crumbs = crumbsOf({ trail: ["All workspaces", "Personal", "Projects"], stops: stopsAll }, true);
    expect(crumbs).toEqual([
      { name: "All workspaces", to: "all" },
      { name: "Personal", to: "workspace" },
      { name: "Projects", to: "folders" },
    ]);
  });

  test("one workspace of several: 'All workspaces' still leads, and switches to every workspace", () => {
    // The camera has no "all" level here, so it never names one; a lone
    // "Personal" chip said nothing about where the rest had gone.
    const crumbs = crumbsOf({ trail: ["Personal", "Projects"], stops: stopsOne }, true);
    expect(crumbs).toEqual([
      { name: "All workspaces", to: "scope" },
      { name: "Personal", to: "workspace" },
      { name: "Projects", to: "folders" },
    ]);
  });

  test("a person with one workspace has no 'All workspaces' to go back to", () => {
    expect(crumbsOf({ trail: ["Personal", "Projects"], stops: stopsOne }, false).map((c) => c.name)).toEqual(["Personal", "Projects"]);
    expect(crumbsOf({ trail: ["All workspaces", "Personal"], stops: stopsAll }, false).map((c) => c.name)).toEqual(["Personal"]);
    expect(crumbsOf({ trail: [], stops: stopsOne }, true)).toEqual([]);
  });
});
