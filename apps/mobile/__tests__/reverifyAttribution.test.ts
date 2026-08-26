/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";

// React refuses to run `act` without this, and warns on every call otherwise.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { StrictMode, act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { useReverify } from "../features/console/storage/useReverify";
import type { ObservedBinding, ReverifyState } from "../features/console/storage/reverify";

/**
 * A probe's answer belongs to the context it ran against.
 *
 * `createReverifyController` settles by watching the bucket row's `updatedAt`
 * move past a baseline captured when the probe started. Two workspaces have
 * completely unrelated `updatedAt` values, so a controller that survives a
 * context switch reads the *next* context's row as the answer to the *previous*
 * context's probe — and says "your bucket is reachable and writable" about a
 * bucket nothing ever checked.
 *
 * On a product whose whole promise is that the customer owns the storage, a
 * fabricated green is the worst sentence this pane could produce. Hence the
 * `subject` argument, and hence this file.
 */

const A: ObservedBinding = { status: "connected", updatedAt: 1000, lastVerifiedAt: 1000 };
/** A different workspace, whose row is simply further along in time. */
const B: ObservedBinding = { status: "connected", updatedAt: 9000, lastVerifiedAt: 9000 };

interface Harness {
  state: () => ReverifyState;
  start: () => void;
  /** Re-render the pane as if the console had switched to another context. */
  switchTo: (binding: ObservedBinding, subject: string) => void;
  unmount: () => void;
  probed: string[];
}

function mountPane(
  initial: { binding: ObservedBinding; subject: string },
  options: { strict?: boolean } = {},
): Harness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const probed: string[] = [];

  let latest: ReturnType<typeof useReverify> | null = null;
  let setProps: ((next: { binding: ObservedBinding; subject: string }) => void) | null = null;

  function Pane() {
    const [props, set] = useState(initial);
    setProps = set;
    // Rebuilt every render, exactly as `useLiveConsoleData` rebuilds
    // `storageActions` — and closing over the *current* workspace, which is
    // what makes a stale controller dangerous rather than merely wasteful.
    const run = async () => {
      probed.push(props.subject);
      return { queued: true, status: "verifying" };
    };
    latest = useReverify(props.binding, run, props.subject);
    return null;
  }

  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  act(() => {
    root.render(
      options.strict ? createElement(StrictMode, null, createElement(Pane)) : createElement(Pane),
    );
  });

  return {
    state: () => latest!.state,
    start: () => act(() => latest!.start!()),
    switchTo: (binding, subject) => act(() => setProps!({ binding, subject })),
    unmount: () => act(() => root.unmount()),
    probed,
  };
}

describe("a re-verify result never crosses contexts", () => {
  test("switching context mid-probe does not report the new bucket as checked", () => {
    const pane = mountPane({ binding: A, subject: "ws_a" });
    pane.start();
    expect(pane.state().kind).toBe("running");

    // The console moves to another context the owner also owns. Its row is
    // healthy and its `updatedAt` is far past `@a`'s baseline — which is
    // exactly what the old controller mistook for "the probe came back".
    pane.switchTo(B, "ws_b");

    expect(pane.state()).toEqual({ kind: "idle" });
    // And only the context the button was pressed on was ever probed.
    expect(pane.probed).toEqual(["ws_a"]);
    pane.unmount();
  });

  test("a probe still settles normally when the context does not change", () => {
    // The guard above must not have cost the feature its actual job.
    const pane = mountPane({ binding: A, subject: "ws_a" });
    pane.start();
    expect(pane.state().kind).toBe("running");

    pane.switchTo({ status: "connected", updatedAt: 2000, lastVerifiedAt: 2000 }, "ws_a");

    expect(pane.state().kind).toBe("ok");
    expect(pane.probed).toEqual(["ws_a"]);
    pane.unmount();
  });

  test("an outcome from one context is not left on screen over another", () => {
    const pane = mountPane({ binding: A, subject: "ws_a" });
    pane.start();
    pane.switchTo({ status: "connected", updatedAt: 2000, lastVerifiedAt: 2000 }, "ws_a");
    expect(pane.state().kind).toBe("ok");

    // `failed` never auto-expires and `ok` only after eight seconds, so without
    // a reset the previous context's banner simply stays put.
    pane.switchTo(B, "ws_b");
    expect(pane.state()).toEqual({ kind: "idle" });
    pane.unmount();
  });
});

describe("the controller survives a cleanup-then-setup cycle", () => {
  test("re-verify still queues a probe under StrictMode", () => {
    // `dispose()` is a one-way latch: a disposed controller silently queues
    // nothing. `<StrictMode>` runs setup, then cleanup, then setup again on a
    // *living* tree — no remount, no extra render — so a controller captured in
    // a `const` at render time is dead by the time anyone presses the button,
    // and nothing anywhere reports it. Fast Refresh and React 19's `<Activity>`
    // prerendering take the same path.
    //
    // A fresh `mountPane()` does NOT test this: a new mount builds a new ref
    // and passes whether or not the latch is handled. That version of this test
    // was written first, and stayed green with the fix reverted.
    const pane = mountPane({ binding: A, subject: "ws_a" }, { strict: true });

    pane.start();
    expect(pane.state().kind).toBe("running");
    expect(pane.probed).toEqual(["ws_a"]);
    pane.unmount();
  });
});
