import { describe, expect, test } from "@jest/globals";

import { agentPaint } from "../features/console/map/live/agentKind";
import { createMapEngine, type MapData } from "../features/console/map/live/engine";
import { landingOn, placeAgents } from "../features/console/map/live/engine/draw/hub";
import { buildLayout, HUB_R } from "../features/console/map/live/engine/layout";
import { SPACING } from "../features/console/map/live/engine/pack";
import { agentsAtWork, AGENT_AT_WORK_MS, hubFrom } from "../features/console/map/live/mapHub";
import type { MapHub } from "../features/console/map/live/types";
import { fakeCanvas, para, palette } from "./liveMapFixture";

/**
 * ALL WORKSPACES AS ONE PICTURE — `engine/layout.ts` `placeIslands`,
 * `engine/draw/hub.ts`, `mapHub.ts` (Dev2, 2026-10-10: "you see your
 * workspace, all the other workspaces you're connected to, the agents
 * connected to each workspace… we can market with that").
 *
 * Workspaces in a ring round an empty middle, each of your AI tools at work
 * between the workspaces it is working in with a dotted line in its own
 * colour, and each workspace saying who is in it rather than how many notes.
 * No face marked "You" and no roads out to the workspaces (Dev2, 2026-10-12).
 *
 * Sabotage record: the old grid in `placeIslands` fails "a ring with the
 * middle clear"; dropping `drawHubLines` from the render fails "the agents'
 * lines, and no You or roads"; drawing You or the roads again fails it too; counting notes with a hub fails "who is in it";
 * keeping a colleague's grant fails "only your own tools"; ending lines at
 * the island's circle again fails "every line lands on a folder"; drawing
 * names without checking each other fails "names never run into each other";
 * keeping the desktop app fails "the desktop app is not an agent"; drawing
 * every connected tool again fails "an idle tool is not drawn".
 */

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);

const graphs = () => [para("ws-a", "Personal", 30), para("ws-b", "Supa", 24), para("ws-c", "Public Worship", 18)];

const HUB: MapHub = {
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

  // Dev2, 2026-10-12: "whats the You icon needed for though?" It is not.
  test("the agents' lines, and no You or roads", () => {
    const { calls, text } = frame(data());
    expect(text).not.toContain("You");
    expect(text).toContain("Claude");
    expect(text).toContain("Codex");
    expect(calls.some((c) => c.op === "stroke" && c.strokeStyle === palette.zoneLine)).toBe(false);
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

  // Dev2, 2026-10-12: dotted lines ended at coloured dots in empty space,
  // because folders pack to one side of an island and the line stopped at
  // the island's circle.
  test("every line lands on a folder, not open ground", () => {
    const { islands } = buildLayout(graphs());
    const placed = placeAgents(islands, HUB.agents);
    const inFolder = (q: { x: number; y: number }) => islands.some((i) => i.folders.some((f) => Math.hypot(q.x - f.x, q.y - f.y) <= f.r));
    for (const g of placed) for (const t of g.to) expect(inFolder(t)).toBe(true);
    for (const island of islands) expect(inFolder(landingOn(island, { x: 0, y: 0 }))).toBe(true);
  });

  test("names never run into each other, and a long one is shortened", () => {
    const long = "Context on Somebodys-Very-Long-MacBook-Pro";
    const agents = [
      ...HUB.agents,
      ...Array.from({ length: 6 }, (_, k) => ({ id: `a${k}`, name: k === 0 ? long : `Assistant number ${k}`, workspaceIds: ["ws-a"] })),
    ];
    const { calls } = frame(data({ hub: { ...HUB, agents } }), 1200, 800);
    const isName = (t: string) => agents.some((a) => a.name === t || (t.endsWith("…") && a.name.startsWith(t.slice(0, -1))));
    const names = calls.filter((c) => c.op === "fillText" && String(c.font).startsWith("600 12px") && isName(String(c.args[0])));
    const rects = names.map((c) => {
      const text = String(c.args[0]);
      const w = text.length * 12 * 0.55;
      return { text, x: Number(c.args[1]) - w / 2, y: Number(c.args[2]) - 12, w, h: 15 };
    });
    expect(rects).toHaveLength(agents.length);
    expect(rects.some((r) => r.text.endsWith("…"))).toBe(true);
    expect(rects.map((r) => r.text)).not.toContain(long);
    for (const r of rects) expect(r.w).toBeLessThanOrEqual(120);
    for (let a = 0; a < rects.length; a += 1) {
      for (let b = a + 1; b < rects.length; b += 1) {
        const A = rects[a]!;
        const B = rects[b]!;
        const hit = A.x < B.x + B.w && A.x + A.w > B.x && A.y < B.y + B.h && A.y + A.h > B.y;
        expect(hit ? `${A.text} × ${B.text}` : "").toBe("");
      }
    }
  });
});

describe("the hub from the console's data", () => {
  const contexts = [
    { id: "ws-a", slug: "seyi" },
    { id: "ws-b", slug: "supa" },
  ];
  // Every tool at work in both workspaces: these tests are about which are tools at all.
  const allBusy = (...names: string[]) => names.flatMap((name) => [{ name, workspaceId: "ws-a" }, { name, workspaceId: "ws-b" }]);

  test("only your own tools, one per tool, the app itself left out", () => {
    const hub = hubFrom({
      contexts,
      clients: [
        { name: "Claude", context: "@seyi", mine: true },
        { name: "@seyi's Claude", context: "@supa", mine: true },
        { name: "Cursor", context: "@supa", mine: false },
        { name: "Context (this app)", context: "@seyi", mine: true },
        { name: "Codex", context: "@gone", mine: true },
      ],
      working: allBusy("Claude", "Cursor", "Codex", "Context (this app)"),
      members: new Map(),
    });
    expect(hub.agents).toEqual([{ id: "agent:Claude", name: "Claude", workspaceIds: ["ws-a", "ws-b"] }]);
  });

  // Dev2, 2026-10-12: "Context on Seyis-MacBook-Pro" stood among the AIs. It
  // is the desktop app recording meetings: the person's own hand, like the console.
  test("the desktop app is not an agent", () => {
    const hub = hubFrom({
      contexts,
      clients: [
        { name: "Context on Seyis-MacBook-Pro", context: "@seyi", mine: true, machine: true },
        { name: "Context on Old-Laptop", context: "@seyi", mine: true, machine: true },
        { name: "Laptop recorder", context: "@seyi", mine: true, machine: true },
        { name: "ChatGPT", context: "@seyi", mine: true, machine: false },
      ],
      working: allBusy("Context on Seyis-MacBook-Pro", "Context on Old-Laptop", "Laptop recorder", "ChatGPT"),
      members: new Map(),
    });
    expect(hub.agents.map((a) => a.name)).toEqual(["ChatGPT"]);
  });

  // A client name is display text the client chose at registration, so it
  // cannot decide whether the map draws the thing at all: the server says
  // which grant is the desktop shell, under a bound a stranger cannot claim.
  // An install from before that flag still reads as the shell, because the
  // server recognises the name it registers under — here nothing does.
  test("a tool named like the desktop app is still drawn as a tool", () => {
    const hub = hubFrom({
      contexts,
      clients: [
        { name: "Context on nothing", context: "@seyi", mine: true, machine: false },
        { name: "Context on nothing at all", context: "@seyi", mine: true },
      ],
      working: allBusy("Context on nothing", "Context on nothing at all"),
      members: new Map(),
    });
    expect(hub.agents.map((a) => a.name)).toEqual(["Context on nothing", "Context on nothing at all"]);
  });

  test("people per workspace, faces without you", () => {
    const hub = hubFrom({
      contexts,
      clients: [],
      working: [],
      members: new Map([
        ["ws-a", [{ userId: "u1", name: "@seyi", isMe: true }]],
        ["ws-b", [{ userId: "u1", name: "@seyi", isMe: true }, { userId: "u2", name: "@maya", isMe: false }, { userId: "u3", isMe: false }]],
      ]),
    });
    expect(hub.workspaces).toEqual({ "ws-a": { people: 1, faces: [] }, "ws-b": { people: 3, faces: ["@maya", "u3"] } });
  });

  // Dev2, 2026-10-12: "they should only ever be shown when they are actively
  // working in a workspace". Connected is not enough; at work is.
  test("an idle tool is not drawn, and a busy one only to where it works", () => {
    const hub = hubFrom({
      contexts,
      clients: [
        { name: "Claude", context: "@seyi", mine: true },
        { name: "@seyi's Claude", context: "@supa", mine: true },
        { name: "Codex", context: "@supa", mine: true },
        { name: "ChatGPT", context: "@seyi", mine: true },
      ],
      members: new Map(),
      working: [{ name: "@seyi's Claude", workspaceId: "ws-b" }],
    });
    expect(hub.agents).toEqual([{ id: "agent:Claude", name: "Claude", workspaceIds: ["ws-b"] }]);
  });

  test("nobody at work: an empty middle", () => {
    const hub = hubFrom({ contexts, clients: [{ name: "Claude", context: "@seyi", mine: true }], members: new Map(), working: [] });
    expect(hub.agents).toEqual([]);
    const { text } = frame(data({ hub }));
    expect(text).not.toContain("You");
    expect(text).not.toContain("Claude");
  });

  test("at work means yours, within the last five minutes, live", () => {
    const now = NOW;
    const actors = [
      { kind: "agent" as const, name: "Claude", workspaceId: "ws-a", self: true, at: now - 60_000 },
      { kind: "agent" as const, name: "Codex", workspaceId: "ws-a", self: true, at: now - AGENT_AT_WORK_MS - 1 },
      { kind: "agent" as const, name: "@maya's Cursor", workspaceId: "ws-b", at: now },
      { kind: "person" as const, name: "@seyi", workspaceId: "ws-a", self: true, at: now },
    ];
    expect(agentsAtWork(actors, { now })).toEqual([{ name: "Claude", workspaceId: "ws-a" }]);
    // A replay's actors are already the ones at the playhead, and say nothing of whose.
    expect(agentsAtWork(actors, null).map((a) => a.name)).toEqual(["Claude", "Codex", "@maya's Cursor"]);
  });
});
