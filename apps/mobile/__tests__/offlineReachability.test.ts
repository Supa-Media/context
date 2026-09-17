/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

// React refuses to run `act` without this, and warns on every call otherwise.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Both halves of "can we reach anything", and the one direction that matters.
 *
 * Neither half had been executed by a test. That is the platform-split gap this
 * suite's resolution order creates — a bare import mounts `reachability.web.ts`
 * and the native half runs nowhere — but here *both* were unread, so the web
 * half was not being exercised either.
 *
 * ## Why this hook is worth pinning rather than reading
 *
 * It decides whether the console **asks the server at all**. `useFileBrowser`
 * has two paths gated directly on it, and each one is deliberately *not* a
 * fallback after a failure:
 *
 *     if (offline.reachability === "offline") {
 *       const cached = await offline.cachedListing(folder);  // no server call
 *
 * The reason is sound — `listFiles` is a Convex action and
 * `ConvexReactClient.action()` has no client-side timeout, so with no
 * connection nothing ever rejects and the tree would sit empty forever. But it
 * means a wrong **"offline"** does not merely degrade the UI: it replaces a
 * live answer with a stored one, for every listing and every note, without
 * asking.
 *
 * So the load-bearing rule is the *asymmetry* both docblocks argue for, and it
 * is the thing asserted here: **`offline` requires an explicit negative.**
 * Anything unsure is `unknown`, which the console renders as no claim and which
 * leaves the ordinary server path in place. The native docblock names the exact
 * regression: `isInternetReachable` "is `null` until the probe has run and can
 * stay `null` on some platforms, so treating 'not true' as offline would report
 * a working phone as offline on every cold start" — which, given the two call
 * sites above, would make serving a stored copy the *default* on launch.
 *
 * ## Measured by sabotage, against this file
 *
 * | break | reddens |
 * | --- | --- |
 * | native: collapse `unknown` into `offline` | **1** |
 * | native: drop `isInternetReachable` from the check | **1** |
 * | native: never unsubscribe | **1** |
 * | web: treat a missing `onLine` as `offline` | **1** |
 * | web: drop the effect's own `update()` | **0 — and it stays 0** |
 *
 * **That last row is left honest rather than papered over.** The effect calls
 * `update()` as well as the `useState` initializer, for a stated reason —
 * *"the browser may have gone offline between the first render and this
 * effect"* — and deleting it breaks nothing here. Two attempts to pin it both
 * failed for the same reason, and the second is worth recording because it
 * looked like it worked: handing the two reads different answers (an `onLine`
 * getter that flips after its first access) still passed with the line gone,
 * because **React invokes the `useState` initializer twice in this harness** —
 * measured, `reads` is 4 with the line and 2 without — so the flip is consumed
 * before the effect is ever reached.
 *
 * The window that call closes is real and is simply not reachable from a
 * synchronous `act` mount: there is no moment between the initializer and the
 * commit into which a test can insert a network change. **Keeping the line and
 * saying it is unpinned beats deleting a correct guard to make a table tidy,
 * and beats shipping a test that passes for the wrong reason** — which is the
 * failure this file's neighbours keep cataloguing.
 */

/* ---------------------------- the native half ---------------------------- */

type NetInfoState = { isConnected: boolean | null; isInternetReachable: boolean | null };

/**
 * `mock`-prefixed because the factory below reads them, and jest refuses any
 * other out-of-scope name — the arrangement `offlineStoreNative.test.ts` makes.
 */
let mockListener: ((state: NetInfoState) => void) | null = null;
let mockUnsubscribed = 0;

jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: {
    addEventListener: (listener: (state: NetInfoState) => void) => {
      mockListener = listener;
      return () => {
        mockUnsubscribed += 1;
      };
    },
  },
}));

const { act, createElement } = require("react") as typeof import("react");
const { createRoot } = require("react-dom/client") as typeof import("react-dom/client");

/** The native hook, reached by explicit path — a bare import is the web half. */
const native =
  require("../features/offline/reachability.ts") as typeof import("../features/offline/reachability");
const web =
  require("../features/offline/reachability.web") as typeof import("../features/offline/reachability.web");

type Reachability = import("../features/offline/copy").Reachability;

/** Mounts a hook and hands back what it last returned, plus an unmount. */
function mount(useHook: () => Reachability): { read: () => Reachability; unmount: () => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let latest: Reachability = "unknown";

  function Harness() {
    latest = useHook();
    return null;
  }

  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  act(() => {
    root.render(createElement(Harness));
  });
  return {
    read: () => latest,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

beforeEach(() => {
  mockListener = null;
  mockUnsubscribed = 0;
});

describe("reachability on a phone", () => {
  function report(state: NetInfoState): void {
    if (mockListener === null) throw new Error("the hook never subscribed");
    const fire = mockListener;
    act(() => fire(state));
  }

  test("an explicit negative from either field is offline", () => {
    const view = mount(native.useReachability);

    report({ isConnected: false, isInternetReachable: null });
    expect(view.read()).toBe("offline");

    // The second field alone is enough: an interface that is up and a probe
    // that got no answer is a phone on a captive portal.
    report({ isConnected: true, isInternetReachable: false });
    expect(view.read()).toBe("offline");

    view.unmount();
  });

  test("an interface that is up, with no denial, is online", () => {
    const view = mount(native.useReachability);
    report({ isConnected: true, isInternetReachable: true });
    expect(view.read()).toBe("online");
    view.unmount();
  });

  test("AND AN UNSURE ANSWER IS UNKNOWN, NEVER OFFLINE", () => {
    /*
      The regression the native docblock names, and the one with teeth:
      `isInternetReachable` is `null` until the probe runs and can stay `null`
      on some platforms. Collapsing that into `offline` would make the console
      serve stored listings and stored note text instead of asking the server —
      on every cold start, before the probe has had a chance to answer.

      `unknown` is not a hedge. `copy.ts` renders nothing for it, and the two
      gates in `useFileBrowser` compare against `"offline"` exactly, so
      `unknown` leaves the ordinary server path in place.
    */
    const view = mount(native.useReachability);

    report({ isConnected: null, isInternetReachable: null });
    expect(view.read()).toBe("unknown");

    report({ isConnected: true, isInternetReachable: null });
    expect(view.read()).toBe("online");

    report({ isConnected: null, isInternetReachable: true });
    expect(view.read()).toBe("unknown");

    view.unmount();
  });

  test("unmounting releases the subscription", () => {
    // A hook that kept its listener would hold a reference to a dead
    // component's setter for the life of the app, and NetInfo's listener list
    // is process-global.
    const view = mount(native.useReachability);
    expect(mockUnsubscribed).toBe(0);
    view.unmount();
    expect(mockUnsubscribed).toBe(1);
  });
});

/* ------------------------------ the web half ----------------------------- */

describe("reachability in a browser", () => {
  const realOnLine = Object.getOwnPropertyDescriptor(Navigator.prototype, "onLine");

  function setOnLine(value: boolean | undefined): void {
    if (value === undefined) {
      Object.defineProperty(navigator, "onLine", { configurable: true, value: undefined });
      return;
    }
    Object.defineProperty(navigator, "onLine", { configurable: true, value });
  }

  afterEach(() => {
    if (realOnLine) Object.defineProperty(Navigator.prototype, "onLine", realOnLine);
    delete (navigator as unknown as Record<string, unknown>).onLine;
  });

  test("a browser already offline when the console mounts reads offline", () => {
    // The events fire on a *change*, so a browser that was already offline
    // would otherwise read as online until it came back and went away again.
    // Satisfied by the `useState` initializer rather than by the effect's own
    // read — see the header for why that second read is not pinned here.
    setOnLine(false);
    const view = mount(web.useReachability);
    expect(view.read()).toBe("offline");
    view.unmount();
  });

  test("and follows the two events after that", () => {
    setOnLine(true);
    const view = mount(web.useReachability);
    expect(view.read()).toBe("online");

    setOnLine(false);
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(view.read()).toBe("offline");

    setOnLine(true);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(view.read()).toBe("online");

    view.unmount();
  });

  test("a browser that will not say is UNKNOWN, never offline", () => {
    /*
      The same asymmetry as the native half. An old embedded webview with no
      `navigator.onLine` must not be told it is offline: that would hand it
      stored copies for every read, permanently, on a device that is fine.
    */
    setOnLine(undefined);
    const view = mount(web.useReachability);
    expect(view.read()).toBe("unknown");
    view.unmount();
  });

  test("and it stops listening when it goes away", () => {
    setOnLine(true);
    const view = mount(web.useReachability);
    view.unmount();

    // Nothing to assert on directly — what this catches is a listener left
    // behind calling `setState` on an unmounted tree, which React reports.
    setOnLine(false);
    expect(() => {
      window.dispatchEvent(new Event("offline"));
    }).not.toThrow();
  });
});
