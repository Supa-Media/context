import { describe, expect, test } from "@jest/globals";
import {
  CONSOLE_CLIENT_ID,
  LIVE_TAIL,
  connectionRows,
  liveEvents,
  toolsLive,
} from "../features/onboarding/tools";

const grant = (over: Partial<{ clientId: string; clientName: string; status: string; lastUsedAt: number }>) => ({
  clientId: "client-x",
  clientName: "Claude",
  status: "active",
  ...over,
});

describe("the Connections rows", () => {
  test("nothing connected reads as nothing connected", () => {
    expect(connectionRows([]).every((row) => row.status === "not-connected")).toBe(true);
    expect(connectionRows(undefined).map((row) => row.key)).toEqual([
      "claude-desktop",
      "chatgpt",
      "cursor",
      "codex",
      "notion-ai",
    ]);
  });

  test("a grant that has been used is connected; one that has not is still waiting", () => {
    const rows = connectionRows([
      grant({ clientName: "Claude", lastUsedAt: 1_000 }),
      grant({ clientId: "c2", clientName: "ChatGPT" }),
    ]);
    expect(rows.find((row) => row.key === "claude-desktop")?.status).toBe("connected");
    expect(rows.find((row) => row.key === "chatgpt")?.status).toBe("connecting");
    expect(rows.find((row) => row.key === "cursor")?.status).toBe("not-connected");
  });

  test("a revoked grant connects nothing, and the console's own grant is never a tool", () => {
    const rows = connectionRows([
      grant({ clientName: "Claude", status: "revoked", lastUsedAt: 1_000 }),
      grant({ clientId: CONSOLE_CLIENT_ID, clientName: "Claude", lastUsedAt: 1_000 }),
    ]);
    expect(rows.find((row) => row.key === "claude-desktop")?.status).toBe("not-connected");
  });

  test("only the two clients with a walkthrough offer one", () => {
    expect(connectionRows([]).filter((row) => row.hasGuide).map((row) => row.key)).toEqual([
      "claude-desktop",
      "chatgpt",
    ]);
  });
});

describe("the live moment", () => {
  test("goes live on any tool's first use, named by us or not", () => {
    expect(toolsLive([])).toBe(false);
    expect(toolsLive([grant({ clientName: "Some MCP client" })])).toBe(false);
    expect(toolsLive([grant({ clientName: "Some MCP client", lastUsedAt: 5 })])).toBe(true);
  });

  test("the console using its own grant is not a tool going live", () => {
    expect(toolsLive([grant({ clientId: CONSOLE_CLIENT_ID, lastUsedAt: 5 })])).toBe(false);
  });

  test("the tail is the newest events first, named by agent, and short", () => {
    const marks = Array.from({ length: LIVE_TAIL + 3 }, (_, index) => ({
      path: `1-projects/n-${index}.md`,
      kind: index % 2 === 0 ? ("write" as const) : ("read" as const),
      at: Date.UTC(2026, 8, 24, 9, 0, index),
      agent: "a:1",
    }));
    const events = liveEvents({
      agents: [{ id: "a:1", name: "Claude", color: null, lastAt: 0 } as never],
      marks,
    });
    expect(events).toHaveLength(LIVE_TAIL);
    expect(events[0]).toMatchObject({ client: "Claude", action: "wrote", target: "1-projects/n-10.md" });
    expect(events[1]?.action).toBe("read");
    expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
  });

  test("nothing to show is an empty tail, never a made-up one", () => {
    expect(liveEvents(undefined)).toEqual([]);
    expect(liveEvents({ agents: [], marks: [] })).toEqual([]);
  });
});
