/**
 * The access screens' socket to the objects that hold who may reach what
 * (`GET /presence/access` on the gateway; decided by the owner, 2026-11-01).
 * One socket per side and workspace:
 * - `workspace`: that workspace's members and invitations;
 * - `person`: this person's own reach, invitations, connected apps and
 *   "shared with me", from their personal workspace's object.
 *
 * The token is the console grant, offered as a subprotocol beside
 * `context.access` so it never sits in a URL, as the tree's socket does.
 *
 * What the socket can say, and what the screens do about it:
 * - a topic's rows: show them, in place of the Convex query's;
 * - `not_served` for a topic: read that topic from Convex as before;
 * - closed as not served (nothing asked for is in the object yet): read
 *   Convex, and ask the object again after a while, so a workspace switched
 *   over later moves to it without a reload;
 * - closed to be authorized again (every five minutes, or the person lost
 *   access): reconnect at once with a fresh grant;
 * - anything else: reconnect after a growing wait, reading Convex meanwhile.
 *
 * A write (`run`) is answered by the object; while the socket is not open or
 * the object does not serve the write, it rejects with `not_served` and the
 * caller makes the Convex call instead.
 */

import {
  ACCESS_CLOSE_NOT_SERVED,
  ACCESS_CLOSE_REAUTH,
  ACCESS_PROTOCOL,
  ACCESS_SOCKET_PATH,
  decodeServerFrame,
  opFrame,
  pingFrame,
  subFrame,
} from "@context/shared/src/accessFrames.cjs";

export type AccessSide = "workspace" | "person";

/** How long a side the object does not serve reads Convex before the object is asked again. */
export const NOT_SERVED_RETRY_MS = 5 * 60_000;
const PING_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;
const OP_TIMEOUT_MS = 15_000;

export function accessSocketUrl(gatewayOrigin: string, side: AccessSide): string {
  const url = new URL(ACCESS_SOCKET_PATH, gatewayOrigin);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.searchParams.set("of", side);
  return url.toString();
}

export function accessSocketProtocols(token: string): string[] {
  return [ACCESS_PROTOCOL, `context.token.${token}`];
}

export function backoffMs(failures: number): number {
  return Math.min(MAX_BACKOFF_MS, 500 * 2 ** Math.max(0, failures));
}

/** A write the object refused, with its fixed code (`not_served` means: make the Convex call). */
export class AccessRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AccessRefusal";
  }
}

interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface ObjectAccessOptions {
  gatewayOrigin: string;
  side: AccessSide;
  /** The console grant's token; `refresh` mints a new one. Rejects when there is none. */
  token: (refresh: boolean) => Promise<string>;
  /** A topic's rows from the object, or `undefined` when the object does not serve it (read Convex). */
  onTopic: (topic: string, rows: unknown | undefined) => void;
  /** For tests: the socket and the clock. */
  open?: (url: string, protocols: string[]) => SocketLike;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface ObjectAccess {
  /** The topics to keep live; sent now when open, and again on every reconnect. */
  subscribe(topics: readonly string[]): void;
  /** One write, answered by the object; rejects with an `AccessRefusal`. */
  run(op: string, args?: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

const OPEN = 1;

export function openObjectAccess(options: ObjectAccessOptions): ObjectAccess {
  const open = options.open ?? ((url: string, protocols: string[]) => new WebSocket(url, protocols) as unknown as SocketLike);
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const { side } = options;
  let topics: readonly string[] = [];
  let socket: SocketLike | null = null;
  let stopped = false;
  let failures = 0;
  let refresh = false;
  let retry: unknown = null;
  let ping: unknown = null;
  let nextOp = 0;
  const waiting = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: unknown }>();

  const clear = () => {
    if (retry !== null) clearTimer(retry);
    if (ping !== null) clearTimer(ping);
    retry = null;
    ping = null;
  };
  const later = (ms: number) => {
    clear();
    if (!stopped) retry = setTimer(() => void connect(), ms);
  };
  const keepAlive = () => {
    ping = setTimer(() => {
      if (socket?.readyState === OPEN) socket.send(pingFrame());
      keepAlive();
    }, PING_MS);
  };
  /** Every topic back to Convex, and every write in flight refused so its caller asks Convex. */
  const unserved = () => {
    for (const topic of topics) options.onTopic(topic, undefined);
    for (const [id, held] of waiting) {
      clearTimer(held.timer);
      held.reject(new AccessRefusal("not_served"));
      waiting.delete(id);
    }
  };

  const connect = async () => {
    if (stopped) return;
    let token: string;
    try {
      token = await options.token(refresh);
    } catch {
      failures += 1;
      return later(failures >= 3 ? NOT_SERVED_RETRY_MS : backoffMs(failures - 1));
    }
    refresh = false;
    if (stopped) return;
    let opened = false;
    const live = open(accessSocketUrl(options.gatewayOrigin, side), accessSocketProtocols(token));
    socket = live;
    live.onopen = () => {
      opened = true;
      live.send(subFrame(topics));
      keepAlive();
    };
    live.onmessage = (event) => {
      const frame = decodeServerFrame(side, typeof event.data === "string" ? event.data : null);
      if (frame === null) return;
      if (frame.t === "rows") {
        failures = 0;
        options.onTopic(frame.topic, frame.rows);
      } else if (frame.t === "not_served") {
        options.onTopic(frame.topic, undefined);
      } else if (frame.t === "ack") {
        const held = waiting.get(frame.id);
        if (held === undefined) return;
        waiting.delete(frame.id);
        clearTimer(held.timer);
        if (frame.ok) held.resolve(frame.result);
        else held.reject(new AccessRefusal(frame.error));
      }
    };
    live.onerror = () => {};
    live.onclose = (event) => {
      if (socket === live) socket = null;
      clear();
      unserved();
      if (stopped) return;
      if (event.code === ACCESS_CLOSE_NOT_SERVED) return later(NOT_SERVED_RETRY_MS);
      if (event.code === ACCESS_CLOSE_REAUTH) {
        refresh = true;
        return later(0);
      }
      failures += 1;
      // Refused before it opened: the grant may be the reason, so the next try mints a new one, once. A gateway
      // that keeps refusing (no object, an older deployment) is asked again only after a while.
      if (!opened) {
        refresh = failures === 1;
        if (failures >= 3) return later(NOT_SERVED_RETRY_MS);
      }
      later(backoffMs(failures - 1));
    };
  };

  void connect();
  return {
    subscribe(next) {
      topics = [...new Set(next)];
      if (socket?.readyState === OPEN) socket.send(subFrame(topics));
    },
    run(op, args = {}) {
      const live = socket;
      if (stopped || live === null || live.readyState !== OPEN) return Promise.reject(new AccessRefusal("not_served"));
      nextOp += 1;
      const id = `op${nextOp}`;
      return new Promise((resolve, reject) => {
        const timer = setTimer(() => {
          waiting.delete(id);
          reject(new AccessRefusal("timeout"));
        }, OP_TIMEOUT_MS);
        waiting.set(id, { resolve, reject, timer });
        live.send(opFrame(id, op, args));
      });
    },
    close() {
      stopped = true;
      clear();
      const live = socket;
      socket = null;
      unserved();
      try {
        live?.close(1000, "done");
      } catch {
        // Already closing.
      }
    },
  };
}
