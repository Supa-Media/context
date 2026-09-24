/** @jest-environment jsdom */

/**
 * A phone has a `window` with no events on it, and opening a note must survive
 * that.
 *
 * React Native defines `window` as the global object, so a
 * `typeof window !== "undefined"` guard passes on a phone while
 * `window.addEventListener` is `undefined`. The note room's effects called it
 * anyway, and tapping any note on the phone threw "undefined is not a
 * function" into the error boundary. jsdom always has a real `window`, which is
 * why no test here saw it: this file takes the listener methods away to make
 * the window the shape a phone's is, and mounts the real hooks against it.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { AppState, type AppStateStatus } from "react-native";
import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { createSharedDoc } from "../features/console/presence/sharedDoc";

const mockMint = jest.fn(async () => ({
  accessToken: "grant-token",
  expiresAt: Date.now() + 60 * 60 * 1000,
}));

jest.mock("../features/agent/useConsoleGrant", () => ({
  useConsoleGrant: () => mockMint,
}));

import { onReturnToApp } from "../features/app/returnToApp";
import { useNoteRoom } from "../features/console/presence/useNoteRoom";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Make `window` look the way React Native's does: present, with no listener methods. */
function nativeShapedWindow(): () => void {
  for (const name of ["addEventListener", "removeEventListener"] as const) {
    Object.defineProperty(window, name, { value: undefined, configurable: true, writable: true });
  }
  return () => {
    // The own properties shadow `EventTarget.prototype`; removing them puts it back.
    delete (window as { addEventListener?: unknown }).addEventListener;
    delete (window as { removeEventListener?: unknown }).removeEventListener;
  };
}

/** Capture what `AppState` is asked to call, since there is no phone to background. */
function captureAppState(): { handlers: ((state: AppStateStatus) => void)[]; removed: () => number } {
  const handlers: ((state: AppStateStatus) => void)[] = [];
  let removed = 0;
  jest.spyOn(AppState, "addEventListener").mockImplementation((_type, handler) => {
    handlers.push(handler as (state: AppStateStatus) => void);
    return { remove: () => { removed += 1; } } as ReturnType<typeof AppState.addEventListener>;
  });
  return { handlers, removed: () => removed };
}

afterEach(() => {
  jest.restoreAllMocks();
  mockMint.mockClear();
});

describe("onReturnToApp", () => {
  test("in a browser, listens on the window and stops when asked", () => {
    const callback = jest.fn();
    const stop = onReturnToApp(callback);
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
    expect(callback).toHaveBeenCalledTimes(2);
    stop();
    window.dispatchEvent(new Event("focus"));
    expect(callback).toHaveBeenCalledTimes(2);
  });

  test("listens only for the events it is given", () => {
    const callback = jest.fn();
    const stop = onReturnToApp(callback, ["focus"]);
    window.dispatchEvent(new Event("online"));
    expect(callback).not.toHaveBeenCalled();
    stop();
  });

  test("on a phone's window, does not throw and follows the app coming back instead", () => {
    const restore = nativeShapedWindow();
    const appState = captureAppState();
    try {
      const callback = jest.fn();
      let stop: () => void = () => {};
      expect(() => { stop = onReturnToApp(callback); }).not.toThrow();
      expect(appState.handlers).toHaveLength(1);
      appState.handlers[0]("background");
      expect(callback).not.toHaveBeenCalled();
      appState.handlers[0]("active");
      expect(callback).toHaveBeenCalledTimes(1);
      stop();
      expect(appState.removed()).toBe(1);
    } finally {
      restore();
    }
  });
});

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    sockets.push(this);
  }

  send(): void {}

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  receive(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

let sockets: FakeWebSocket[] = [];

describe("opening a note on a phone", () => {
  test("mounts and unmounts the note room without touching window listeners", async () => {
    const shared = createSharedDoc({});
    shared.doc.transact(() => shared.text.insert(0, "hello"), "server");
    const snapshot = { documentId: "doc-phone", update: shared.snapshot(), text: "hello", etag: "doc-phone-etag" };
    shared.destroy();

    const oldFetch = globalThis.fetch;
    const oldWebSocket = globalThis.WebSocket;
    globalThis.fetch = (async () => ({ ok: true, json: async () => snapshot }) as Response) as typeof fetch;
    (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket = FakeWebSocket;
    sockets = [];

    const container = document.createElement("div");
    const failures: unknown[] = [];
    const root = createRoot(container, { onUncaughtError: (error) => failures.push(error) });
    const restore = nativeShapedWindow();
    captureAppState();

    function Probe() {
      useNoteRoom({
        workspaceId: "workspace",
        endpoint: "https://gateway.example/mcp",
        notePath: "notes/on-a-phone.md",
        conflicted: false,
        textForSeed: () => "hello",
        onExternalWrite: () => {},
        onSaved: () => () => {},
        durable: true,
        canEdit: true,
        scope: "private",
      });
      return null;
    }

    try {
      await act(async () => root.render(createElement(Probe)));
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        });
      }
      // The room really opened: the effect that used to throw ran past the
      // point it threw at.
      expect(sockets.length).toBeGreaterThan(0);
      // And went live, which is when the note room starts listening for the
      // way back to the app as well.
      const socket = sockets[sockets.length - 1];
      await act(async () => {
        socket.open();
        socket.receive({
          t: "welcome",
          v: 2,
          you: "self",
          members: [],
          reconnectAfterMs: 300_000,
          heartbeatMs: 15_000,
          seed: false,
        });
      });
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
      await act(async () => root.unmount());
      expect(failures).toEqual([]);
    } finally {
      restore();
      globalThis.fetch = oldFetch;
      (globalThis as unknown as { WebSocket: typeof oldWebSocket }).WebSocket = oldWebSocket;
    }
  });
});

/**
 * And nothing new calls them raw.
 *
 * The three hooks above were each written with a `typeof window` guard or none,
 * each correct in a browser, and together they took notes down on every phone.
 * So a new `window.addEventListener` in code a phone runs fails here until it
 * goes through `onReturnToApp` or is listed below with why a phone never runs
 * it.
 */
const RAW_WINDOW_LISTENERS_ALLOWED: Record<string, string> = {
  "features/app/returnToApp.ts": "the one place that checks, by construction",
  "features/console/agents/useAgentActivity.ts": "checks `typeof window.addEventListener` itself before listening",
  "features/console/files/imageBlock/widget.ts": "a CodeMirror widget, bundled into the editor's WebView and never into the app",
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "webview" || entry.name === "__tests__" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.web\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

test("code a phone runs never calls window listener methods without checking they exist", () => {
  const appRoot = join(__dirname, "..");
  const offenders = [join(appRoot, "features"), join(appRoot, "app")]
    .flatMap(sourceFiles)
    .map((path) => relative(appRoot, path))
    .filter((path) => /\bwindow\.(add|remove)EventListener\(/.test(readFileSync(join(appRoot, path), "utf8")))
    .filter((path) => !(path in RAW_WINDOW_LISTENERS_ALLOWED));
  expect(offenders).toEqual([]);
});
