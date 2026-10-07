import { describe, expect, test } from "@jest/globals";

import { buildModel, createMemory, type MapData } from "../features/console/map/live/engine/model";
import { DUR, sceneAt } from "../features/console/map/live/engine/scene";
import {
  actorsAt,
  folderCountsAt,
  highwaysAt,
  histogram,
  momentsOf,
  presentAt,
  readsAt,
} from "../features/console/map/live/engine/timeline";
import type { MapClock, MapEvent } from "../features/console/map/live/types";
import { WHO, ev, graph, palette } from "./liveMapFixture";

/**
 * REPLAY — `engine/timeline.ts`, `engine/scene.ts`.
 *
 * The graphs handed to the map are *now*; a replay at `t` is now with every
 * later event undone. These pin that the state at `t` is a pure function of
 * the inputs (scrub back and forth and you see the same picture), that the
 * sidebar's counts and the replay bar's histogram agree with it, and that the
 * "N moved today" highways and "What an AI is reading" count what they say.
 *
 * Sabotage record: `presentAt` applying later events in time order rather
 * than undoing them newest first → "folder counts follow the notes" fails;
 * `readsAt` without its `seen` set → "reads are listed once, in the order
 * first read" and "following an AI keeps the notes it has read" fail.
 */

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
const MIN = 60_000;

const personal = graph("ws-a", "Personal", [
  "0-inbox/call notes.md",
  "1-projects/launch/plan.md",
  "1-projects/launch/pricing.md",
  "2-areas/health.md",
  "3-resources/reading list.md",
]);
const supa = graph("ws-b", "Supa", ["1-projects/roadmap.md", "1-projects/hiring.md", "2-areas/team.md"], "shared");

const events: MapEvent[] = [
  ev.read(T0 + 1 * MIN, "ws-a", "1-projects/launch/plan.md"),
  ev.read(T0 + 2 * MIN, "ws-a", "2-areas/health.md"),
  ev.read(T0 + 3 * MIN, "ws-a", "1-projects/launch/plan.md"),
  ev.create(T0 + 4 * MIN, "ws-a", "1-projects/launch/pricing.md"),
  // Sorted out of the inbox, then back from Resources to Areas.
  ev.move(T0 + 5 * MIN, "ws-a", "0-inbox/health.md", "3-resources/health.md"),
  ev.move(T0 + 6 * MIN, "ws-a", "3-resources/health.md", "2-areas/health.md"),
  ev.edit(T0 + 7 * MIN, "ws-a", "0-inbox/call notes.md", WHO.maya),
  // Two notes leave Personal for Supa.
  ev.move(T0 + 8 * MIN, "ws-a", "0-inbox/roadmap.md", "1-projects/roadmap.md", WHO.jon, "ws-b"),
  ev.move(T0 + 9 * MIN, "ws-a", "0-inbox/hiring.md", "1-projects/hiring.md", WHO.jon, "ws-b"),
];
const graphs = [personal, supa];
const has = (set: Set<string>, ws: string, path: string) => set.has(`${ws}\n${path}`);

describe("the state at a moment", () => {
  test("a note created later is absent before it was made", () => {
    expect(has(presentAt(graphs, events, T0), "ws-a", "1-projects/launch/pricing.md")).toBe(false);
    expect(has(presentAt(graphs, events, T0 + 4 * MIN), "ws-a", "1-projects/launch/pricing.md")).toBe(true);
  });

  test("a note moved twice is back where it started, and in between, between", () => {
    const at = (t: number) => presentAt(graphs, events, t);
    expect(has(at(T0), "ws-a", "0-inbox/health.md")).toBe(true);
    expect(has(at(T0), "ws-a", "2-areas/health.md")).toBe(false);
    expect(has(at(T0 + 5.5 * MIN), "ws-a", "3-resources/health.md")).toBe(true);
    expect(has(at(T0 + 5.5 * MIN), "ws-a", "0-inbox/health.md")).toBe(false);
    expect(has(at(T0 + 6 * MIN), "ws-a", "2-areas/health.md")).toBe(true);
    expect(has(at(T0 + 6 * MIN), "ws-a", "3-resources/health.md")).toBe(false);
  });

  test("a note that moved between workspaces is in the first before and the second after", () => {
    expect(has(presentAt(graphs, events, T0), "ws-a", "0-inbox/roadmap.md")).toBe(true);
    expect(has(presentAt(graphs, events, T0), "ws-b", "1-projects/roadmap.md")).toBe(false);
    expect(has(presentAt(graphs, events, T0 + 8 * MIN), "ws-b", "1-projects/roadmap.md")).toBe(true);
  });

  test("folder counts follow the notes", () => {
    const before = folderCountsAt(graphs, events, T0);
    // Inbox: call notes, health, roadmap, hiring. Projects: plan (pricing not yet made).
    expect(before["ws-a"]).toEqual({ "0-inbox": 4, "1-projects": 1, "3-resources": 1 });
    expect(before["ws-b"]).toEqual({ "2-areas": 1 });
    const after = folderCountsAt(graphs, events, T0 + 10 * MIN);
    expect(after["ws-a"]).toEqual({ "0-inbox": 1, "1-projects": 2, "2-areas": 1, "3-resources": 1 });
    expect(after["ws-b"]).toEqual({ "1-projects": 2, "2-areas": 1 });
    // Nothing is created or lost by scrubbing: the total only grows by creates.
    const total = (c: Record<string, Record<string, number>>) =>
      Object.values(c).reduce((s, f) => s + Object.values(f).reduce((a, b) => a + b, 0), 0);
    expect(total(after) - total(before)).toBe(1);
  });

  test("the histogram counts each event once, in its slice", () => {
    const h = histogram(events, T0, T0 + 10 * MIN, 5);
    expect(h).toEqual([1, 2, 2, 2, 2]);
    expect(histogram(events, T0, T0 + 10 * MIN, 1)).toEqual([events.length]);
    // [from, to): an event at `to` is outside.
    expect(histogram(events, T0, T0 + 9 * MIN, 9).reduce((a, b) => a + b, 0)).toBe(events.length - 1);
    expect(histogram(events, T0, T0, 4)).toEqual([0, 0, 0, 0]);
  });
});

describe("who, and what they read", () => {
  test("reads are listed once, in the order first read, up to the moment", () => {
    expect(readsAt(events, WHO.claude.id, T0 + 10 * MIN).map((r) => r.path)).toEqual([
      "1-projects/launch/plan.md",
      "2-areas/health.md",
    ]);
    expect(readsAt(events, WHO.claude.id, T0 + 1.5 * MIN).map((r) => r.path)).toEqual(["1-projects/launch/plan.md"]);
    expect(readsAt(events, WHO.maya.id, T0 + 10 * MIN)).toEqual([]);
  });

  test("somebody is on the note of their last event until they have been quiet a while", () => {
    const at = actorsAt(events, T0 + 7.5 * MIN, 10 * MIN);
    const maya = at.find((a) => a.id === WHO.maya.id)!;
    expect(maya).toMatchObject({ path: "0-inbox/call notes.md", doing: "edit", workspaceId: "ws-a" });
    const claude = at.find((a) => a.id === WHO.claude.id)!;
    expect(claude.doing).toBe("create");
    expect(claude.reads).toEqual(["1-projects/launch/plan.md", "2-areas/health.md"]);
    expect(at.find((a) => a.id === WHO.jon.id)).toBeUndefined();
    // Long after, everybody has gone.
    expect(actorsAt(events, T0 + 60 * MIN, 10 * MIN)).toEqual([]);
  });

  test("cross-workspace moves make one highway, counted in its window", () => {
    expect(highwaysAt(events, T0 + 8.5 * MIN, T0)).toEqual([{ a: "ws-a", b: "ws-b", count: 1, lastAt: T0 + 8 * MIN }]);
    expect(highwaysAt(events, T0 + 10 * MIN, T0)[0]!.count).toBe(2);
    expect(highwaysAt(events, T0 + 10 * MIN, T0 + 8.5 * MIN)[0]!.count).toBe(1);
    expect(highwaysAt(events, T0 + 7 * MIN, T0)).toEqual([]);
  });

  test("the replay bar marks new notes and the start of a run of moves, in plain words", () => {
    const marks = momentsOf(events, (_ws, path) => path.split("/").pop()!.replace(/\.md$/, ""));
    expect(marks.map((m) => m.label)).toEqual(["New note: pricing", "Inbox sorter moved notes"]);
  });
});

describe("the replayed scene", () => {
  const data = (speed: 1 | 10 | 60, at = T0): MapData => ({
    graphs,
    actors: [],
    events,
    scope: { kind: "all" },
    view: "map",
    clock: { kind: "replay", from: T0, to: T0 + 10 * MIN, at, speed } as MapClock,
    palette,
    selfId: null,
  });
  const model = (speed: 1 | 10 | 60 = 10) =>
    buildModel(data(speed), createMemory(), T0, { idleMs: 10 * MIN, reducedMotion: false, following: WHO.claude.id });

  test("the same moment draws the same scene, however you got there", () => {
    const m = model();
    const t = T0 + 8 * MIN + 5_000;
    const a = sceneAt(m, t);
    sceneAt(m, T0 + 9 * MIN);
    sceneAt(m, T0);
    const b = sceneAt(model(), t);
    const pick = (s: ReturnType<typeof sceneAt>) => ({
      present: [...s.present].sort(),
      actors: s.actors.map((x) => [x.id, x.x, x.y, x.doing]),
      flights: s.flights.map((f) => [f.from.key, f.to.key, f.k, f.pos.x, f.pos.y]),
      highways: s.highways,
      follow: s.followReads.map((n) => n.key),
    });
    expect(pick(sceneAt(m, t))).toEqual(pick(a));
    expect(pick(b)).toEqual(pick(a));
  });

  test("a move flies for its visual duration at the replay's speed, then lands", () => {
    const m = model(10);
    const start = T0 + 8 * MIN;
    const flightMs = DUR.crossFlight * 1000 * 10;
    const mid = sceneAt(m, start + flightMs / 2).flights.find((f) => f.cross)!;
    expect(mid.k).toBeGreaterThan(0);
    expect(mid.k).toBeLessThan(1);
    expect(mid.landedFor).toBe(-1);
    const landed = sceneAt(m, start + flightMs + 100).flights.find((f) => f.cross);
    if (landed) expect(landed.k).toBe(1);
    expect(sceneAt(m, start + flightMs * 10).flights.find((f) => f.cross)).toBeUndefined();
  });

  test("a highway's count bumps when the note lands, not when it leaves", () => {
    const m = model(10);
    const start = T0 + 8 * MIN;
    const during = sceneAt(m, start + 1000).highways;
    expect(during.length === 0 || during[0]!.count === 0).toBe(true);
    const after = sceneAt(m, start + DUR.crossFlight * 1000 * 10 + 1000).highways;
    expect(after[0]!.count).toBe(1);
    expect(after[0]!.bump).toBeGreaterThan(0);
  });

  test("following an AI keeps the notes it has read, in order", () => {
    const s = sceneAt(model(), T0 + 10 * MIN);
    expect(s.followReads.map((n) => n.path)).toEqual(["1-projects/launch/plan.md", "2-areas/health.md"]);
  });

  test("the clock's idle window keeps people on the map between steps", () => {
    // Half an hour after the last step: gone at the engine's ten minutes, still
    // there when the replay says somebody stays half an hour.
    const t = T0 + 35 * MIN;
    expect(sceneAt(model(), t).actors).toEqual([]);
    const long = { ...data(60), clock: { kind: "replay", from: T0, to: T0 + 60 * MIN, at: T0, speed: 60, idleMs: 30 * MIN } as MapClock };
    const m = buildModel(long, createMemory(), T0, { idleMs: 10 * MIN, reducedMotion: false, following: null });
    expect(m.idleMs).toBe(30 * MIN);
    expect(sceneAt(m, t).actors.map((a) => a.id).sort()).toEqual(
      actorsAt(events, t, 30 * MIN)
        .map((a) => a.id)
        .sort(),
    );
    expect(sceneAt(m, t).actors.length).toBeGreaterThan(0);
  });
});
