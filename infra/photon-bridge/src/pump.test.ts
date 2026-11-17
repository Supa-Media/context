import { describe, expect, it, vi } from "vitest";
import { CHECKPOINT_PREFIX, deliver, pumpOnce, retryDelayMs, type QueuedEvent } from "./pump";
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

const noSleep = vi.fn(async () => {});

describe("deliver", () => {
  it("passes a 2xx and does not wait", async () => {
    const agent = agentReplying(200);
    const log = vi.fn();
    await expect(deliver(agent, queued(5), { sleep: noSleep, log })).resolves.toBe("delivered");
    expect(agent.event).toHaveBeenCalledWith(event(5));
    expect(log).not.toHaveBeenCalled();
  });

  it("drops a 4xx and logs it without the message text", async () => {
    const agent = agentReplying(422);
    const log = vi.fn();
    await expect(deliver(agent, queued(6), { sleep: noSleep, log })).resolves.toBe("dropped");
    expect(log).toHaveBeenCalledWith({ event: "deliver.refused", line: "0123", seq: 6, status: 422 });
    expect(JSON.stringify(log.mock.calls)).not.toContain("hello");
  });

  it("retries a 5xx with backoff until the agent takes it", async () => {
    const agent = agentReplying(503, 500, 200);
    const sleep = vi.fn(async (_ms: number) => {});
    const log = vi.fn();
    await expect(deliver(agent, queued(7), { sleep, log })).resolves.toBe("delivered");
    expect(agent.event).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([1000, 2000]);
  });

  it("retries a thrown call, not only a status", async () => {
    const agent = agentReplying(new Error("rpc reset"), 200);
    const sleep = vi.fn(async () => {});
    await expect(deliver(agent, queued(8), { sleep, log: vi.fn() })).resolves.toBe("delivered");
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("treats 429 as a refusal the agent gave, not a retry signal", async () => {
    const agent = agentReplying(429);
    await expect(deliver(agent, queued(9), { sleep: noSleep, log: vi.fn() })).resolves.toBe("dropped");
  });
});

describe("pumpOnce", () => {
  function port(responses: Response[]) {
    const fetch = vi.fn(async (_input: string | Request, _init?: RequestInit) => responses.shift() ?? new Response(null, { status: 500 }));
    return { fetch };
  }

  it("is idle when the container has nothing queued", async () => {
    const store = { put: vi.fn(async () => {}) };
    const agent = agentReplying();
    const result = await pumpOnce({
      port: port([new Response(null, { status: 204 })]),
      agent,
      store,
      sleep: noSleep,
      log: vi.fn(),
    });
    expect(result).toBe("idle");
    expect(agent.event).not.toHaveBeenCalled();
    expect(store.put).not.toHaveBeenCalled();
  });

  it("delivers, acks, and stores the frontier the container reports", async () => {
    const store = { put: vi.fn(async () => {}) };
    const agent = agentReplying(200);
    const tcp = port([
      Response.json(queued(11)),
      Response.json({ ok: true, line: LINE, frontier: 11 }),
    ]);
    const result = await pumpOnce({ port: tcp, agent, store, sleep: noSleep, log: vi.fn() });
    expect(result).toBe("acked");
    expect(tcp.fetch.mock.calls[1]?.[0]).toBe("http://container/ack");
    expect(JSON.parse(String((tcp.fetch.mock.calls[1]?.[1] as RequestInit).body))).toEqual({ id: "run:11" });
    expect(store.put).toHaveBeenCalledWith(`${CHECKPOINT_PREFIX}${LINE}`, 11);
  });

  it("acks an event the bridge made itself (no sequence) and stores no frontier for it", async () => {
    const store = { put: vi.fn(async () => {}) };
    const agent = agentReplying(200);
    const tcp = port([Response.json({ ...queued(14), seq: null }), Response.json({ ok: true, line: LINE, frontier: 9 })]);
    await expect(pumpOnce({ port: tcp, agent, store, sleep: noSleep, log: vi.fn() })).resolves.toBe("acked");
    expect(agent.event).toHaveBeenCalledTimes(1);
    expect(store.put).not.toHaveBeenCalled();
  });

  it("does not ack an event the agent has not taken", async () => {
    const store = { put: vi.fn(async () => {}) };
    const tcp = port([Response.json(queued(12))]);
    const agent = {
      event: vi.fn(async () => {
        throw new Error("agent down");
      }),
    };
    // The loop retries forever on a failing agent; stop it after the first attempt.
    const sleep = vi.fn(async () => {
      throw new Error("stop");
    });
    await expect(
      pumpOnce({ port: tcp, agent, store, sleep, log: vi.fn() }),
    ).rejects.toThrow("stop");
    expect(tcp.fetch).toHaveBeenCalledTimes(1);
    expect(store.put).not.toHaveBeenCalled();
  });

  it("treats an ack the container no longer knows as done, and stores nothing", async () => {
    const store = { put: vi.fn(async () => {}) };
    const tcp = port([Response.json(queued(13)), new Response(null, { status: 404 })]);
    await expect(pumpOnce({ port: tcp, agent: agentReplying(200), store, sleep: noSleep, log: vi.fn() })).resolves.toBe("acked");
    expect(store.put).not.toHaveBeenCalled();
  });

  it("fails on a bad next response so the caller backs off", async () => {
    const tcp = port([new Response(null, { status: 500 })]);
    await expect(
      pumpOnce({ port: tcp, agent: agentReplying(), store: { put: vi.fn(async () => {}) }, sleep: noSleep, log: vi.fn() }),
    ).rejects.toThrow("next 500");
  });
});

describe("retryDelayMs", () => {
  it("doubles and stops at one minute", () => {
    expect([0, 1, 2, 3].map(retryDelayMs)).toEqual([1000, 2000, 4000, 8000]);
    expect(retryDelayMs(50)).toBe(60_000);
  });
});
