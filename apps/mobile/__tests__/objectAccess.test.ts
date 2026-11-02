/**
 * The access screens' socket to the objects that hold who may reach what
 * (`objectAccess.ts`): the address and grant, subscriptions sent on open, rows
 * and `not_served` laid down per topic, writes answered or refused, a close as
 * not served handing every topic back to Convex, a re-authorization reconnecting
 * at once, a gateway that keeps refusing not minting a grant every few seconds,
 * and close() stopping everything.
 */

import { describe, expect, test } from "@jest/globals";
import {
  AccessRefusal,
  NOT_SERVED_RETRY_MS,
  accessSocketProtocols,
  accessSocketUrl,
  openObjectAccess,
} from "../features/access/objectAccess";

type Fake = {
  url: string;
  protocols: string[];
  readyState: number;
  sent: string[];
  closed: Array<{ code: number | undefined; reason: string | undefined }>;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
};

const OP_TIMEOUT_MS = 15_000;
const PING_MS = 30_000;

function harness() {
  const sockets: Fake[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const topics: Array<[string, unknown]> = [];
  const refreshes: boolean[] = [];
  const flush = async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  };
  const access = openObjectAccess({
    gatewayOrigin: "https://mcp.context.lc",
    side: "person",
    token: async (refresh) => {
      refreshes.push(refresh);
      return "T";
    },
    onTopic: (topic, rows) => topics.push([topic, rows]),
    open: (url, protocols) => {
      const socket: Fake = {
        url,
        protocols,
        readyState: 0,
        sent: [],
        closed: [],
        send(data) {
          this.sent.push(data);
        },
        close(code, reason) {
          this.closed.push({ code, reason });
          this.readyState = 3;
        },
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
      };
      sockets.push(socket);
      return socket;
    },
    setTimer: (fn, ms) => {
      const timer = { fn, ms };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      const at = timers.indexOf(handle as { fn: () => void; ms: number });
      if (at >= 0) timers.splice(at, 1);
    },
  });
  const opened = (socket: Fake) => {
    socket.readyState = 1;
    socket.onopen?.({});
  };
  /** The op frames a socket was sent, in order (the `sub` sent on open is not one). */
  const ops = (socket: Fake) => socket.sent.map((data) => JSON.parse(data)).filter((frame) => frame.t === "op");
  const message = (socket: Fake, frame: unknown) => {
    socket.onmessage?.({ data: JSON.stringify(frame) });
  };
  /** The one retry timer left after a close (the ping and every op timer are cleared by then). */
  const runRetry = async () => {
    if (timers.length !== 1) throw new Error(`expected one retry timer, found ${timers.length}`);
    const [retry] = timers;
    timers.splice(0, 1);
    retry.fn();
    await flush();
    return retry.ms;
  };
  /** A write's rejection, caught as it happens so no rejection goes unhandled. */
  const refused = (promise: Promise<unknown>) => promise.then(
    () => {
      throw new Error("the write was not refused");
    },
    (error: unknown) => error,
  );
  return { access, sockets, timers, topics, refreshes, flush, opened, ops, message, runRetry, refused };
}

describe("the access socket to the object", () => {
  test("its address is wss on the gateway's path, and the token never goes in the URL", async () => {
    expect(accessSocketUrl("https://mcp.context.lc", "person")).toBe("wss://mcp.context.lc/presence/access?of=person");
    expect(accessSocketUrl("http://127.0.0.1:8799", "workspace")).toBe("ws://127.0.0.1:8799/presence/access?of=workspace");
    expect(accessSocketProtocols("T")).toEqual(["context.access", "context.token.T"]);

    const h = harness();
    await h.flush();
    expect(h.sockets[0].url).toBe("wss://mcp.context.lc/presence/access?of=person");
    expect(h.sockets[0].url).not.toContain("token");
    expect(h.sockets[0].protocols).toEqual(["context.access", "context.token.T"]);
  });

  test("the subscribed topics are sent when the socket opens, and a later subscribe sends them again", async () => {
    const h = harness();
    h.access.subscribe(["reach", "my_invites"]);
    await h.flush();
    h.opened(h.sockets[0]);
    expect(JSON.parse(h.sockets[0].sent[0])).toEqual({ t: "sub", topics: ["reach", "my_invites"] });
    h.access.subscribe(["reach"]);
    expect(JSON.parse(h.sockets[0].sent[1])).toEqual({ t: "sub", topics: ["reach"] });
  });

  test("a rows frame is handed to its topic, and not_served hands the topic back to Convex", async () => {
    const h = harness();
    await h.flush();
    h.opened(h.sockets[0]);
    const rows = [{ id: "a" }];
    h.message(h.sockets[0], { t: "rows", topic: "reach", rows });
    h.message(h.sockets[0], { t: "not_served", topic: "my_invites" });
    expect(h.topics).toEqual([
      ["reach", rows],
      ["my_invites", undefined],
    ]);
  });

  test("a frame for a topic of the other side is ignored", async () => {
    const h = harness();
    await h.flush();
    h.opened(h.sockets[0]);
    h.message(h.sockets[0], { t: "rows", topic: "members", rows: [{ id: "m" }] });
    h.message(h.sockets[0], { t: "not_served", topic: "members" });
    expect(h.topics).toEqual([]);
  });

  test("a write is refused as not served while the socket is not open", async () => {
    const h = harness();
    const early = await h.refused(h.access.run("accept_invite", { id: "i1" }));
    expect(early).toBeInstanceOf(AccessRefusal);
    expect((early as AccessRefusal).code).toBe("not_served");

    await h.flush();
    const connecting = await h.refused(h.access.run("accept_invite", { id: "i1" }));
    expect((connecting as AccessRefusal).code).toBe("not_served");
    expect(h.sockets[0].sent).toEqual([]);
  });

  test("an open write is sent as an op frame and resolves with the object's ok ack", async () => {
    const h = harness();
    await h.flush();
    h.opened(h.sockets[0]);
    const pending = h.access.run("accept_invite", { id: "i1" });
    const [sent] = h.ops(h.sockets[0]);
    expect(sent).toEqual({ t: "op", id: sent.id, op: "accept_invite", args: { id: "i1" } });
    h.message(h.sockets[0], { t: "ack", id: sent.id, ok: true, result: { done: true } });
    await expect(pending).resolves.toEqual({ done: true });
  });

  test("an ack with ok false rejects with its code", async () => {
    const h = harness();
    await h.flush();
    h.opened(h.sockets[0]);
    const pending = h.refused(h.access.run("revoke_connection", { id: "c1" }));
    const [sent] = h.ops(h.sockets[0]);
    h.message(h.sockets[0], { t: "ack", id: sent.id, ok: false, error: "forbidden" });
    const error = await pending;
    expect(error).toBeInstanceOf(AccessRefusal);
    expect((error as AccessRefusal).code).toBe("forbidden");
  });

  test("a write with no ack within fifteen seconds is refused as a timeout", async () => {
    const h = harness();
    await h.flush();
    h.opened(h.sockets[0]);
    const pending = h.refused(h.access.run("decline_invite", { id: "i2" }));
    const timeout = h.timers.find((timer) => timer.ms === OP_TIMEOUT_MS);
    expect(timeout).toBeDefined();
    timeout?.fn();
    const error = await pending;
    expect(error).toBeInstanceOf(AccessRefusal);
    expect((error as AccessRefusal).code).toBe("timeout");
  });

  test("a close as not served hands every topic to Convex, refuses writes in flight, and retries after the long wait", async () => {
    const h = harness();
    h.access.subscribe(["reach", "my_invites"]);
    await h.flush();
    h.opened(h.sockets[0]);
    const pending = h.refused(h.access.run("accept_invite", { id: "i3" }));
    h.sockets[0].onclose?.({ code: 4404 });
    expect(h.topics).toEqual([
      ["reach", undefined],
      ["my_invites", undefined],
    ]);
    expect(((await pending) as AccessRefusal).code).toBe("not_served");
    expect(await h.runRetry()).toBe(NOT_SERVED_RETRY_MS);
    await h.flush();
    expect(h.sockets).toHaveLength(2);
  });

  test("a close to be authorized again reconnects at once with a fresh grant", async () => {
    const h = harness();
    await h.flush();
    h.opened(h.sockets[0]);
    h.sockets[0].onclose?.({ code: 4001 });
    expect(await h.runRetry()).toBe(0);
    await h.flush();
    expect(h.refreshes).toEqual([false, true]);
    expect(h.sockets).toHaveLength(2);
  });

  test("a socket refused before it opened asks for a new grant once, then waits the long time after three failures", async () => {
    const h = harness();
    await h.flush();
    h.sockets[0].onclose?.({ code: 1006 });
    const first = await h.runRetry();
    h.sockets[1].onclose?.({ code: 1006 });
    const second = await h.runRetry();
    h.sockets[2].onclose?.({ code: 1006 });
    const third = await h.runRetry();
    expect(first).toBe(500);
    expect(second).toBe(1_000);
    expect(third).toBe(NOT_SERVED_RETRY_MS);
    expect(h.refreshes).toEqual([false, true, false, false]);
  });

  test("close() closes with 1000, reconnects nothing, and a timer that fires later does nothing", async () => {
    const h = harness();
    await h.flush();
    h.opened(h.sockets[0]);
    h.access.close();
    expect(h.sockets[0].closed).toEqual([{ code: 1000, reason: "done" }]);
    h.sockets[0].onclose?.({ code: 1006 });
    expect(h.timers.filter((timer) => timer.ms === PING_MS)).toHaveLength(0);
    expect(h.timers).toHaveLength(0);
    await h.flush();
    expect(h.sockets).toHaveLength(1);
    expect(h.refreshes).toEqual([false]);
  });

  test("close() during a refused retry leaves the scheduled retry cancelled", async () => {
    const h = harness();
    await h.flush();
    h.sockets[0].onclose?.({ code: 1006 });
    expect(h.timers).toHaveLength(1);
    const [retry] = h.timers;
    h.access.close();
    expect(h.timers).toHaveLength(0);
    retry.fn();
    await h.flush();
    expect(h.sockets).toHaveLength(1);
  });
});
