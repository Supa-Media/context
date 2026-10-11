import { describe, expect, test } from "@jest/globals";

import { createMapEngine, type FollowState, type MapData } from "../features/console/map/live/engine";
import { HitFrame, LAYER, hitTest, type HitShape } from "../features/console/map/live/engine/hit";
import type { MapActor } from "../features/console/map/live/engine/timeline";
import { WHO, ev, fakeCanvas, para, palette } from "./liveMapFixture";

/**
 * DRAWING AND CLICKING — `engine/engine.ts`, `engine/draw/*`, `engine/hit.ts`,
 * `engine/folders.ts`, driven through the public engine on a fake canvas.
 *
 * What you can click is what was drawn: every frame records its shapes, and a
 * click takes the topmost. Following an AI reports what it read, in order.
 * Reading is drawn in ink; teal only appears once somebody writes.
 *
 * Sabotage record: `hitTest` ignoring layers (last drawn wins) → "a face is
 * on top of the note it sits on" fails; drawing reading particles in `accent`
 * → "reading is drawn in ink" fails; `fillText` in `draw/primitives.ts`
 * passing the text through uncontained → "a title with a direction override
 * is drawn contained" fails.
 */

const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
const ws = para("ws-a", "Personal", 12);
const plan = ws.nodes.find((n) => n.path.startsWith("1-projects/launch/"))!.path;
const inbox = ws.nodes.filter((n) => n.path.startsWith("0-inbox/")).map((n) => n.path);

const claude: MapActor = {
  ...WHO.claude,
  path: plan,
  doing: "read",
  at: NOW,
  reads: [inbox[2]!, inbox[0]!, plan],
  workspaceId: "ws-a",
};
const maya: MapActor = { ...WHO.maya, path: inbox[3]!, doing: "edit", at: NOW, workspaceId: "ws-a" };

const base = (actors: MapActor[], over: Partial<MapData> = {}): MapData => ({
  graphs: [ws],
  actors,
  events: [ev.read(NOW - 5_000, "ws-a", plan)],
  scope: { kind: "one", workspaceId: "ws-a" },
  view: "map",
  clock: { kind: "live" },
  palette,
  selfId: null,
  ...over,
});

function engineWith(data: MapData, w = 1000, h = 700, reducedMotion = true) {
  const canvas = fakeCanvas(w, h);
  const follows: Array<FollowState | null> = [];
  const engine = createMapEngine(canvas, {
    now: () => NOW,
    requestFrame: () => 1,
    cancelFrame: () => {},
    reducedMotion,
    onFollow: (s) => follows.push(s),
  });
  engine.resize(w, h, 1);
  engine.setData(data);
  return { canvas, engine, follows };
}

const centre = (s: HitShape) => ("rect" in s ? { x: s.rect.x + s.rect.w / 2, y: s.rect.y + s.rect.h / 2 } : { x: s.x, y: s.y });

describe("hit testing", () => {
  test("a face is on top of the note it sits on, and a dot on top of its folder", () => {
    const frame = new HitFrame();
    frame.circle(100, 100, 200, { kind: "folder", workspaceId: "w", path: "1-projects/" }, LAYER.folder);
    frame.circle(100, 100, 4, { kind: "note", workspaceId: "w", path: "1-projects/a.md" }, LAYER.note);
    frame.circle(104, 98, 13, { kind: "actor", id: "a:claude" }, LAYER.actor);
    frame.circle(100, 100, 300, { kind: "workspace", workspaceId: "w" }, LAYER.workspace);
    expect(hitTest(frame, 104, 98)).toEqual({ kind: "actor", id: "a:claude" });
    expect(hitTest(frame, 150, 150)).toEqual({ kind: "folder", workspaceId: "w", path: "1-projects/" });
    expect(hitTest(frame, 350, 100)).toEqual({ kind: "workspace", workspaceId: "w" });
    expect(hitTest(frame, 500, 500)).toBeNull();
  });

  test("small dots take a finger's slack; bubbles do not", () => {
    const frame = new HitFrame();
    frame.circle(50, 50, 3, { kind: "note", workspaceId: "w", path: "a.md" }, LAYER.note);
    frame.circle(200, 50, 40, { kind: "folder", workspaceId: "w", path: "b/" }, LAYER.folder);
    expect(hitTest(frame, 55, 50)).not.toBeNull();
    expect(hitTest(frame, 243, 50)).toBeNull();
  });

  test("everything the engine drew can be clicked back to what it is", () => {
    const { engine } = engineWith(base([claude, maya]));
    const frame = engine.renderAt(NOW);
    const kinds = new Set(frame.shapes.map((s) => s.target.kind));
    for (const k of ["folder", "note", "actor"]) expect(kinds.has(k as never)).toBe(true);
    const face = frame.shapes.find((s) => s.target.kind === "actor" && s.target.id === claude.id)!;
    const c = centre(face);
    expect(engine.hitTest(c.x, c.y)).toEqual({ kind: "actor", id: claude.id });
    // A note dot not under a face resolves to that note.
    const faces = frame.shapes.filter((s) => s.layer >= LAYER.label);
    const dot = frame.shapes.find(
      (s) => s.target.kind === "note" && !faces.some((f) => Math.hypot(centre(f).x - centre(s).x, centre(f).y - centre(s).y) < 30),
    )!;
    const d = centre(dot);
    expect(engine.hitTest(d.x, d.y)).toEqual(dot.target);
    engine.destroy();
  });
});

describe("following", () => {
  test("following an AI reports what it read, in the order it read it", () => {
    const { engine, follows } = engineWith(base([claude, maya]));
    engine.follow(claude.id);
    engine.renderAt(NOW);
    const state = engine.getFollow()!;
    expect(state).toMatchObject({ actorId: claude.id, name: "Seyi's Claude", kind: "agent", doing: "read" });
    expect(state.reads.map((r) => r.path)).toEqual([inbox[2], inbox[0], plan]);
    expect(state.at?.path).toBe(plan);
    expect(follows.at(-1)?.reads.map((r) => r.path)).toEqual([inbox[2], inbox[0], plan]);
    engine.follow(null);
    expect(engine.getFollow()).toBeNull();
    expect(follows.at(-1)).toBeNull();
    engine.destroy();
  });
});

describe("colour", () => {
  const teal = (calls: ReturnType<typeof fakeCanvas>["ctx"]["calls"]) =>
    calls.filter((c) => (c.op === "fill" && c.fillStyle === palette.accent) || (c.op === "stroke" && c.strokeStyle === palette.accent));

  test("reading is drawn in ink; teal only appears once somebody writes", () => {
    // Reduced motion: nothing streams at all.
    const still = engineWith(base([claude]));
    still.canvas.ctx.calls.length = 0;
    still.engine.renderAt(NOW);
    expect(still.canvas.ctx.calls.filter((c) => c.op === "fill" && c.fillStyle === palette.ink && (c.alpha ?? 1) < 0.85)).toEqual([]);

    const reading = engineWith(base([claude]), 1000, 700, false);
    reading.canvas.ctx.calls.length = 0;
    reading.engine.renderAt(NOW);
    // The dots streaming from the note into its reader: small ink circles, faded in and out.
    const streaming = reading.canvas.ctx.calls.filter((c) => c.op === "fill" && c.fillStyle === palette.ink && (c.alpha ?? 1) < 0.85);
    expect(streaming.length).toBeGreaterThan(3);
    expect(teal(reading.canvas.ctx.calls)).toEqual([]);

    const writing = engineWith(base([claude, maya]), 1000, 700, false);
    writing.canvas.ctx.calls.length = 0;
    writing.engine.renderAt(NOW);
    expect(teal(writing.canvas.ctx.calls).length).toBeGreaterThan(0);
  });
});

describe("names from somebody else's bucket", () => {
  test("a title with a direction override is drawn contained, and the map's own words are not", () => {
    const g = para("ws-a", "Personal", 3);
    const evil = { path: "0-inbox/evil.md", title: "Invoice \u202etxt.exe" };
    const graphs = [{ ...g, nodes: [...g.nodes, evil] }];
    const { canvas, engine } = engineWith(base([claude], { view: "folders", graphs }), 1200, 700);
    canvas.ctx.calls.length = 0;
    engine.renderAt(NOW);
    const text = canvas.ctx.calls.filter((c) => c.op === "fillText").map((c) => String(c.args[0]));
    const drawn = text.filter((t) => t.includes("\u202e"));
    expect(drawn.length).toBeGreaterThan(0);
    for (const t of drawn) {
      expect(t.startsWith("\u2068")).toBe(true);
      expect(t.endsWith("\u2069")).toBe(true);
    }
    expect(text).toContain("INBOX");
    engine.destroy();
  });

  test("nothing in the engine writes to the canvas except through that one exit", () => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    /* eslint-enable @typescript-eslint/no-require-imports */
    let out = "";
    try {
      out = execFileSync("grep", ["-rln", "--include=*.ts", "-E", "\\.(fill|stroke)Text\\(", "features/console/map/live/engine"], {
        cwd: `${__dirname}/..`,
        encoding: "utf8",
      });
    } catch (error) {
      if ((error as { status?: number }).status !== 1) throw error;
    }
    expect(out.trim().split("\n").filter(Boolean)).toEqual(["features/console/map/live/engine/draw/primitives.ts"]);
  });
});

describe("the folders view", () => {
  test("lanes in PARA order, each with its count, and the rest summed up", () => {
    const { canvas, engine } = engineWith(base([claude, maya], { view: "folders", graphs: [para("ws-a", "Personal", 40)] }), 1200, 700);
    canvas.ctx.calls.length = 0;
    const frame = engine.renderAt(NOW);
    const text = canvas.ctx.calls.filter((c) => c.op === "fillText").map((c) => String(c.args[0]));
    const order = ["INBOX", "PROJECTS", "AREAS", "RESOURCES", "ARCHIVE"].map((l) => text.indexOf(l));
    for (const i of order) expect(i).toBeGreaterThanOrEqual(0);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain("40");
    expect(text.some((t) => /^\+ ?\d+ more$/.test(t))).toBe(true);
    expect(frame.shapes.some((s) => s.target.kind === "note")).toBe(true);
    engine.destroy();
  });
});
