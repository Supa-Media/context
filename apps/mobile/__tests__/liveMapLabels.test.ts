import { describe, expect, test } from "@jest/globals";

import { groupActors, pileKeyFor, flagLine } from "../features/console/map/live/engine/actors";
import { camForLevel, NO_INSET, toScreen } from "../features/console/map/live/engine/camera";
import { Occupancy, overlaps, placeFlag, placeLabel, type Rect } from "../features/console/map/live/engine/labels";
import { buildLayout } from "../features/console/map/live/engine/layout";
import type { ActorView } from "../features/console/map/live/engine/scene";
import { para } from "./liveMapFixture";

/**
 * NAME TAGS, NOTE NAMES AND PILES OF FACES — `engine/labels.ts`, `engine/actors.ts`.
 *
 * Text on the map is only readable if no two pieces of it sit on each other,
 * and on a phone what does not fit is dropped rather than squeezed. Faces
 * gather into one pile per container as you zoom out, on the smallest
 * container that is still big enough on screen to tell apart.
 *
 * Sabotage record: `Occupancy.tryClaim` not checking `hits` → "nothing
 * accepted overlaps" fails; `pileKeyFor` ignoring the scale → the
 * piles-by-level test fails.
 */

function seeded(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

describe("collisions", () => {
  test("nothing accepted overlaps anything else accepted", () => {
    const r = seeded(42);
    const occ = new Occupancy();
    const bounds = { minX: 0, minY: 0, maxX: 800, maxY: 600 };
    let accepted = 0;
    for (let i = 0; i < 300; i += 1) {
      const x = r() * 800;
      const y = r() * 600;
      if (i % 3 === 0) {
        if (placeFlag(occ, x, y, 60 + r() * 60, 22, 13, bounds, false)) accepted += 1;
      } else if (placeLabel(occ, x, y, 30 + r() * 80, 11.5, bounds)) accepted += 1;
    }
    expect(accepted).toBeGreaterThan(20);
    const rects: Rect[] = occ.rects;
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) expect(overlaps(rects[i]!, rects[j]!)).toBe(false);
      expect(rects[i]!.x).toBeGreaterThanOrEqual(0);
      expect(rects[i]!.x + rects[i]!.w).toBeLessThanOrEqual(800);
    }
  });

  test("a flag flips to the left of a face at the right edge", () => {
    const occ = new Occupancy();
    const r = placeFlag(occ, 780, 300, 90, 34, 13, { minX: 0, minY: 0, maxX: 800, maxY: 600 }, false)!;
    expect(r.x + r.w).toBeLessThanOrEqual(780);
  });

  test("on a phone a flag with nowhere to go is dropped; on a desktop it is forced on screen", () => {
    const bounds = { minX: 0, minY: 0, maxX: 120, maxY: 60 };
    expect(placeFlag(new Occupancy(), 60, 30, 200, 34, 13, bounds, false)).toBeNull();
    expect(placeFlag(new Occupancy(), 60, 30, 200, 34, 13, bounds, true)).not.toBeNull();
  });
});

describe("faces and piles", () => {
  const layout = buildLayout([para("ws-a", "Personal", 40)]);
  const vp = { w: 1200, h: 800, inset: NO_INSET };
  const one = { kind: "one", workspaceId: "ws-a" } as const;
  const notes = [...layout.notes.values()];
  const launch = notes.filter((n) => n.path.startsWith("1-projects/launch/"));
  const inbox = notes.filter((n) => n.path.startsWith("0-inbox/"));
  const actor = (id: string, note = launch[0]!): ActorView => ({
    id,
    kind: id.startsWith("a:") ? "agent" : "person",
    name: id,
    self: false,
    x: note.x,
    y: note.y,
    doing: "read",
    note,
    island: layout.islands[0]!,
    across: [],
    readCount: 0,
    riding: false,
    onCard: false,
    movingTo: null,
  });
  const actors = [actor("u:maya", launch[0]), actor("u:jon", launch[1]), actor("a:claude", inbox[0])];

  test("up close everyone is their own face; further out they pile by container", () => {
    const at = (level: "workspace" | "folders" | "notes") => camForLevel(layout, vp, { x: launch[0]!.x, y: launch[0]!.y, s: 1 }, one, level).s;
    const keys = (s: number) => actors.map((a) => pileKeyFor(a, s).split(":")[0]);
    expect(keys(at("notes"))).toEqual(["a", "a", "a"]);
    // Further out, where folders are still big on screen but notes are not,
    // Maya and Jon share Launch's (or Projects') pile and Claude has Inbox's.
    const projects = launch[0]!.sub.folder;
    const inboxFolder = inbox[0]!.sub.folder;
    const mid = 40 / Math.min(projects.r, inboxFolder.r);
    expect(mid).toBeLessThan(1.7);
    const groups = groupActors(actors, mid, (p) => toScreen({ x: 0, y: 0, s: mid }, vp, p));
    expect(groups).toHaveLength(2);
    const projectsPile = groups.find((g) => g.actors.some((a) => a.id === "u:maya"))!;
    expect(projectsPile.actors.map((a) => a.id).sort()).toEqual(["u:jon", "u:maya"]);
    expect(projectsPile.single).toBe(false);
    expect(projectsPile.key.startsWith("f:") || projectsPile.key.startsWith("s:")).toBe(true);
    // Right out, the whole workspace is one pile.
    const far = 30 / layout.islands[0]!.r;
    const whole = groupActors(actors, far, (p) => toScreen({ x: 0, y: 0, s: far }, vp, p));
    expect(whole).toHaveLength(1);
    expect(whole[0]!.key).toBe("i:ws-a");
  });

  test("a subfolder big enough on screen gets its own pile", () => {
    const sub = launch[0]!.sub;
    const s = 60 / sub.r; // the subfolder is 60px across in radius, faces not yet apart
    expect(pileKeyFor(actors[0]!, Math.min(s, 1.7))).toBe(`s:${sub.key}`);
  });

  test("the words under a name say what they are doing, plainly", () => {
    expect(flagLine({ ...actors[0]!, doing: "edit" })).toBe("writing");
    expect(flagLine({ ...actors[0]!, doing: "create" })).toBe("writing a new note");
    expect(flagLine({ ...actors[2]!, doing: "read", readCount: 4 })).toBe("has read 4 notes");
    expect(flagLine({ ...actors[0]!, doing: "move", movingTo: "Supa › Projects" })).toBe("moving to Supa › Projects");
    expect(flagLine({ ...actors[0]!, doing: null })).toBeNull();
  });
});
