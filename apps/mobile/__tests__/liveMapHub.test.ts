import { describe, expect, test } from "@jest/globals";

import { agentPaint } from "../features/console/map/live/agentKind";
import { createMapEngine, type MapData } from "../features/console/map/live/engine";
import { placeAgents } from "../features/console/map/live/engine/draw/hub";
import { buildLayout, HUB_R } from "../features/console/map/live/engine/layout";
import { SPACING } from "../features/console/map/live/engine/pack";
import { hubFrom } from "../features/console/map/live/mapHub";
import type { MapHub } from "../features/console/map/live/types";
import { fakeCanvas, para, palette } from "./liveMapFixture";

/**
 * ALL WORKSPACES AS ONE PICTURE — `engine/layout.ts` `placeIslands`,
 * `engine/draw/hub.ts`, `mapHub.ts` (Dev2, 2026-10-10: "you see your
 * workspace, all the other workspaces you're connected to, the agents
 * connected to each workspace… we can market with that").
 *
 * You in the middle, workspaces in a ring round you, each AI tool you
 * connected between the workspaces it reaches with a dotted line in its own
 * colour, and each workspace saying who is in it rather than how many notes.
 *
 * Sabotage record: the old grid in `placeIslands` fails "a ring with the
 * middle clear"; dropping `drawHubLines` from the render fails "you, roads
 * and the agents' lines"; counting notes with a hub fails "who is in it";
 * keeping a colleague's grant fails "only your own tools".
 */

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);

const graphs = () => [para("ws-a", "Personal", 30), para("ws-b", "Supa", 24), para("ws-c", "Public Worship", 18)];

const HUB: MapHub = {
  you: "@seyi",
  workspaces: { "ws-a": { people: 1, faces: [] }, "ws-b": { people: 13, faces: ["@maya", "@jo", "@ade", "@kim", "@lu"] }, "ws-c": { people: 2, faces: ["@pat"] } },
  agents: [
    { id: "agent:Claude", name: "Claude", workspaceIds: ["ws-a", "ws-b"] },
    { id: "agent:Codex", name: "Codex", workspaceIds: ["ws-b"] },
  ],
};

const data = (over: Partial<MapData> = {}): MapData => ({
  graphs: graphs(),
  actors: [],
  events: [],
  scope: { kind: "all" },
  view: "map",
  clock: { kind: "live" },
  palette,
  selfId: null,
  hub: HUB,
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
  const calls = canvas.ctx.calls;
  return { calls, text: calls.filter((c) => c.op === "fillText").map((c) => String(c.args[0])) };
}

describe("all workspaces round you", () => {
  test("a ring with the middle clear, neighbours apart", () => {
    for (const n of [2, 3, 5, 8]) {
      const gs = Array.from({ length: n }, (_, i) => para(`ws-${i}`, `W${i}`, 10 + i * 7));
      const { islands } = buildLayout(gs);
      for (const i of islands) expect(Math.hypot(i.x, i.y) - i.r).toBeGreaterThanOrEqual(HUB_R);
      for (let a = 0; a < n; a += 1) {
        for (let b = a + 1; b < n; b += 1) {
          const A = islands[a]!;
          const B = islands[b]!;
          expect(Math.hypot(A.x - B.x, A.y - B.y)).toBeGreaterThan(A.r + B.r);
        }
      }
    }
  });

  test("one workspace sits in the middle", () => {
    const { islands } = buildLayout([para("ws-a", "Personal", 10)]);
    expect([islands[0]!.x, islands[0]!.y]).toEqual([0, 0]);
  });

  test("you, roads and the agents' lines", () => {
    const { calls, text } = frame(data());
    expect(text).toContain("You");
    expect(text).toContain("Claude");
    expect(text).toContain("Codex");
    expect(calls.some((c) => c.op === "stroke" && c.strokeStyle === palette.zoneLine)).toBe(true);
    for (const name of ["Claude", "Codex"]) {
      const tint = agentPaint(name, palette.agent).tint;
      expect(calls.some((c) => c.op === "stroke" && c.strokeStyle === tint)).toBe(true);
    }
  });

  test("who is in it, not how many notes", () => {
    const { text } = frame(data());
    expect(text).toContain("Just you");
    expect(text).toContain("13 people");
    expect(text).toContain("2 people");
    expect(text.filter((t) => /\bnotes?$/.test(t))).toEqual([]);
  });

  test("without a hub: note counts, no you", () => {
    const { text } = frame(data({ hub: null }));
    expect(text.some((t) => /\d notes$/.test(t))).toBe(true);
    expect(text).not.toContain("You");
  });

  test("one workspace's map draws no hub", () => {
    const { text } = frame(data({ scope: { kind: "one", workspaceId: "ws-a" } }));
    expect(text).not.toContain("You");
    expect(text).not.toContain("Just you");
  });

  test("agents stand between their workspaces and apart from each other", () => {
    const { islands } = buildLayout(graphs());
    const many = Array.from({ length: 6 }, (_, k) => ({ id: `a${k}`, name: `Tool ${k}`, workspaceIds: ["ws-b"] }));
    const placed = placeAgents(islands, [...HUB.agents, ...many]);
    expect(placed).toHaveLength(8);
    for (const g of placed) {
      const d = Math.hypot(g.at.x, g.at.y);
      expect(d).toBeGreaterThanOrEqual(HUB_R * 0.9 - 1e-6);
    }
    for (let a = 0; a < placed.length; a += 1) {
      for (let b = a + 1; b < placed.length; b += 1) {
        expect(Math.hypot(placed[a]!.at.x - placed[b]!.at.x, placed[a]!.at.y - placed[b]!.at.y)).toBeGreaterThanOrEqual(SPACING * 7 - 1e-6);
      }
    }
    // Claude reaches two workspaces: a line ends at each.
    expect(placed[0]!.to).toHaveLength(2);
  });
});

describe("the hub from the console's data", () => {
  const contexts = [
    { id: "ws-a", slug: "seyi" },
    { id: "ws-b", slug: "supa" },
  ];

  test("only your own tools, one per tool, the app itself left out", () => {
    const hub = hubFrom({
      you: "@seyi",
      contexts,
      clients: [
        { name: "Claude", context: "@seyi", mine: true },
        { name: "@seyi's Claude", context: "@supa", mine: true },
        { name: "Cursor", context: "@supa", mine: false },
        { name: "Context (this app)", context: "@seyi", mine: true },
        { name: "Codex", context: "@gone", mine: true },
      ],
      members: new Map(),
    });
    expect(hub.agents).toEqual([{ id: "agent:Claude", name: "Claude", workspaceIds: ["ws-a", "ws-b"] }]);
  });

  test("people per workspace, faces without you", () => {
    const hub = hubFrom({
      you: "@seyi",
      contexts,
      clients: [],
      members: new Map([
        ["ws-a", [{ userId: "u1", name: "@seyi", isMe: true }]],
        ["ws-b", [{ userId: "u1", name: "@seyi", isMe: true }, { userId: "u2", name: "@maya", isMe: false }, { userId: "u3", isMe: false }]],
      ]),
    });
    expect(hub.workspaces).toEqual({ "ws-a": { people: 1, faces: [] }, "ws-b": { people: 3, faces: ["@maya", "u3"] } });
  });
});
