import { useEffect, useState } from "react";
import { useConvex } from "convex/react";

/**
 * Whether the control plane's connection has dropped, which is what "online"
 * actually means to the console.
 *
 * The phone's NetInfo and a browser's `navigator.onLine` say whether there is
 * a network, not whether anything answers over it: on weak signal, a captive
 * portal or a dead uplink they say online, and every Convex action then hangs
 * (they have no client-side timeout) until the save gives up after 30 seconds
 * or a folder operation after 45. The boards Dev2 approved on 2026-11-09 named
 * this first ("Am I online? often wrong on weak signal").
 *
 * The Convex client knows better: its actions travel over its WebSocket, and
 * when that socket is down they are not sent at all. So a socket that has
 * been down for `STALL_MS` — after it had connected once, or after it has
 * failed to connect twice on a cold start with no signal — counts as offline,
 * and every offline road the console already has (the queue, the device's
 * copy) is taken instead of waiting. The moment the socket is back it is
 * online again, and the queue drains.
 *
 * Only a socket that is down counts. A request that is slow on a connected
 * socket is not a lost connection: a meaning search or an AI answer can
 * legitimately take longer than any threshold here.
 */
export const STALL_MS = 3_000;

export interface LinkState {
  isWebSocketConnected: boolean;
  hasEverConnected: boolean;
  connectionRetries: number;
}

/**
 * The rule, apart from React and timers: call `next` with each connection
 * state; `onChange` hears `true` once the socket has been down `STALL_MS`, and
 * `false` the moment it is back. Returns a function that stops the timer.
 */
export function stallTracker(
  onChange: (stalled: boolean) => void,
  schedule: (fn: () => void, ms: number) => unknown = setTimeout,
  cancel: (handle: unknown) => void = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
): { next: (state: LinkState) => void; stop: () => void } {
  let stalled = false;
  let timer: unknown = null;
  const clear = () => {
    if (timer !== null) cancel(timer);
    timer = null;
  };
  return {
    next: (state) => {
      const down = !state.isWebSocketConnected && (state.hasEverConnected || state.connectionRetries >= 2);
      if (!down) {
        clear();
        if (stalled) {
          stalled = false;
          onChange(false);
        }
        return;
      }
      if (stalled || timer !== null) return;
      timer = schedule(() => {
        timer = null;
        stalled = true;
        onChange(true);
      }, STALL_MS);
    },
    stop: clear,
  };
}

/** True while the control plane's socket has been down `STALL_MS` or longer. */
export function useServerStalled(): boolean {
  // Undefined outside a Convex provider (a screen rendered on its own): then nothing is known to be down.
  const convex = useConvex() as ReturnType<typeof useConvex> | undefined;
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    if (convex === undefined || typeof convex.subscribeToConnectionState !== "function") return;
    const tracker = stallTracker(setStalled);
    tracker.next(convex.connectionState());
    const unsubscribe = convex.subscribeToConnectionState((state) => tracker.next(state));
    return () => {
      unsubscribe();
      tracker.stop();
    };
  }, [convex]);
  return stalled;
}
