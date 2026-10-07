import { describe, expect, test } from "@jest/globals";

import { createMapEngine, type MapData } from "../features/console/map/live/engine";
import { NO_INSET, toScreen } from "../features/console/map/live/engine/camera";
import { placeContainerLabels } from "../features/console/map/live/engine/draw/containers";
import { countPresent, type DrawEnv } from "../features/console/map/live/engine/draw/env";
import { DEFAULT_FONT } from "../features/console/map/live/engine/draw/primitives";
import { quietAt } from "../features/console/map/live/engine/draw/containers";
import { HitFrame } from "../features/console/map/live/engine/hit";
import { Occupancy } from "../features/console/map/live/engine/labels";
import { buildLayout } from "../features/console/map/live/engine/layout";
import type { Model, SceneAt } from "../features/console/map/live/engine/scene";
import { flagSpot } from "../features/console/map/live/engine/folders";
import { overlaps, type Rect } from "../features/console/map/live/engine/labels";
import { fakeContext } from "./liveMapFixture";
import type { MapEvent } from "../features/console/map/live/types";
import { WHO, ev, fakeCanvas, graph, para, palette, type Call } from "./liveMapFixture";

/**
 * WHAT GOES ON TOP OF WHAT — `engine/draw/containers.ts`, `engine/draw/flights.ts`,
 * `engine/draw/overlay.ts`, `engine/folders.ts`.
 *
 * Words on the map are the map's own voice, so nothing moving may sit on
 * them: a workspace's title and a folder's name are placed before anything
 * else and drawn over the stream of reading dots; a note on its way to
 * another workspace puts its caption where no folder's name is; note names
 * go round the dots; and in the Folders view the mover's flag keeps off the
 * names on the cards.
 *
 * Text rects are recovered from the fake context's `fillText` calls, at its
 * 0.55em-per-character measure.
 *
 * Sabotage record:
 *   container labels drawn before the reading dots → "a workspace's name is
 *     drawn over the reading dots" fails;
 *   `placeContainerLabels` not checking `hits` → "folder names never overlap"
 *     fails;
 *   `placeFlights` claiming its first spot without checking → "a moving
 *     note's caption keeps off folder names" fails;
 *   note names placed without the dots claimed → "note names go round the
 *     dots" fails;
 *   `flagSpot` ignoring `avoid` → "the mover's flag keeps off card names" fails.
 */

const T = Date.UTC(2026, 9, 1, 12, 0, 0);

type TextRect = Rect & { text: string; weight: string };

/** Every string drawn, as the rect it covers (fillText only; halos are strokes). */
function texts(calls: Call[]): TextRect[] {
  const out: TextRect[] = [];
  for (const c of calls) {
    if (c.op !== "fillText") continue;
    const text = String(c.args[0]);
    const [x, y] = [Number(c.args[1]), Number(c.args[2])];
    const m = /^(\d+) (\d+(?:\.\d+)?)px/.exec(c.font ?? "");
    const size = Number(m?.[2] ?? 10);
    const w = text.length * size * 0.55;
    out.push({ text, weight: m?.[1] ?? "400", x: x - w / 2, y: y - size * 0.8, w, h: size });
  }
  return out;
}

const FOLDER = /^[A-Z][A-Z ]* {2}\d+$/;

function engineFor(data: MapData, w = 1200, h = 800) {
  const canvas = fakeCanvas(w, h);
  const engine = createMapEngine(canvas, { now: () => T, requestFrame: () => 1, cancelFrame: () => {}, reducedMotion: false });
  engine.resize(w, h, 1);
  engine.setData(data);
  canvas.ctx.calls.length = 0;
  return { canvas, engine };
}

describe("names of workspaces and folders", () => {
  // Small folders with long names: their names cannot all sit above their bubbles.
  const crowded = (ws: string, name: string, extra: string[] = []) => {
    const paths: string[] = [...extra];
    ["0-inbox", "1-projects", "2-areas", "3-resources", "4-archive"].forEach((root, r) => {
      for (let i = 0; i < 4 + r * 3; i += 1) paths.push(`${root}/note ${i}.md`);
    });
    for (const f of ["client accounts and billing", "meeting notes from the road", "reading list for the quarter", "recipes we keep coming back to", "travel plans and bookings", "garden and the allotment", "letters to send this month"]) {
      for (let i = 0; i < 3; i += 1) paths.push(`${f}/n ${i}.md`);
    }
    return graph(ws, name, paths);
  };
  const a = crowded("ws-a", "Personal");
  const b = crowded("ws-b", "Supa", ["1-projects/plan.md"]);
  const events: MapEvent[] = [
    ev.read(T - 4000, "ws-a", "1-projects/note 1.md"),
    ev.read(T - 1500, "ws-b", "2-areas/note 3.md"),
    ev.move(T - 1200, "ws-a", "0-inbox/plan.md", "1-projects/plan.md", WHO.jon, "ws-b"),
  ];
  const data: MapData = {
    graphs: [a, b],
    actors: [],
    events,
    scope: { kind: "all" },
    view: "map",
    clock: { kind: "replay", from: T - 60_000, to: T + 60_000, at: T, speed: 1 },
    palette,
    selfId: null,
  };

  test("a workspace's name is drawn over the reading dots", () => {
    const { canvas, engine } = engineFor(data);
    engine.renderAt(T);
    const calls = canvas.ctx.calls;
    const dots = calls.map((c, i) => (c.op === "fill" && c.fillStyle === palette.ink && (c.alpha ?? 1) < 0.85 ? i : -1)).filter((i) => i >= 0);
    expect(dots.length).toBeGreaterThan(0);
    // The title itself (15px), not the overview's small copy of it.
    const title = calls.findIndex((c) => c.op === "fillText" && c.args[0] === "Supa" && (c.font ?? "").includes(" 15px "));
    expect(title).toBeGreaterThanOrEqual(0);
    expect(title).toBeGreaterThan(dots[dots.length - 1]!);
  });

  test("folder names never overlap each other or a workspace's name", () => {
    // Far enough out that long names are much wider than their folders.
    const layout = buildLayout([a, b]);
    const present = new Set(layout.notes.keys());
    const model = { layout, scope: { kind: "all" }, graphs: [a, b] } as unknown as Model;
    const scene = { present } as unknown as SceneAt;
    const ctx = fakeContext();
    const vp = { w: 1200, h: 800, inset: NO_INSET };
    const centre = layout.islands[0]!;
    let placed = 0;
    for (const s of [0.9, 1.3, 1.8]) {
      const cam = { x: centre.x, y: centre.y, s };
      const env = {
        ctx,
        style: { palette, font: DEFAULT_FONT, faceFor: null },
        model,
        scene,
        cam,
        vp,
        s,
        screen: (p: { x: number; y: number }) => toScreen(cam, vp, p),
        onScreen: () => true,
        hit: new HitFrame(),
        occ: new Occupancy(),
        bounds: { minX: 0, minY: 0, maxX: 1200, maxY: 800 },
        narrow: false,
        dim: false,
        selected: null,
        counts: countPresent(model, scene),
        hot: new Set(),
        pills: [],
        quiet: [],
        flyingAt: new Map(),
      } as unknown as DrawEnv;
      const labels = placeContainerLabels(env);
      placed += labels.length;
      for (let i = 0; i < labels.length; i += 1) {
        for (let j = i + 1; j < labels.length; j += 1) {
          expect([labels[i]!.lines[0]!.text, labels[j]!.lines[0]!.text, overlaps(labels[i]!.rect, labels[j]!.rect)]).toEqual([
            labels[i]!.lines[0]!.text,
            labels[j]!.lines[0]!.text,
            false,
          ]);
        }
      }
    }
    expect(placed).toBeGreaterThan(10);
  });

  test("a moving note's caption keeps off folder names", () => {
    const { canvas, engine } = engineFor(data);
    let seen = 0;
    for (const t of [T - 800, T, T + 800, T + 1500]) {
      canvas.ctx.calls.length = 0;
      engine.renderAt(t);
      const drawn = texts(canvas.ctx.calls);
      const caption = drawn.find((d) => d.text.startsWith("Jon is moving it to"));
      if (!caption) continue;
      seen += 1;
      for (const name of drawn.filter((d) => FOLDER.test(d.text))) expect([name.text, overlaps(caption, name)]).toEqual([name.text, false]);
    }
    expect(seen).toBeGreaterThan(1);
  });

  test("moving dots fade out under words", () => {
    const words = [{ x: 100, y: 100, w: 80, h: 16 }];
    expect(quietAt(words, 120, 108)).toBe(0);
    expect(quietAt(words, 400, 400)).toBe(1);
    const near = quietAt(words, 185, 108);
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThan(1);
  });
});

describe("note names", () => {
  test("note names go round the dots", () => {
    const g = para("ws-a", "Personal", 16);
    const { canvas, engine } = engineFor({
      graphs: [g],
      actors: [],
      events: [],
      scope: { kind: "one", workspaceId: "ws-a" },
      view: "map",
      clock: { kind: "live" },
      palette,
      selfId: null,
    });
    canvas.ctx.calls.length = 0;
    engine.renderAt(T);
    const calls = canvas.ctx.calls;
    const dots: Array<{ x: number; y: number; r: number }> = [];
    for (let i = 0; i < calls.length; i += 1) {
      const c = calls[i]!;
      if (c.op !== "arc") continue;
      const next = calls.slice(i + 1, i + 3).find((d) => d.op === "fill" || d.op === "stroke");
      if (next?.op === "fill" && next.fillStyle === palette.dot) dots.push({ x: Number(c.args[0]), y: Number(c.args[1]), r: Number(c.args[2]) });
    }
    const names = texts(calls).filter((t) => t.text.startsWith("note "));
    expect(dots.length).toBeGreaterThan(20);
    expect(names.length).toBeGreaterThan(3);
    for (const n of names) {
      for (const d of dots) expect([n.text, overlaps(n, { x: d.x - d.r, y: d.y - d.r, w: d.r * 2, h: d.r * 2 })]).toEqual([n.text, false]);
    }
  });
});

describe("the Folders view's mover", () => {
  const bounds = { minX: 0, maxX: 1200, minY: 0, maxY: 800 };
  const card = { x: 500, y: 300, w: 200, h: 32 };
  const size = { w: 120, h: 24 };

  test("the mover's flag keeps off card names", () => {
    const leftName = { x: 360, y: 290, w: 130, h: 20 };
    const spot = flagSpot(card, size, [leftName], bounds);
    expect(overlaps({ ...spot, ...size }, leftName)).toBe(false);
    // Left is taken, so it goes to the right of the card.
    expect(spot.x).toBeGreaterThanOrEqual(card.x + card.w);
    // Free on the left: it goes there.
    expect(flagSpot(card, size, [], bounds).x + size.w).toBeLessThanOrEqual(card.x);
  });

  test("with nowhere free it rides above the card, on screen", () => {
    const everywhere = [{ x: 0, y: 0, w: 1200, h: 800 }];
    const spot = flagSpot({ x: 1150, y: 300, w: 200, h: 32 }, size, everywhere, bounds);
    expect(spot.y + size.h).toBeLessThanOrEqual(300);
    expect(spot.x + size.w).toBeLessThanOrEqual(1200);
  });
});
