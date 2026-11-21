import { describe, expect, it } from "vitest";
import { MemoryStorage } from "./memoryStorage.testing";
import { APP_RUN_KEY, appRunKeeper, liveStepFrom, MAX_RUN_STEPS, type AppRun } from "./appRun";
import { askAgent, type Fetch } from "./clients";

describe("the app's run card (appRun.ts)", () => {
  it("keeps each step as it comes, merges streamed thinking, keeps the newest, and clears when the turn ends", async () => {
    const storage = new MemoryStorage();
    const run = appRunKeeper(storage, "turn-1", ["e1"], 1_000);
    run.onLive({ k: "think", at: 10, text: "Looking for" });
    run.onLive({ k: "think", at: 20, text: "Looking for the Daniel notes" });
    run.onLive({ k: "tool", at: 30, name: "read_note", what: "daniel-5.md", ok: true, ms: 120, res: "# Daniel 5" });
    run.onLive({ k: "bogus", at: 1 });
    run.onLive("not a step");
    for (let i = 0; i < MAX_RUN_STEPS + 5; i += 1) run.onLive({ k: "tool", at: 100 + i, name: "search", ok: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const kept = await storage.get<AppRun>(APP_RUN_KEY);
    expect(kept?.turn).toBe("turn-1");
    expect(kept?.steps).toHaveLength(MAX_RUN_STEPS);
    expect(kept?.steps.at(-1)?.at).toBe(100 + MAX_RUN_STEPS + 4);
    await run.end();
    expect(await storage.get(APP_RUN_KEY)).toBeUndefined();
    run.onLive({ k: "tool", at: 999, name: "late", ok: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await storage.get(APP_RUN_KEY)).toBeUndefined();
  });

  it("merges a thinking piece that carries on the last one", async () => {
    const storage = new MemoryStorage();
    const fresh = appRunKeeper(storage, "t", [], 0);
    fresh.onLive({ k: "think", at: 1, text: "Reading the…" });
    fresh.onLive({ k: "think", at: 2, text: "Reading the notes" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await storage.get<AppRun>(APP_RUN_KEY))?.steps).toEqual([{ k: "think", at: 2, text: "Reading the notes" }]);
  });

  it("keeps only the card's fields, cut short", () => {
    expect(liveStepFrom({ k: "tool", at: 1.4, name: "x".repeat(99), ok: true, args: { secret: 1 } })).toEqual({ k: "tool", at: 1, name: "x".repeat(40), ok: true });
  });

  it("asks for live steps only when it has somewhere to show them, and hands each to onLive", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      const lines = [{ live: { k: "tool", at: 5, name: "search", ok: true } }, { status: 200, body: { answer: "done" } }];
      return new Response(lines.map((line) => JSON.stringify(line)).join("\n") + "\n", { headers: { "content-type": "application/x-ndjson" } });
    }) as unknown as Fetch;
    const seen: unknown[] = [];
    const answer = await askAgent(fetch, "https://gw", "t", "q", undefined, undefined, [], undefined, undefined, { onLive: (step) => void seen.push(step) });
    expect(answer.kind).toBe("answer");
    expect(bodies[0].live).toBe(true);
    expect(seen).toEqual([{ k: "tool", at: 5, name: "search", ok: true }]);
    const plain = (async (_url: string, init: RequestInit) => (bodies.push(JSON.parse(String(init.body))), Response.json({ answer: "ok" }))) as unknown as Fetch;
    await askAgent(plain, "https://gw", "t", "q");
    expect(bodies[1].live).toBeUndefined();
  });
});
