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
