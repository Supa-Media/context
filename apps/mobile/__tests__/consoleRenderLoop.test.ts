/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import { act, createElement, useEffect, useRef, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider } from "convex/react";
import type { Id } from "@context/convex/_generated/dataModel";
import { useIngestionSettings } from "../features/console/ingestion/useIngestionSettings";
import { useReverify } from "../features/console/storage/useReverify";

// React only treats `act` as authoritative when this is set, and warns loudly on
// every call when it is not. Setting it keeps the suite's output readable and
// makes an update outside `act` a signal rather than background noise.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The blank-white-page guard.
 *
 * A brand-new account signed in, landed on `/console`, and got a white page and
 * *"Minified React error #301 — too many re-renders"*. Nothing rendered at all,
 * so the console's own `contexts.length === 0` empty state never got a chance —
 * which is why the empty state looked broken when it was not.
 *
 * Two distinct loops caused it, and both are identity bugs:
 *
 *  1. **Render-phase.** `useQueries` requires a referentially stable spec.
 *     Convex's `useSubscription` compares the spec to the one in state and
 *     calls `setState` *during render* when it differs. The generated `api` is
 *     `anyApi`, a proxy that mints a new object on **every property access**,
 *     so an `api.…` reference in a `useMemo` dependency array recomputes the
 *     spec every render — and React gives up after ~25.
 *  2. **Effect-phase.** `useReverify` built its controller from `run`, which
 *     the caller rebuilds as a fresh closure every render, so the effect re-ran
 *     every render and set a **new** `{ kind: "idle" }` — never `Object.is`
 *     equal, so React could not bail out.
 *
 * ## Why this file needs jsdom and `consoleQueryStability.test.ts` does not
 *
 * The first harness written for this used `renderToStaticMarkup`, on the
 * reasoning that the render phase is where the bug lives. **It could not fail.**
 * React's SSR renderer ignores a render-phase `setState` outright — a probe
 * that loops forever in a browser renders exactly once under SSR and throws
 * nothing. Sabotaging the fix left that suite green, which is the whole reason
 * this file exists and runs a real reconciler instead. Effects do not run under
 * SSR either, so loop 2 was equally invisible.
 *
 * Both tests below have been verified to fail with the fix reverted.
 */

/** The smallest client `useQueries` accepts: it is only ever asked to watch. */
function fakeConvexClient() {
  const watch = {
    localQueryResult: () => undefined,
    onUpdate: () => () => {},
    journal: () => undefined,
  };
  return {
    watchQuery: () => watch,
    watchPaginatedQuery: () => watch,
    mutation: async () => undefined,
    action: async () => undefined,
    connectionState: () => ({ isWebSocketConnected: false }),
  } as never;
}

/**
 * Mount a hook and report how many times it rendered.
 *
 * A loop does not always announce itself: React throws "Too many re-renders"
 * for a render-phase loop, but an *effect* loop just spins until the test times
 * out. So the probe counts, and the assertion is on the count — an honest
 * render is a handful, never dozens — with a hard stop so a real loop fails
 * fast instead of hanging the suite.
 */
const RUNAWAY = 30;

function mount(useHook: () => unknown): { renders: number; error: Error | null } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let renders = 0;
  let error: Error | null = null;

  function Probe() {
    renders++;
    if (renders > RUNAWAY) throw new Error(`runaway render: ${renders} renders`);
    useHook();
    // A loop driven by an effect never reaches React's re-render limit, so the
    // probe has to notice it here too.
    const seen = useRef(0);
    useEffect(() => {
      seen.current++;
      if (seen.current > RUNAWAY) throw new Error(`runaway effect: ${seen.current} runs`);
    });
    return null;
  }

  const root = createRoot(container, {
    // Keep React's own error logging out of the test output; the throw is the
    // signal we act on.
    onUncaughtError: () => {},
    onCaughtError: () => {},
  });

  try {
    act(() => {
      root.render(createElement(ConvexProvider, { client: fakeConvexClient() }, createElement(Probe)));
    });
  } catch (thrown) {
    error = thrown as Error;
  }

  try {
    act(() => root.unmount());
  } catch {
    // A root that already failed cannot always be unmounted cleanly.
  }
  container.remove();
  return { renders, error };
}

describe("the console mounts without looping", () => {
  test("ingestion settings, for a context", () => {
    const { renders, error } = mount(() =>
      useIngestionSettings({
        workspaceId: "ws_1" as Id<"workspaces">,
        availability: "available",
        canEdit: true,
      }),
    );
    expect(error).toBeNull();
    expect(renders).toBeLessThan(RUNAWAY);
  });

  test("ingestion settings, for a brand-new account with no contexts", () => {
    // The empty spec has to be stable too, or the very first page a new user
    // sees is the blank one.
    const { renders, error } = mount(() =>
      useIngestionSettings({ workspaceId: null, availability: "available", canEdit: false }),
    );
    expect(error).toBeNull();
    expect(renders).toBeLessThan(RUNAWAY);
  });

  test("re-verify, when the caller rebuilds `run` on every render", () => {
    // Exactly what `useLiveConsoleData` does: `storageActions` is an object
    // literal, so `run` is a new function every time. That must not be enough
    // to restart the controller.
    const { renders, error } = mount(() =>
      useReverify(
        { status: "connected", updatedAt: 1 },
        async () => ({ queued: true, status: "verifying" }),
        "ws_1",
      ),
    );
    expect(error).toBeNull();
    expect(renders).toBeLessThan(RUNAWAY);
  });

  test("re-verify, with no owner controls to run", () => {
    const { renders, error } = mount(() => useReverify(null, null, null));
    expect(error).toBeNull();
    expect(renders).toBeLessThan(RUNAWAY);
  });
});
