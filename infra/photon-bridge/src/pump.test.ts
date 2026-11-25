import { describe, expect, it, vi } from "vitest";
import { CHECKPOINT_PREFIX, deliverOnce, HELD_ALERT_MS, LONG_POLL_MS, PARK_AFTER_MS, PARK_RETRY_MS, PARKED_PREFIX, Pump, retryDelayMs, type Parked, type QueuedEvent } from "./pump";
import type { PhotonEvent } from "./contract";

const LINE = "+15550100123";

function event(seq: number): PhotonEvent {
  return {
    seq,
    eventId: `photon:message.received:msg-${seq}`,
    type: "message.received",
    line: LINE,
    chat: { guid: "any;-;+15550100999", kind: "dm" },
    fromMe: false,
    at: "2026-11-14T12:00:00.000Z",
    message: { guid: `msg-${seq}`, text: "hello" },
  };
}

function queued(seq: number): QueuedEvent {
  return { id: `run:${seq}`, line: LINE, seq, event: event(seq) };
}

function agentReplying(...statuses: (number | Error)[]) {
  const event = vi.fn(async () => {
    const next = statuses.shift();
    if (next instanceof Error) throw next;
    return { status: next ?? 200 };
  });
  return { event };
}

describe("deliverOnce", () => {
  it("passes a 2xx", async () => {
    const log = vi.fn();
    await expect(deliverOnce(agentReplying(200), queued(5), log)).resolves.toBe("delivered");
    expect(log).not.toHaveBeenCalled();
  });

  it("drops a 4xx and logs it without the message text", async () => {
    const log = vi.fn();
    await expect(deliverOnce(agentReplying(422), queued(6), log)).resolves.toBe("dropped");
    expect(log).toHaveBeenCalledWith({ event: "deliver.refused", line: "0123", seq: 6, status: 422 });
    expect(JSON.stringify(log.mock.calls)).not.toContain("hello");
  });

  it("asks for a retry on a 5xx or a thrown call", async () => {
    await expect(deliverOnce(agentReplying(503), queued(7), vi.fn())).resolves.toBe("retry");
    await expect(deliverOnce(agentReplying(new Error("rpc reset")), queued(8), vi.fn())).resolves.toBe("retry");
  });

  it("treats 429 as a refusal the agent gave, not a retry signal", async () => {
    await expect(deliverOnce(agentReplying(429), queued(9), vi.fn())).resolves.toBe("dropped");
  });
});

/** A fake container: a queue of events, `/next` honouring `skip` as `ledger.mjs` does, `/ack` removing one. */
function container(items: QueuedEvent[]) {
  const queue = [...items];
  const acked: string[] = [];
  const polls: string[] = [];
  const fetch = vi.fn(async (input: string | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/next") {
      polls.push(url.search);
      const skip = new Set(url.searchParams.getAll("skip"));
      const item = queue.find((q) => !skip.has(q.event.chat.guid));
      return item ? Response.json(item) : new Response(null, { status: 204 });
    }
    if (url.pathname === "/ack") {
      const { id } = JSON.parse(String(init?.body)) as { id: string };
      const index = queue.findIndex((q) => q.id === id);
      if (index < 0) return new Response(null, { status: 404 });
      queue.splice(index, 1);
      acked.push(id);
      const seq = Number(id.split(":")[1]);
      return Response.json({ ok: true, line: LINE, frontier: seq });
    }
    return new Response(null, { status: 500 });
  });
  return { port: { fetch }, queue, acked, polls };
}

function inChat(seq: number, guid: string): QueuedEvent {
  const item = queued(seq);
  return { ...item, event: { ...item.event, chat: { guid, kind: "group" } } };
}

/** An agent that fails every event of `failing` chats with 503 until `healed` is set. */
function agentFailing(failing: Set<string>) {
  const seen: number[] = [];
  return {
    seen,
    event: vi.fn(async (e: PhotonEvent) => {
      if (failing.has(e.chat.guid)) return { status: 503 };
      seen.push(e.seq ?? -1);
      return { status: 200 };
    }),
  };
}

describe("Pump", () => {
  it("is idle when the container has nothing queued", async () => {
    const box = container([]);
    const agent = agentReplying();
    const pump = new Pump({ port: box.port, agent, store: { put: vi.fn(async () => {}) }, log: vi.fn() });
    await expect(pump.step()).resolves.toBe("idle");
    expect(agent.event).not.toHaveBeenCalled();
  });

  it("delivers, acks, and stores the frontier the container reports", async () => {
    const box = container([queued(11)]);
    const store = { put: vi.fn(async () => {}) };
    const pump = new Pump({ port: box.port, agent: agentReplying(200), store, log: vi.fn() });
    await expect(pump.step()).resolves.toBe("acked");
    expect(box.acked).toEqual(["run:11"]);
    expect(store.put).toHaveBeenCalledWith(`${CHECKPOINT_PREFIX}${LINE}`, 11);
  });

  it("acks an event the bridge made itself (no sequence) and stores no frontier for it", async () => {
    const box = container([{ ...queued(14), seq: null }]);
    const store = { put: vi.fn(async () => {}) };
    await expect(new Pump({ port: box.port, agent: agentReplying(200), store, log: vi.fn() }).step()).resolves.toBe("acked");
    expect(store.put).not.toHaveBeenCalled();
  });

  it("one chat's failing event never holds another chat's texts (2026-11-25: a members change held the whole line)", async () => {
    const box = container([inChat(1, "group-a"), inChat(2, "group-a"), inChat(3, "dm-b"), inChat(4, "dm-c")]);
    const failing = new Set(["group-a"]);
    const agent = agentFailing(failing);
    let clock = 0;
    const pump = new Pump({ port: box.port, agent, store: { put: vi.fn(async () => {}) }, log: vi.fn(), now: () => clock });
    for (let i = 0; i < 4; i++) await pump.step();
    // b and c went through while a's head is retried; a's second text was never handed over before its head.
    expect(agent.seen).toEqual([3, 4]);
    expect(box.acked).toEqual(["run:3", "run:4"]);
    expect(pump.busy()).toEqual(["group-a"]);
    expect(box.polls.at(-1)).toContain("skip=group-a");
    // a heals: its head goes, then its second text, in order.
    failing.clear();
    clock += 60_000;
    await pump.step();
    await pump.step();
    expect(agent.seen).toEqual([3, 4, 1, 2]);
    expect(pump.busy()).toEqual([]);
  });

  it("parks an event still failing after PARK_AFTER_MS, alerts, and lets its chat move on", async () => {
    const box = container([inChat(1, "group-a"), inChat(2, "group-a")]);
    const agent = { event: vi.fn(async (e: PhotonEvent) => ({ status: e.seq === 1 ? 503 : 200 })) };
    const kept = new Map<string, Parked>();
    const parked = {
      put: vi.fn(async (k: string, v: Parked) => void kept.set(k, v)),
      list: vi.fn(async () => new Map(kept)),
      delete: vi.fn(async (k: string) => kept.delete(k)),
    };
    const log = vi.fn();
    let clock = 0;
    const pump = new Pump({ port: box.port, agent, store: { put: vi.fn(async () => {}) }, parked, log, now: () => clock });
    await pump.step();
    expect(pump.busy()).toEqual(["group-a"]);
    clock = HELD_ALERT_MS;
    await pump.step();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "bridge.alert", outcome: "chat_held", seq: 1 }));
    clock = PARK_AFTER_MS + 1;
    await pump.step();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "bridge.alert", outcome: "event_parked", seq: 1 }));
    expect([...kept.keys()]).toEqual([`${PARKED_PREFIX}run:1`]);
    expect(box.acked).toEqual(["run:1", "run:2"]);
    expect(JSON.stringify(log.mock.calls)).not.toContain("hello");
  });

  it("offers a parked event again after PARK_RETRY_MS and forgets it once taken", async () => {
    const item = inChat(9, "group-a");
    const kept = new Map<string, Parked>([[`${PARKED_PREFIX}${item.id}`, { item, parkedAt: 0, triedAt: 0 }]]);
    const parked = {
      put: vi.fn(async (k: string, v: Parked) => void kept.set(k, v)),
      list: vi.fn(async () => new Map(kept)),
      delete: vi.fn(async (k: string) => kept.delete(k)),
    };
    const agent = agentReplying(200);
    let clock = PARK_RETRY_MS - 1;
    const pump = new Pump({ port: container([]).port, agent, store: { put: vi.fn(async () => {}) }, parked, log: vi.fn(), now: () => clock });
    await pump.step();
    expect(agent.event).not.toHaveBeenCalled();
    clock = PARK_RETRY_MS + 120_000;
    await pump.step();
    expect(agent.event).toHaveBeenCalledTimes(1);
    expect(kept.size).toBe(0);
  });

  it("waits no longer than until the next retry is due", async () => {
    const box = container([inChat(1, "group-a")]);
    let clock = 0;
    const pump = new Pump({ port: box.port, agent: agentFailing(new Set(["group-a"])), store: { put: vi.fn(async () => {}) }, log: vi.fn(), now: () => clock });
    await pump.step();
    expect(pump.waitMs()).toBe(1000);
    expect(pump.waitMs()).toBeLessThan(LONG_POLL_MS);
  });

  it("fails on a bad next response so the caller backs off", async () => {
    const port = { fetch: vi.fn(async () => new Response(null, { status: 500 })) };
    await expect(new Pump({ port, agent: agentReplying(), store: { put: vi.fn(async () => {}) }, log: vi.fn() }).step()).rejects.toThrow("next 500");
  });
});

describe("retryDelayMs", () => {
  it("doubles and stops at one minute", () => {
    expect([0, 1, 2, 3].map(retryDelayMs)).toEqual([1000, 2000, 4000, 8000]);
    expect(retryDelayMs(50)).toBe(60_000);
  });
});
