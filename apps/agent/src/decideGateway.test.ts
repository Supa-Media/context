/**
 * DECIDE ASKED OF CLEF IN THE GATEWAY, UNDER THE CONTROL PLANE'S CAP (`decideGateway.ts`, `decide.ts`; Dev2's pick,
 * 2026-11-05: decide moves into the gateway and keeps its daily cap and usage rows, off each text's path).
 *
 * Sabotage record (applied, run, observed failing, reverted):
 *  1. the gate asked on every decide (no keeping) → "the gate is asked once" fails.
 *  2. `remaining` never counted down → "the day's count runs out here" fails.
 *  3. a refused gate falling through to the gateway → "a refused gate never reaches Clef" fails.
 *  4. `no_group` kept like any refusal (2026-11-12) → "a group not set up yet is never kept refused" fails.
 */

import { afterEach, describe, expect, it } from "vitest";
import { decide, recheck, type ControlDeps } from "./decide";
import { forgetGates, GATE_FOR_MS } from "./decideGateway";

afterEach(() => forgetGates());

const id = (n: number) => `${String(1_700_000_000_000 + n).padStart(13, "0")}-${String(n).padStart(6, "0")}`;
const ask = { chat: "+15555550100", sender: "+15555550100", style: "direct" as const, transcript: "<x> @ada: hi", candidates: [id(1)], running: false, waitingAsks: [], newest: id(1) };

function world(opts: { gate?: Record<string, unknown>; gateway?: "down" | Record<string, unknown> } = {}) {
  let clock = 1_000_000;
  const control: { path: string; body: Record<string, unknown> }[] = [];
  const gateway: { url: string; body: Record<string, unknown> }[] = [];
  const later: Promise<unknown>[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init.body));
    control.push({ path, body });
    if (path === "/agent-texts/decide/gate") return Response.json(opts.gate ?? { ok: true, remaining: 100 });
    if (path === "/agent-texts/decide/usage") return Response.json({ ok: true });
    if (path === "/agent-texts/decide") return Response.json({ ok: true, act: "silent", covers: [], stale: [], movedOn: false, confidence: 0.5 });
    return new Response("no", { status: 404 });
  }) as unknown as ControlDeps["fetch"];
  const binding = {
    fetch: async (url: string, init?: RequestInit) => {
      if (opts.gateway === "down") throw new Error("unreachable");
      gateway.push({ url, body: JSON.parse(String(init?.body)) });
      const answer = opts.gateway ?? (url.endsWith("/texts/recheck") ? { ok: true, fits: false, confidence: 0.1 } : { ok: true, act: "answer", covers: [id(1)], stale: [], movedOn: false, confidence: 0.9 });
      return Response.json({ ...answer, meter: { questions: 6, chars: 5_000, ms: 300, answered: true } });
    },
  };
  const deps: ControlDeps & { now: () => number } = { fetch, controlPlaneOrigin: "https://cp.example", workerSecret: "s", texts: { binding }, waitUntil: (work) => void later.push(work), now: () => clock };
  return { deps, control, gateway, settle: () => Promise.all(later), tick: (ms: number) => (clock += ms) };
}

const paths = (w: ReturnType<typeof world>) => w.control.map((call) => call.path);

describe("decide in the gateway", () => {
  it("asks Clef in the gateway, never the control plane's decide, and reports the usage after", async () => {
    const w = world();
    const decision = await decide(w.deps, ask);
    expect(decision).toMatchObject({ ok: true, act: "answer", covers: [id(1)] });
    expect(w.gateway.map((call) => call.url)).toEqual(["https://gateway/texts/decide"]);
    expect(w.gateway[0].body).toMatchObject({ chat: ask.chat, sender: ask.sender, style: "direct", newest: id(1) });
    await w.settle();
    expect(paths(w)).toEqual(["/agent-texts/decide/gate", "/agent-texts/decide/usage"]);
    expect(w.control[1].body).toEqual({ chat: ask.chat, sender: ask.sender, style: "direct", calls: 1, failed: 0, refused: 0, questions: 6, chars: 5_000, ms: 300 });
    expect(JSON.stringify(w.control.map((call) => call.body))).not.toContain("@ada");
  });

  it("the gate is asked once, kept, and refreshed beside a text once it is old", async () => {
    const w = world();
    await decide(w.deps, ask);
    await decide(w.deps, ask);
    await w.settle();
    expect(paths(w).filter((path) => path.endsWith("/gate"))).toHaveLength(1);
    w.tick(GATE_FOR_MS + 1);
    await decide(w.deps, ask);
    await w.settle();
    expect(paths(w).filter((path) => path.endsWith("/gate"))).toHaveLength(2);
    expect(w.gateway).toHaveLength(3);
  });

  it("the day's count runs out here, between gates", async () => {
    const w = world({ gate: { ok: true, remaining: 1 } });
    expect(await decide(w.deps, ask)).toMatchObject({ ok: true });
    expect(await decide(w.deps, ask)).toMatchObject({ ok: false, reason: "capped", cause: "daily_cap" });
    expect(w.gateway).toHaveLength(1);
  });

  it("a refused gate never reaches Clef, and is reported as refused", async () => {
    const w = world({ gate: { ok: false, reason: "off", cause: "switched_off" } });
    expect(await decide(w.deps, ask)).toMatchObject({ ok: false, reason: "off", cause: "switched_off" });
    await w.settle();
    expect(w.gateway).toEqual([]);
    expect(w.control.at(-1)).toMatchObject({ path: "/agent-texts/decide/usage", body: { refused: 1, calls: 0 } });
  });

  it("a group not set up yet is never kept refused: its next text asks again and reaches Clef (2026-11-12)", async () => {
    // A brand-new group's first text is refused no_group before its turn makes the chat's row; kept for a minute, its
    // second text got the same refusal and no tapback (the sister group and Nov Babies, 2026-11-11 and 11-12).
    let gate: Record<string, unknown> = { ok: false, reason: "unavailable", cause: "no_group" };
    const w = world();
    const fetch = w.deps.fetch;
    w.deps.fetch = (async (url: string, init: RequestInit) => (new URL(url).pathname === "/agent-texts/decide/gate" ? Response.json(gate) : fetch(url, init))) as typeof fetch;
    expect(await decide(w.deps, ask)).toMatchObject({ ok: false, cause: "no_group" });
    gate = { ok: true, remaining: 100 };
    expect(await decide(w.deps, ask)).toMatchObject({ ok: true, act: "answer" });
    expect(w.gateway).toHaveLength(1);
  });

  it("any other refusal is kept for its minute", async () => {
    let gate: Record<string, unknown> = { ok: false, reason: "off", cause: "switched_off" };
    const w = world();
    const fetch = w.deps.fetch;
    w.deps.fetch = (async (url: string, init: RequestInit) => (new URL(url).pathname === "/agent-texts/decide/gate" ? Response.json(gate) : fetch(url, init))) as typeof fetch;
    await decide(w.deps, ask);
    gate = { ok: true, remaining: 100 };
    expect(await decide(w.deps, ask)).toMatchObject({ ok: false, cause: "switched_off" });
    expect(w.gateway).toEqual([]);
  });

  it("a gateway it cannot reach: the control plane's own decide, as before", async () => {
    const w = world({ gateway: "down" });
    expect(await decide(w.deps, ask)).toMatchObject({ ok: true, act: "silent" });
    expect(paths(w)).toContain("/agent-texts/decide");
  });

  it("the last look goes the same way", async () => {
    const w = world();
    expect(await recheck(w.deps, ask, "Here's the playbook.", id(0))).toEqual({ ok: true, fits: false });
    expect(w.gateway[0]).toMatchObject({ url: "https://gateway/texts/recheck", body: { draft: "Here's the playbook.", draftFor: id(0) } });
  });

  it("without the binding, the control plane is asked as before", async () => {
    const w = world();
    const { texts: _texts, ...plain } = w.deps;
    expect(await decide(plain, ask)).toMatchObject({ ok: true, act: "silent" });
    expect(paths(w)).toEqual(["/agent-texts/decide"]);
  });
});
