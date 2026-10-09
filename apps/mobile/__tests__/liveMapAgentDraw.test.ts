/**
 * THE CANVAS DRAWS EACH AI IN ITS OWN COLOUR.
 *
 * The engine draws a robot tile for every agent, tinted by which AI it is
 * (`agentKind.ts`), and the texting assistant as a round teal badge. Driven on
 * the fake canvas through the public engine, so what is asserted is what is
 * painted. People are not touched: they keep their faces.
 *
 * ## Sabotage record
 *
 *   engine paints every robot in palette.ink (the old tile)      "each AI is drawn in its own colour" fails
 *   engine ignores the texting assistant's badge (robot tile)    "the texting assistant is teal" fails
 *   robot glyph drawn in the tint (no contrast)                  "the glyph is drawn in the glyph colour" fails
 */
import { describe, expect, test } from "@jest/globals";
import { createMapEngine, type MapData } from "../features/console/map/live/engine";
import type { MapActor } from "../features/console/map/live/engine/timeline";
import { agentTint } from "../features/console/map/live/agentKind";
import { WHO, ev, fakeCanvas, para, palette } from "./liveMapFixture";

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
const ws = para("ws-a", "Personal", 12);
const plan = ws.nodes.find((n) => n.path.startsWith("1-projects/launch/"))!.path;
const inbox = ws.nodes.filter((n) => n.path.startsWith("0-inbox/")).map((n) => n.path);

const agent = (id: string, name: string, path: string): MapActor => ({
  id,
  kind: "agent",
  name,
  path,
  doing: "read",
  at: NOW,
  reads: [],
  workspaceId: "ws-a",
});
const claude = agent("a:claude", "Seyi's Claude", plan);
const texting = agent("a:texts", "@seyi's Texts (iMessage)", inbox[1]!);
const cursor = agent("a:cursor", "@maya's Cursor", inbox[4]!);
const codex = agent("a:codex", "@jon's Codex", inbox[6]!);
const maya: MapActor = { ...WHO.maya, path: inbox[3]!, doing: "read", at: NOW, workspaceId: "ws-a" };

function drawn(actors: MapActor[]) {
  const canvas = fakeCanvas(1000, 700);
  const engine = createMapEngine(canvas, {
    now: () => NOW,
    requestFrame: () => 1,
    cancelFrame: () => {},
    reducedMotion: true,
    onFollow: () => {},
  });
  engine.resize(1000, 700, 1);
  const data: MapData = {
    graphs: [ws],
    actors,
    events: [ev.read(NOW - 5_000, "ws-a", plan)],
    scope: { kind: "one", workspaceId: "ws-a" },
    view: "map",
    clock: { kind: "live" },
    palette,
    selfId: null,
  };
  engine.setData(data);
  canvas.ctx.calls.length = 0;
  engine.renderAt(NOW);
  const fills = canvas.ctx.calls.filter((c) => c.op === "fill").map((c) => c.fillStyle);
  engine.destroy();
  return fills;
}

describe("the canvas paints each AI in its own colour", () => {
  test("Claude is orange, Codex purple, and the robot glyph is drawn in the glyph colour", () => {
    const fills = drawn([claude, codex]);
    expect(fills).toContain(palette.agent.agentClaude);
    expect(fills).toContain(palette.agent.agentCodex);
    expect(fills).toContain(palette.agent.agentGlyph);
  });

  test("an unknown tool is drawn in one of the spare colours, the same every time", () => {
    const fills = drawn([cursor]);
    expect(fills).toContain(agentTint("other", cursor.name, palette.agent));
  });

  test("the texting assistant is the teal badge, not a robot tile", () => {
    const fills = drawn([texting]);
    expect(fills).toContain(palette.agent.agentContext);
    expect(fills).not.toContain(palette.agent.agentClaude);
  });

  test("a person is still drawn with the faces' ground, not an AI's tint", () => {
    const fills = drawn([maya]);
    expect(fills).toContain(palette.faceGround);
    for (const tint of [palette.agent.agentClaude, palette.agent.agentCodex, palette.agent.agentContext]) {
      expect(fills).not.toContain(tint);
    }
  });
});
