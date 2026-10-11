import { describe, expect, test } from "@jest/globals";

import { buildLayout } from "../features/console/map/live/engine/layout";
import { folderLabel, sortFolders, splitPath } from "../features/console/map/live/engine/paths";
import { SPACING } from "../features/console/map/live/engine/pack";
import { graph, para } from "./liveMapFixture";

/**
 * THE LIVE MAP'S LAYOUT — `features/console/map/live/engine/layout.ts`.
 *
 * The map is only useful if a note stays where you last saw it: the same
 * workspace must draw the same on every device and every visit, and a note
 * being written must not shuffle its neighbours. So position is a function of
 * path alone, and these tests hold it to that.
 *
 * Sabotage record (applied, run, reverted):
 *   seeding `scatter` from the note's index instead of a hash of its path
 *      → "adding a note barely moves the others" fails
 *   `packBubbles` without its overlap check
 *      → "bubbles never overlap" and "Projects sits in the middle" fail
 */

const positions = (g: ReturnType<typeof para>[]) => {
  const layout = buildLayout(g);
  return new Map([...layout.notes.values()].map((n) => [n.key, { x: n.x, y: n.y }]));
};

describe("paths", () => {
  test("a path places a note by root folder, then first subfolder; deeper folds in", () => {
    expect(splitPath("index.md")).toEqual({ root: "", sub: "" });
    expect(splitPath("1-projects/launch.md")).toEqual({ root: "1-projects", sub: "" });
    expect(splitPath("1-projects/launch/a/b/plan.md")).toEqual({ root: "1-projects", sub: "launch" });
  });

  test("folder names drop the number and read like words", () => {
    expect(folderLabel("0-inbox")).toBe("Inbox");
    expect(folderLabel("context-launch")).toBe("Context launch");
    expect(folderLabel("Trip to Lagos")).toBe("Trip to Lagos");
  });

  test("PARA folders come first in PARA order, then the rest by name", () => {
    expect(sortFolders(["zettel", "4-archive", "1-projects", "Clients", "0-inbox", "3-resources", "2-areas"])).toEqual([
      "0-inbox",
      "1-projects",
      "2-areas",
      "3-resources",
      "4-archive",
      "Clients",
      "zettel",
    ]);
  });
});

describe("layout", () => {
  test("the same input gives exactly the same positions", () => {
    const a = positions([para()]);
    const b = positions([para()]);
    expect([...a.entries()]).toEqual([...b.entries()]);
  });

  test("the order the graph lists its nodes in does not matter", () => {
    const g = para();
    const shuffled = { ...g, nodes: [...g.nodes].reverse(), edges: [] as [number, number][] };
    const a = positions([{ ...g, edges: [] }]);
    const b = positions([shuffled]);
    for (const [key, p] of a) {
      expect(b.get(key)!.x).toBeCloseTo(p.x, 6);
      expect(b.get(key)!.y).toBeCloseTo(p.y, 6);
    }
  });

  test("adding a note barely moves the others", () => {
    const before = para("ws-a", "Personal", 30);
    const after = { ...before, nodes: [...before.nodes, { path: "1-projects/launch/a brand new note.md", title: "A brand new note" }] };
    const a = positions([before]);
    const b = positions([after]);
    // Measured among the new note's own neighbours, the subfolder it landed in,
    // relative to that subfolder's centre (which may shift as it grows).
    const layoutA = buildLayout([before]);
    const layoutB = buildLayout([after]);
    const subA = layoutA.subs.get("ws-a\n1-projects/launch/")!;
    const subB = layoutB.subs.get("ws-a\n1-projects/launch/")!;
    const moves = subA.notes
      .map((n) => {
        const m = layoutB.notes.get(n.key)!;
        return Math.hypot(m.x - subB.x - (n.x - subA.x), m.y - subB.y - (n.y - subA.y));
      })
      .sort((x, y) => x - y);
    const median = moves[Math.floor(moves.length / 2)]!;
    // Most move by a fraction of the gap between neighbours; none jumps across the bubble.
    expect(median).toBeLessThan(SPACING * 0.6);
    expect(moves[moves.length - 1]!).toBeLessThan(SPACING * 4);
    // Elsewhere, nothing moves relative to its own bubble.
    for (const [k, p] of a) {
      const na = layoutA.notes.get(k)!;
      if (na.sub.key === subA.key) continue;
      const nb = layoutB.notes.get(k)!;
      expect(Math.hypot(nb.x - nb.sub.x - (p.x - na.sub.x), nb.y - nb.sub.y - (p.y - na.sub.y))).toBeLessThan(1e-6);
    }
    expect(b.size).toBe(a.size + 1);
  });

  test("notes keep their distance from each other", () => {
    const layout = buildLayout([para("ws-a", "Personal", 40)]);
    for (const sub of layout.subs.values()) {
      for (let i = 0; i < sub.notes.length; i += 1) {
        for (let j = i + 1; j < sub.notes.length; j += 1) {
          const a = sub.notes[i]!;
          const b = sub.notes[j]!;
          expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(SPACING * 0.6);
        }
      }
    }
  });

  test("every note sits inside its subfolder, and every subfolder inside its folder", () => {
    const layout = buildLayout([para("ws-a", "Personal", 25)]);
    for (const n of layout.notes.values()) {
      expect(Math.hypot(n.x - n.sub.x, n.y - n.sub.y)).toBeLessThanOrEqual(n.sub.r + 1e-6);
    }
    for (const f of layout.folders.values()) {
      for (const s of f.subs) expect(Math.hypot(s.x - f.x, s.y - f.y) + s.r).toBeLessThanOrEqual(f.r + 1e-6);
    }
  });

  test("bubbles never overlap: folders in a workspace, workspaces side by side", () => {
    const layout = buildLayout([para("ws-a", "Personal", 20), para("ws-b", "Supa", 50), para("ws-c", "Context", 8)]);
    for (const island of layout.islands) {
      const fs = island.folders;
      for (let i = 0; i < fs.length; i += 1) {
        for (let j = i + 1; j < fs.length; j += 1) {
          expect(Math.hypot(fs[i]!.x - fs[j]!.x, fs[i]!.y - fs[j]!.y)).toBeGreaterThanOrEqual(fs[i]!.r + fs[j]!.r - 1e-6);
        }
      }
    }
    const is = layout.islands;
    for (let i = 0; i < is.length; i += 1) {
      for (let j = i + 1; j < is.length; j += 1) {
        expect(Math.hypot(is[i]!.x - is[j]!.x, is[i]!.y - is[j]!.y)).toBeGreaterThan(is[i]!.r + is[j]!.r);
      }
    }
  });

  test("Projects sits in the middle of its workspace", () => {
    const layout = buildLayout([para("ws-a", "Personal", 20)]);
    const island = layout.islands[0]!;
    const byName = new Map(island.folders.map((f) => [f.label, f]));
    const dist = (label: string) => Math.hypot(byName.get(label)!.x - island.x, byName.get(label)!.y - island.y);
    for (const other of ["Inbox", "Areas", "Resources", "Archive"]) expect(dist("Projects")).toBeLessThan(dist(other));
  });

  test("links join note keys, and a note's degree counts them", () => {
    const g = graph("ws-a", "A", ["1-projects/a.md", "1-projects/b.md", "1-projects/c.md"]);
    const layout = buildLayout([g]);
    expect(layout.edges).toHaveLength(2);
    expect(layout.notes.get("ws-a\n1-projects/b.md")!.deg).toBe(2);
  });

  test("a path known only from history still gets a place", () => {
    const layout = buildLayout([para()], [{ workspaceId: "ws-a", path: "0-inbox/moved away.md" }]);
    expect(layout.notes.has("ws-a\n0-inbox/moved away.md")).toBe(true);
  });
});
