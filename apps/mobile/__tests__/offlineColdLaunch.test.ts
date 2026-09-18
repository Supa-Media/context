/**
 * @jest-environment jsdom
 */

/**
 * THE WALK A PERSON TAKES, WITH NO NETWORK, FROM THE ICON TO A NOTE.
 *
 * Three changes built the offline story — the remembered context list (#687),
 * the queue that drains every context (#688), the service worker that lets a
 * browser tab open at all (#689) — and it was reported as working. It was not.
 * A phone relaunched with no network showed a blank screen, because **every
 * native launch lands on `/`** and `resolveRootRoute` answered `wait` there for
 * as long as `isLoading` was true, which offline is for ever. #691 fixed it.
 *
 * The bug is less interesting than why nothing caught it. Every test of that
 * work drove one gate directly — `resolveProtectedRoute(loading, null, true)`,
 * a hook with its arguments handed to it — and each of those gates was
 * genuinely correct. Nothing walked the path: `/` → `/console` →
 * `/console/@slug` → a note on the screen. So the one gate that had not been
 * taught the trick was in front of all of them, and every suite was green.
 *
 * `authRedirect.test.ts` now covers `resolveRootRoute`'s new argument, which is
 * the unit. **This file is the walk**, and it is deliberately end-to-end in the
 * only sense that matters here: it renders the real screen, drives the real
 * hook against a Convex client that never answers — which is exactly what
 * offline is — and asserts on what comes out the other end rather than on what
 * was passed in.
 *
 * ## Why a client that never answers is the honest fake
 *
 * `ConvexReactClient.action()` has no client-side timeout and a subscription
 * with no socket never settles, so offline is not "a query that rejects" — it
 * is `undefined`, permanently. A fake that resolved to `null` or threw would
 * exercise a path the network never takes, and would have passed against the
 * broken code.
 *
 * **Sabotage record** (temporary local edits against `main`, reverted):
 *
 *  - Reverting `resolveRootRoute`'s `rememberedSession` argument to a bare
 *    `wait` — the #691 bug, restored — 1 failure, "a phone that remembers a
 *    session is let in". That is the failure that should have existed before
 *    #691 and did not.
 *  - Reverting `resolveProtectedRoute`'s (#687) — **0 failures here**, and 1 in
 *    `authRedirect.test.ts`. Recorded rather than hidden, because it is the
 *    honest bound on this file: the walk stops at what `/console` *resolves
 *    to*, and the gate between that resolution and a rendered pane is owned by
 *    the unit test. A walk is not a replacement for the tests under it, and a
 *    file that claimed to cover a gate it does not reach would be the same
 *    kind of false green this one exists to have caught.
 *  - Making `useRememberedContexts` answer `undefined` offline — 4 failures,
 *    across both halves of the walk.
 */

import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The device says it is offline, for every test in this file.
 *
 * Set before the imports below are evaluated, because `useReachability` reads
 * `navigator.onLine` for its initial state and a hook that started "online"
 * would take a render to correct itself — the render this file is about.
 */
Object.defineProperty(window.navigator, "onLine", { value: false, configurable: true });

/** Mutable so one test can put the session in a different state. */
const mockAuth = { isLoading: true, isAuthenticated: false };

jest.mock("convex/react", () => ({
  ...(jest.requireActual("convex/react") as object),
  useConvexAuth: () => mockAuth,
}));

/** A phone, not a browser: `/` is the console's front door rather than the landing page. */
jest.mock("react-native", () => ({
  ...(jest.requireActual("react-native") as object),
  Platform: { OS: "ios", select: (choices: Record<string, unknown>) => choices.ios ?? choices.default },
}));

/**
 * Rendered as text, so a redirect is something this file can read.
 *
 * Replaced wholesale rather than spread over `requireActual`: the real module
 * pulls in the whole navigator, which Jest does not transform, and this walk
 * only ever needs to know *where a screen decided to send somebody*. `require`
 * inside the factory because Jest forbids a mock from closing over anything
 * outside its own scope.
 */
jest.mock("expo-router", () => ({
  Redirect: ({ href }: { href: string }) =>
    (require("react") as typeof import("react")).createElement("i", null, `-> ${href}`),
}));

import { ConvexProvider } from "convex/react";
import { RootScreen } from "../features/landing/RootScreen";
import { useLiveConsoleData } from "../features/console/useLiveConsoleData";
import { landingStep } from "../features/console/lastPlace";
import * as cache from "../features/offline/cache";
import { openStore } from "../features/offline/store.web";
import type { ConsoleData } from "../features/console/types";
import type { FolderListing, OpenNote } from "../features/console/files/types";

const WORKSPACE = {
  workspaceId: "w1",
  slug: "seyi",
  displayName: "seyi",
  kind: "personal",
  role: "owner",
};

/**
 * Offline: every subscription is outstanding, for ever.
 *
 * Not a rejection and not `null` — see the header. `isWebSocketConnected` is
 * `false` for the same reason, because that is what the console would be told.
 */
function offlineClient() {
  const watch = () => ({
    localQueryResult: () => undefined,
    onUpdate: () => () => {},
    journal: () => undefined,
  });
  return {
    watchQuery: watch,
    watchPaginatedQuery: watch,
    mutation: () => new Promise(() => {}),
    action: () => new Promise(() => {}),
    connectionState: () => ({ isWebSocketConnected: false }),
  } as never;
}

/** Everything a device holds after one successful online visit. */
async function seedLastGoodVisit(): Promise<void> {
  const store = openStore();
  const now = Date.now();
  await cache.rememberContexts(store, [WORKSPACE], now);
  await cache.putNote(
    store,
    "private",
    "w1",
    { path: "1-projects/a.md", text: "read on the train", etag: "e1" } as OpenNote,
    now,
  );
  await cache.putListing(
    store,
    "private",
    "w1",
    {
      path: "",
      folderDefault: "private",
      entries: [{ path: "1-projects/a.md", name: "a.md", kind: "note" }],
      truncated: false,
      manifestUsable: true,
    } as unknown as FolderListing,
    now,
  );
}

/** Render something, settle the store reads behind it, and hand back the text. */
async function paint(element: ReactElement): Promise<string> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  await act(async () => {
    root.render(element);
  });
  // Twice: the remembered list resolves a microtask after the first paint, and
  // a cold launch is decided on the render after that.
  await act(async () => {});
  await act(async () => {});
  return container.textContent ?? "";
}

beforeEach(() => {
  window.localStorage.clear();
  mockAuth.isLoading = true;
  mockAuth.isAuthenticated = false;
});

describe("the screen every native launch lands on", () => {
  /**
   * The #691 bug, as a walk rather than as an argument. `isLoading` is not "the
   * token is being read off the device" — that part is local — it is "the
   * socket has not answered", which offline it never will.
   */
  test("a phone that remembers a session is let in, rather than left on a blank ground", async () => {
    await seedLastGoodVisit();

    expect(await paint(createElement(RootScreen))).toBe("-> /console");
  });

  /**
   * And the bound. Sign-out clears the offline namespace, so a signed-out
   * device remembers nothing, offers nothing, and waits exactly as it did
   * before any of this — the presence of a remembered context is the whole of
   * the evidence that there was ever a session here.
   */
  test("a signed-out device still waits, because it remembers nothing", async () => {
    expect(await paint(createElement(RootScreen))).toBe("");
  });

  /**
   * A memory is never substituted for an answer that is still coming. Once the
   * server has spoken, it decides — offline is the only state in which this
   * device's memory is allowed to stand in for it.
   */
  test("a session the server has answered for goes where the server says", async () => {
    await seedLastGoodVisit();
    mockAuth.isLoading = false;
    mockAuth.isAuthenticated = false;

    expect(await paint(createElement(RootScreen))).toBe("-> /login");
  });
});

describe("what `/console` resolves to, with nothing answering", () => {
  /** Drive the real console hook against a client that never lands. */
  async function consoleData(): Promise<ConsoleData> {
    let latest: ConsoleData | null = null;
    function Probe() {
      latest = useLiveConsoleData();
      return null;
    }
    await paint(
      createElement(ConvexProvider, { client: offlineClient() }, createElement(Probe)),
    );
    return latest as unknown as ConsoleData;
  }

  test("the context list is this device's, and the console knows it has one", async () => {
    await seedLastGoodVisit();

    const data = await consoleData();

    // `loading` is what `/console` reads to tell "no contexts" from "not yet".
    // Left `true` here, `landingStep` answers `wait` and the screen is blank —
    // which is the same blank #691 fixed one route earlier.
    expect(data.loading).toBe(false);
    expect(data.contexts.map((context) => context.slug)).toEqual(["seyi"]);
  });

  test("and it sends the person to that context rather than to the Map", async () => {
    await seedLastGoodVisit();

    const data = await consoleData();

    expect(landingStep(data.contexts, null, !data.loading)).toEqual({
      action: "redirect",
      href: "/console/@seyi",
    });
  });

  /**
   * The end of the walk: the folder somebody was last in, drawn from the copy
   * on the device, with the app saying plainly that it is offline. Without this
   * the two tests above would pass for a console that resolves to a context and
   * then shows an empty tree.
   */
  test("the browse pane is served from the device, and says it is offline", async () => {
    await seedLastGoodVisit();

    const data = await consoleData();
    const files = data.files as unknown as {
      loading: boolean;
      listings: Record<string, { entries: { name: string }[] }>;
      sync: { reachability: string; ready: boolean };
    };

    expect(files.loading).toBe(false);
    expect(files.listings[""]?.entries.map((entry) => entry.name)).toEqual(["a.md"]);
    expect(files.sync.reachability).toBe("offline");
    expect(files.sync.ready).toBe(true);
  });

  /**
   * Nothing is manufactured for a device with no memory. This is the same
   * boundary as the `/` test above, checked one route further in because it is
   * the route that would otherwise invent an empty context to show.
   */
  test("a device that remembers nothing is still waiting, not empty", async () => {
    const data = await consoleData();

    expect(data.loading).toBe(true);
    expect(data.contexts).toEqual([]);
    expect(landingStep(data.contexts, null, !data.loading)).toEqual({ action: "wait" });
  });
});
