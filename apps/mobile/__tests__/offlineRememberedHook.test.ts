/**
 * @jest-environment jsdom
 */

/**
 * WHEN A MEMORY MAY STAND IN FOR AN ANSWER, AND WHEN IT MAY NOT.
 *
 * `useRememberedContexts` is the hook that lets a cold start with no network
 * draw the console. The storage half of it is proved in
 * `offlineRemembered.test.ts`; this is the half where it decides *whether to
 * answer at all*, and every one of those decisions is a way the feature could
 * be wrong in production:
 *
 *  - Answering while the live list is still in flight puts a stale rail on
 *    screen for the half-second before the real one lands — the flicker
 *    `landingStep` exists to prevent, reintroduced by a cache.
 *  - Answering online at all substitutes a memory for a round trip that was
 *    going to complete.
 *  - Answering after a sign-out draws one person's contexts on a device that
 *    belongs to whoever signs in next. Nothing else gates the boot: the
 *    *presence* of a remembered row is what `resolveProtectedRoute` treats as
 *    evidence of a session.
 *
 * It runs in jsdom against the **real** web store and the **real** web
 * reachability hook — `localStorage` and `navigator.onLine` — because
 * `jest.config.js` resolves `.web.ts` first. Mocking either would have tested
 * the arrangement of this file rather than the behaviour of the feature.
 *
 * **Sabotage record** (temporary local edits, reverted):
 *
 *  - Dropping `if (reachability !== "offline") return undefined;` — 1 failure,
 *    "online, it waits for the answer it can still get".
 *  - Returning `recalled` before `live` — 1 failure, "the server always wins".
 *  - Removing the `recalled.length === 0` guard — 1 failure, "a device that
 *    remembers nothing offers nothing".
 */

import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { rememberContexts, type RememberedContext } from "../features/offline/cache";
import { openStore } from "../features/offline/store";
import { useRememberedContexts } from "../features/offline/useRememberedContexts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WS = "ws_one";

function row(overrides: Partial<RememberedContext> = {}): RememberedContext {
  return {
    workspaceId: WS,
    slug: "acme",
    displayName: "Acme",
    kind: "shared",
    role: "owner",
    ...overrides,
  };
}

/**
 * Put the browser offline or online, the way the real hook hears about it.
 *
 * Inside `act` because a mounted `useReachability` sets state from the event
 * listener, and a state update outside `act` is a warning in the suite's output
 * — the kind of noise that gets skimmed past on the day it means something.
 */
async function setOnline(online: boolean): Promise<void> {
  await act(async () => {
    Object.defineProperty(window.navigator, "onLine", { value: online, configurable: true });
    window.dispatchEvent(new Event(online ? "online" : "offline"));
  });
}

let container: HTMLDivElement;
let root: Root;

/** Mount the hook and report what it answered on the latest render. */
async function mount(live: readonly RememberedContext[] | undefined) {
  const seen: (readonly RememberedContext[] | undefined)[] = [];
  function Probe(): ReactElement | null {
    seen.push(useRememberedContexts(live));
    return null;
  }
  await act(async () => {
    root.render(createElement(Probe));
  });
  // One more flush: the store read resolves a microtask after the first paint,
  // which is exactly the render a cold launch is deciding on.
  await act(async () => {});
  return () => seen[seen.length - 1];
}

beforeEach(() => {
  window.localStorage.clear();
  // Directly, not through `setOnline`: nothing is mounted yet, so there is no
  // listener to fire at and no state for `act` to be about.
  Object.defineProperty(window.navigator, "onLine", { value: true, configurable: true });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("the three conditions", () => {
  test("offline, with nothing landed, it answers what this device remembers", async () => {
    await rememberContexts(openStore(), [row()], Date.now());
    await setOnline(false);

    const latest = await mount(undefined);

    expect(latest()).toEqual([row()]);
  });

  test("online, it waits for the answer it can still get", async () => {
    await rememberContexts(openStore(), [row()], Date.now());

    const latest = await mount(undefined);

    expect(latest()).toBeUndefined();
  });

  /**
   * The rule with no exception. A rename, a context joined, a membership that
   * ended — the server's list is a fact and this one is a memory, and there is
   * no merging of the two and no preferring the fresher.
   *
   * **The remembered context is a different one, and that is not decoration.**
   * Written as the same context under two names, this test passed even with the
   * precedence deliberately inverted: the hook's own write of the live list
   * reaches `localStorage` before its read of the remembered one finishes — one
   * `set` against a `keys()` and a `get()` per key — so the memory it read back
   * was the answer it had just written down, and both sides agreed on the wrong
   * thing. A row the live list does not contain cannot converge that way.
   */
  test("the server always wins, even offline", async () => {
    await rememberContexts(openStore(), [row({ workspaceId: "ws_gone", slug: "gone" })], Date.now());
    await setOnline(false);

    const latest = await mount([row()]);

    expect(latest()).toEqual([row()]);
  });

  /**
   * Which is what makes the boot gate safe: sign-out clears this namespace, so
   * a signed-out device remembers nothing, offers nothing, and
   * `resolveProtectedRoute` goes on waiting exactly as it did before.
   */
  test("a device that remembers nothing offers nothing", async () => {
    await setOnline(false);

    const latest = await mount(undefined);

    expect(latest()).toBeUndefined();
  });
});

describe("the write side", () => {
  test("a landed list is written down for the next cold start", async () => {
    await mount([row({ meetingsFolder: "3-resources/meetings" })]);

    await setOnline(false);
    const latest = await mount(undefined);

    expect(latest()).toEqual([row({ meetingsFolder: "3-resources/meetings" })]);
  });

  /**
   * An empty list is not a list of no contexts — it is very often the shape a
   * failed or skipped subscription takes on its way past `usable()`. Writing it
   * down would blank a device's memory at the one moment it is earning its
   * keep, so the write is refused and the previous memory stands.
   */
  test("an empty live list never overwrites what is remembered", async () => {
    await rememberContexts(openStore(), [row()], Date.now());

    await mount([]);

    await setOnline(false);
    const latest = await mount(undefined);

    expect(latest()).toEqual([row()]);
  });
});
