/** @jest-environment jsdom */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { ConsoleGrantCache, type ConsoleGrant } from "../features/agent/consoleGrantCache";

const mockIssue = jest.fn<() => Promise<ConsoleGrant>>();
let mockCache: ConsoleGrantCache;
const mockGrant = ({ workspaceId }: { workspaceId: string }, force = false) =>
  mockCache.get(workspaceId, mockIssue, force);
jest.mock("../features/agent/useConsoleGrant", () => ({ useConsoleGrant: () => mockGrant }));

import { usePresence } from "../features/console/presence/usePresence";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Controlled browser events, real presence hook and real grant cache: no network.
class Socket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { sockets.push(this); }
  send(value: string) {
    if (this.readyState !== Socket.OPEN) throw new Error("not open");
    this.sent.push(value);
  }
  close() {
    this.readyState = Socket.CLOSED;
    this.onclose?.({ code: 1000, reason: "", wasClean: true } as CloseEvent);
  }
  drop() {
    this.readyState = Socket.CLOSED;
    this.onclose?.({ code: 1006, reason: "", wasClean: false } as CloseEvent);
  }
  receive(frame: object) { this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent); }
  welcome() {
    this.readyState = Socket.OPEN;
    this.onopen?.();
    this.receive({ t: "welcome", v: 2, you: "self", members: [], seed: false,
      reconnectAfterMs: 300_000, heartbeatMs: 15_000 });
  }
}

let sockets: Socket[];
let root: Root | null;
let container: HTMLDivElement;
const originalSocket = globalThis.WebSocket;
const freshGrant = (): ConsoleGrant => ({ accessToken: `grant-${mockIssue.mock.calls.length}`,
  expiresAt: Date.now() + 3_600_000, scopes: ["read", "write"] });

function Probe({ path }: { path: string }) {
  usePresence({ workspaceId: "workspace", endpoint: "https://gateway.example/mcp",
    notePath: path, enabled: true, textForSeed: () => "", mode: "presence",
    durable: true, documentId: `doc-${path}` });
  return null;
}
async function mount(path = "notes/a.md") {
  await act(async () => { root!.render(createElement(Probe, { path })); });
}
async function advance(ms: number) {
  await act(async () => { await jest.advanceTimersByTimeAsync(ms); });
}
async function event(work: () => void) { await act(async () => { work(); }); }

beforeEach(() => {
  jest.useFakeTimers();
  sockets = [];
  mockCache = new ConsoleGrantCache("recovery-test");
  mockIssue.mockReset().mockImplementation(async () => freshGrant());
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  container.remove();
  globalThis.WebSocket = originalSocket;
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe("presence recovers from stalled connections", () => {
  // Proposed recovery bounds, not claims about the cause of a user's screenshot.
  test("abandons a silent handshake and tries another socket within one minute", async () => {
    await mount();
    const stalled = sockets[0];
    expect(stalled.readyState).toBe(0);
    await advance(60_000);
    expect(stalled.readyState).toBe(Socket.CLOSED);
    expect(sockets.length).toBeGreaterThan(1);
  });

  test("recovers when grant issuance never settles, ignoring its eventual late reply", async () => {
    let resolveLate!: (grant: ConsoleGrant) => void;
    mockIssue.mockImplementationOnce(() => new Promise(resolve => { resolveLate = resolve; }));
    await mount();
    expect(sockets).toHaveLength(0);
    await advance(60_000);
    expect(sockets.length).toBeGreaterThan(0);
    const count = sockets.length;
    await event(() => resolveLate({ accessToken: "late", expiresAt: Date.now() + 3_600_000, scopes: [] }));
    expect(sockets).toHaveLength(count);
  });

  test("replaces a half-open socket when three heartbeats go unanswered", async () => {
    await mount();
    const stalled = sockets[0];
    await event(() => stalled.welcome());
    // No close/error event: the browser still believes this socket is OPEN.
    await advance(60_000);
    expect(stalled.sent.filter(value => JSON.parse(value).t === "ping").length).toBeGreaterThan(0);
    expect(stalled.readyState).toBe(Socket.CLOSED);
    expect(sockets.length).toBeGreaterThan(1);
  });

  test("refreshes a potentially rejected cached grant once after repeated failed handshakes", async () => {
    await mount();
    const originalUrl = sockets[0].url;
    // Browser WebSocket does not expose the HTTP 401 from a rejected upgrade.
    // Two pre-open failures warrant one credential refresh, not one per retry.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await event(() => sockets[sockets.length - 1].drop());
      await advance(1_000);
    }
    expect(mockIssue).toHaveBeenCalledTimes(2);
    expect(sockets[sockets.length - 1].url).not.toBe(originalUrl);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await event(() => sockets[sockets.length - 1].drop());
      await advance(30_000);
    }
    expect(mockIssue).toHaveBeenCalledTimes(2);
  });

  test("a successful welcome resets transport backoff for the next disconnect", async () => {
    await mount();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await event(() => sockets[sockets.length - 1].drop());
      await advance(2_000);
    }
    await event(() => sockets[sockets.length - 1].welcome());
    const before = sockets.length;
    await event(() => sockets[sockets.length - 1].drop());
    await advance(300);
    expect(sockets).toHaveLength(before + 1);
  });
});

describe("recovery must preserve healthy connections and lifecycle cleanup", () => {
  test("keeps a responsive socket rather than reconnecting on every heartbeat", async () => {
    await mount();
    await event(() => sockets[0].welcome());
    for (let tick = 0; tick < 6; tick += 1) {
      await advance(15_000);
      await event(() => sockets[0].receive({ t: "pong" }));
    }
    expect(sockets).toHaveLength(1);
    expect(sockets[0].readyState).toBe(Socket.OPEN);
    expect(mockIssue).toHaveBeenCalledTimes(1);
  });

  test("switching notes and unmounting cancel the old socket and scheduled retries", async () => {
    await mount();
    await event(() => sockets[0].welcome());
    await mount("notes/b.md");
    expect(sockets[0].readyState).toBe(Socket.CLOSED);
    expect(sockets).toHaveLength(2);
    await event(() => sockets[1].drop());
    await event(() => { root!.unmount(); root = null; });
    const messages = sockets.map(socket => socket.sent.length);
    await advance(600_000);
    expect(sockets).toHaveLength(2);
    expect(sockets.map(socket => socket.sent.length)).toEqual(messages);
    expect(sockets.every(socket => socket.readyState === Socket.CLOSED)).toBe(true);
  });

  test("a grant resolving after unmount cannot open a stray socket", async () => {
    let resolveLate!: (grant: ConsoleGrant) => void;
    mockIssue.mockImplementationOnce(() => new Promise(resolve => { resolveLate = resolve; }));
    await mount();
    await event(() => { root!.unmount(); root = null; });
    await event(() => resolveLate(freshGrant()));
    await advance(600_000);
    expect(sockets).toHaveLength(0);
  });
});

describe("late answers and stale callbacks change nothing", () => {
  test("a membership refusal from the control plane stops the room without retrying", async () => {
    mockIssue.mockReset().mockImplementation(async () => {
      throw Object.assign(new Error("gone"), { data: { code: "WORKSPACE_NOT_FOUND" } });
    });
    await mount();
    await advance(600_000);
    expect(sockets).toHaveLength(0);
    expect(mockIssue).toHaveBeenCalledTimes(1);
  });

  test("a mint that fails for another reason is retried on the backoff", async () => {
    mockIssue.mockImplementationOnce(async () => {
      throw Object.assign(new Error("slow down"), { data: { code: "RATE_LIMITED" } });
    });
    await mount();
    await advance(1_000);
    expect(sockets).toHaveLength(1);
  });

  test("the gateway's refusal close code is final", async () => {
    await mount();
    await event(() => sockets[0].welcome());
    await event(() => {
      sockets[0].readyState = Socket.CLOSED;
      sockets[0].onclose?.({ code: 4003, reason: "", wasClean: true } as CloseEvent);
    });
    await advance(600_000);
    expect(sockets).toHaveLength(1);
    expect(mockIssue).toHaveBeenCalledTimes(1);
  });

  test("callbacks from a socket replaced at renewal cannot reconnect or count as liveness", async () => {
    await mount();
    const first = sockets[0];
    await event(() => first.receive({ t: "welcome", v: 2, you: "self", members: [], seed: false,
      reconnectAfterMs: 60_000, heartbeatMs: 15_000 }));
    first.readyState = Socket.OPEN;
    // Renewal is due 15s before the gateway's own close, at 45s.
    await advance(45_000);
    expect(sockets).toHaveLength(2);
    const second = sockets[1];
    await event(() => second.welcome());
    // The first socket's handlers fire late, as a slow browser may deliver them.
    await event(() => first.onclose?.({ code: 1006, reason: "", wasClean: false } as CloseEvent));
    await event(() => first.onmessage?.({ data: JSON.stringify({ t: "pong" }) } as MessageEvent));
    await advance(10_000);
    expect(sockets).toHaveLength(2);
    expect(second.readyState).toBe(Socket.OPEN);
  });

  test("frames from a replaced socket are not proof that its successor is alive", async () => {
    await mount();
    const first = sockets[0];
    await event(() => first.receive({ t: "welcome", v: 2, you: "self", members: [], seed: false,
      reconnectAfterMs: 60_000, heartbeatMs: 15_000 }));
    first.readyState = Socket.OPEN;
    await advance(45_000);
    const second = sockets[1];
    await event(() => second.welcome());
    // The successor goes silent while the old socket, closing slowly, keeps
    // answering: its pongs must not keep the dead successor in place.
    for (let tick = 0; tick < 6; tick += 1) {
      await advance(10_000);
      await event(() => first.onmessage?.({ data: JSON.stringify({ t: "pong" }) } as MessageEvent));
    }
    expect(second.readyState).toBe(Socket.CLOSED);
    expect(sockets.length).toBeGreaterThan(2);
  });

  test("a deadline that would have fired after the welcome does nothing", async () => {
    await mount();
    await event(() => sockets[0].welcome());
    await advance(25_000);
    await event(() => sockets[0].receive({ t: "pong" }));
    expect(sockets).toHaveLength(1);
    expect(sockets[0].readyState).toBe(Socket.OPEN);
  });
});

describe("a backgrounded tab does not reconnect on throttled timers", () => {
  test("late heartbeats are not counted, and the socket is probed on return", async () => {
    await mount();
    const live = sockets[0];
    await event(() => live.welcome());
    // A hidden tab's timers run about once a minute. Nothing answers, because
    // this socket is dead, but a throttled tab cannot know that yet.
    for (let tick = 0; tick < 10; tick += 1) {
      jest.setSystemTime(Date.now() + 45_000);
      await advance(15_000);
    }
    expect(sockets).toHaveLength(1);
    expect(live.readyState).toBe(Socket.OPEN);
    // Back in the tab: a probe, and silence replaces the socket promptly.
    await event(() => { window.dispatchEvent(new Event("focus")); });
    await advance(5_300);
    expect(live.readyState).toBe(Socket.CLOSED);
    expect(sockets).toHaveLength(2);
  });

  test("a socket that answers the return probe is kept", async () => {
    await mount();
    await event(() => sockets[0].welcome());
    await event(() => { window.dispatchEvent(new Event("focus")); });
    await event(() => sockets[0].receive({ t: "pong" }));
    await advance(10_000);
    expect(sockets).toHaveLength(1);
    expect(sockets[0].readyState).toBe(Socket.OPEN);
  });

  test("hiding the tab is not a return", async () => {
    await mount();
    await event(() => sockets[0].drop());
    const before = sockets.length;
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    try {
      // Bubbles, as the browser's does, so it reaches the window listener.
      await event(() => { document.dispatchEvent(new Event("visibilitychange", { bubbles: true })); });
      expect(sockets).toHaveLength(before);
    } finally {
      delete (document as { visibilityState?: string }).visibilityState;
    }
  });

  test("returning while waiting out a backoff retries at once", async () => {
    await mount();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await event(() => sockets[sockets.length - 1].drop());
      await advance(20_000);
    }
    await event(() => sockets[sockets.length - 1].drop());
    const before = sockets.length;
    await event(() => { window.dispatchEvent(new Event("online")); });
    await advance(0);
    expect(sockets).toHaveLength(before + 1);
  });
});

describe("switching notes leaves nothing behind", () => {
  test("a hundred switches end with one open socket and only its own timers", async () => {
    // The hook's timers, counted at the source: React's scheduler keeps fake
    // timers of its own, so jest.getTimerCount() says nothing about this room.
    const pending = new Set<unknown>();
    const originals = { setTimeout: window.setTimeout, setInterval: window.setInterval,
      clearTimeout: window.clearTimeout, clearInterval: window.clearInterval };
    const track = (id: unknown) => { pending.add(id); return id; };
    const spies = [
      jest.spyOn(window, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
        const timer: number = originals.setTimeout.call(window, () => { pending.delete(timer); fn(); }, ms);
        return track(timer);
      }) as never),
      jest.spyOn(window, "setInterval").mockImplementation(((fn: () => void, ms?: number) =>
        track(originals.setInterval.call(window, fn, ms))) as never),
      jest.spyOn(window, "clearTimeout").mockImplementation(((id: number) => {
        pending.delete(id); originals.clearTimeout.call(window, id); }) as never),
      jest.spyOn(window, "clearInterval").mockImplementation(((id: number) => {
        pending.delete(id); originals.clearInterval.call(window, id); }) as never),
    ];
    try {
      await mount("notes/a.md");
      await event(() => sockets[0].welcome());
      for (let index = 0; index < 100; index += 1) {
        await mount(index % 2 === 0 ? "notes/b.md" : "notes/a.md");
        await event(() => sockets[sockets.length - 1].welcome());
      }
      expect(sockets).toHaveLength(101);
      expect(sockets.filter((socket) => socket.readyState !== Socket.CLOSED)).toHaveLength(1);
      // The open socket's heartbeat and renewal, and nothing from the other hundred.
      expect(pending.size).toBeLessThanOrEqual(2);
      expect(mockIssue).toHaveBeenCalledTimes(1);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
