/**
 * @jest-environment jsdom
 */

/**
 * A DROPPED CONTROL-PLANE SOCKET IS OFFLINE.
 *
 * Boards approved 2026-11-09 ("Am I online? often wrong on weak signal"): the
 * network can say online while nothing answers, and every Convex action then
 * hangs. The Convex client's own socket is the honest signal: down for
 * `STALL_MS`, the console takes its offline roads instead of waiting.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   a socket that never connected counts at once (no retry rule)        1
 *   no wait: down is offline the moment it drops                        2
 *   coming back does not clear it                                      2
 *   useReachability ignores the stall                                  1
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider } from "convex/react";
import { STALL_MS, stallTracker, type LinkState } from "../features/offline/serverLink";
import { useReachability } from "../features/offline/reachability.web";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const up: LinkState = { isWebSocketConnected: true, hasEverConnected: true, connectionRetries: 0 };
const dropped: LinkState = { isWebSocketConnected: false, hasEverConnected: true, connectionRetries: 1 };

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe("the stall rule", () => {
  test("a dropped socket is offline only after it stays down", () => {
    const heard: boolean[] = [];
    const tracker = stallTracker((stalled) => heard.push(stalled));
    tracker.next(up);
    tracker.next(dropped);
    jest.advanceTimersByTime(STALL_MS - 1);
    expect(heard).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(heard).toEqual([true]);
    tracker.next(up);
    expect(heard).toEqual([true, false]);
  });

  test("a blip shorter than the wait is never offline", () => {
    const heard: boolean[] = [];
    const tracker = stallTracker((stalled) => heard.push(stalled));
    tracker.next(dropped);
    jest.advanceTimersByTime(STALL_MS / 2);
    tracker.next(up);
    jest.advanceTimersByTime(STALL_MS * 2);
    expect(heard).toEqual([]);
  });

  test("a cold start is not offline while the first connection is still being made", () => {
    const heard: boolean[] = [];
    const tracker = stallTracker((stalled) => heard.push(stalled));
    tracker.next({ isWebSocketConnected: false, hasEverConnected: false, connectionRetries: 0 });
    jest.advanceTimersByTime(STALL_MS * 3);
    expect(heard).toEqual([]);
    // Two failed attempts on a cold start with no signal: that is offline.
    tracker.next({ isWebSocketConnected: false, hasEverConnected: false, connectionRetries: 2 });
    jest.advanceTimersByTime(STALL_MS);
    expect(heard).toEqual([true]);
  });
});

describe("the console's reachability hears it", () => {
  test("a browser that says online is offline once the socket has been down", () => {
    let push: (state: LinkState) => void = () => {};
    const client = {
      connectionState: () => up,
      subscribeToConnectionState: (cb: (state: LinkState) => void) => {
        push = cb;
        return () => {};
      },
    };
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    let latest = "";
    function Harness() {
      latest = useReachability();
      return null;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => {
      root.render(createElement(ConvexProvider, { client: client as never }, createElement(Harness)));
    });
    expect(latest).toBe("online");
    act(() => push(dropped));
    act(() => {
      jest.advanceTimersByTime(STALL_MS);
    });
    expect(latest).toBe("offline");
    act(() => push(up));
    expect(latest).toBe("online");
    act(() => root.unmount());
    delete (navigator as unknown as Record<string, unknown>).onLine;
  });
});
