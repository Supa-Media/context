/**
 * @jest-environment jsdom
 */

/**
 * `/console` PUTS YOU IN YOUR NOTES.
 *
 * The console used to open on the Map — a constellation diagram of every
 * context you can reach. That is a good picture of what this product *is* and a
 * bad answer to what somebody opened the app to do; it was not a pane you
 * visited, it was the pane you got past, every time, before you could read
 * anything.
 *
 * `consoleNav.test.ts` pins `landingHref` and `routeForPath` as pure functions,
 * which is necessary and not sufficient: the two states this route has to tell
 * apart are *whose* they are, not the URL's. `landingHref` answers `null` both
 * while the subscription is in flight and for an account that can reach no
 * context, and the route must draw the Map in both cases rather than redirect
 * to nowhere or race the query. That decision lives in the component, so this
 * mounts the component.
 *
 * It is a render test because the failure mode is a render one: `Redirect` acts
 * *during* render, and swapping it for a `router.replace` in an effect leaves a
 * frame in which the Map is mounted and painting — the exact flash this route
 * exists to remove, and one no pure test can see.
 *
 * ## And now there is a third state, which is why `mountLanding` is awaited
 *
 * `/console` also restores the file page a device was last on, which it has to
 * *ask* the device for — asynchronously, on every platform. So the route paints
 * nothing at all for the first commit, and then answers. `mountLanding` flushes
 * that read before returning, so every assertion below is about the settled
 * screen; `paints nothing while the device is being asked` is the one test that
 * looks at the frame before it, and it is the one that would catch the Map
 * flash coming back.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { ConsoleData } from "../features/console/types";

/**
 * `Redirect` is recorded rather than followed: there is no router here, and
 * where it *sends* somebody is the whole assertion. Rendered as a real node so
 * a route that returned `null` instead cannot pass.
 */
jest.mock("expo-router", () => ({
  Redirect: ({ href }: { href: string }) => {
    const { createElement: h } = require("react") as typeof import("react");
    return h("span", { "data-testid": "redirect", "data-href": href });
  },
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  usePathname: () => "/console",
}));

let mockData: ConsoleData = null as unknown as ConsoleData;
jest.mock("../features/console/ConsoleDataContext", () => ({
  useConsoleData: () => mockData,
}));

const ConsoleLanding = (
  require("../app/(app)/console/index") as { default: () => unknown }
).default;

function dataWith(contexts: ConsoleData["contexts"]): ConsoleData {
  return {
    loading: false,
    contexts,
    selectedContextId: contexts[0]?.id ?? null,
    selectContext: () => {},
    graph: { nodes: [], edges: [] },
    stats: [],
    clients: [],
    storage: null,
    files: { listings: {}, loading: false, expanded: new Set<string>(), selectedPath: null },
    members: { members: [], loading: false },
    failure: null,
  } as unknown as ConsoleData;
}

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

/**
 * Mount, and flush the device read the route now makes.
 *
 * `recallPlace` resolves on a microtask — `memoryStore()` under
 * `localStorage`, both async by contract — so without this every assertion
 * would run against the "still asking" frame, which paints nothing at all.
 */
async function mountLanding(data: ConsoleData): Promise<HTMLElement> {
  const container = mountLandingSync(data);
  await act(async () => {
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
  });
  return container;
}

function mountLandingSync(data: ConsoleData): HTMLElement {
  mockData = data;
  Object.defineProperty(document.documentElement, "clientWidth", {
    value: 390,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, "clientHeight", {
    value: 956,
    configurable: true,
  });
  window.dispatchEvent(new Event("resize"));

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(createElement(ConsoleLanding as never));
  });
  return container;
}

const CONTEXTS = [
  { id: "w1", slug: "seyi", displayName: "seyi", role: "owner", kind: "personal", status: "ok" },
  { id: "w2", slug: "lk", displayName: "lk", role: "member", kind: "personal", status: "ok" },
] as unknown as ConsoleData["contexts"];

/* -------------------------------------------------------------------------- */

describe("signing in lands on your notes", () => {
  test("the first context in the rail's own order, on its Browse", async () => {
    const container = await mountLanding(dataWith(CONTEXTS));
    const redirect = container.querySelector('[data-testid="redirect"]');

    expect(redirect).not.toBeNull();
    expect(redirect!.getAttribute("data-href")).toBe("/console/@seyi");
  });

  test("and paints nothing at all while a device with contexts in hand is asked", () => {
    /*
      The frame before the answer, on the *warm* path. It has to be blank rather
      than the Map: drawing the constellation and then redirecting out of it is
      the flash this route was made to remove, and the asynchronous device read
      is a new way to reintroduce it. Deliberately not awaited — that is the
      point.
    */
    const container = mountLandingSync(dataWith(CONTEXTS));
    expect(container.querySelector('[data-testid="redirect"]')).toBeNull();
    expect(container.textContent ?? "").toBe("");
  });

  test("a cold launch paints nothing until the list has arrived, not a false Map", async () => {
    /**
     * **This reverses a decision, on the evidence of a screen recording.**
     *
     * #212 answered a blank cold-launch pane by drawing the Map whenever
     * `contexts` was empty, reasoning that "the Map is what this route draws
     * anyway until the list arrives". Filmed on the native app, that was wrong
     * twice.
     *
     * It was a *flicker*: splash, blank, the Map for one frame, blank, then
     * the note. For somebody who has contexts the Map is a screen they are
     * about to be redirected out of, so drawing it is a transition that exists
     * only to be undone.
     *
     * And it was a *lie*: on a cold launch `contexts` is empty because nothing
     * has been fetched, so what appeared was a picture of an account with
     * nothing in it — "0 reachable", "0 connected", a lone "You" node, "0 in
     * your context" — every number counting a list that had not arrived.
     *
     * Blank is not a nice state and it is an honest one, and it is not what
     * somebody sees: the console layout's chrome is up around it, and the same
     * quiet pane is there a moment later while the note is read. Waiting here
     * adds no transition rather than adding a wrong one.
     */
    const container = mountLandingSync({
      ...dataWith([] as unknown as ConsoleData["contexts"]),
      loading: true,
    });
    expect(container.textContent ?? "").toBe("");
    await act(async () => {
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    });
    expect(container.textContent ?? "").toBe("");
  });

  test("and the Map is still what an account with no contexts gets", async () => {
    /*
      The control. Waiting for the list must not become "never draw the Map":
      somebody who really has nothing needs the pane that is *about* having
      nothing, with the invitation to make a context on it.
    */
    const container = await mountLanding({
      ...dataWith([] as unknown as ConsoleData["contexts"]),
      loading: false,
    });
    expect(container.querySelector('[data-testid="redirect"]')).toBeNull();
    expect(container.textContent ?? "").not.toBe("");
  });

  /**
   * The redirect happens **during render**, which is the property that makes
   * this a route rather than a flash of the wrong pane.
   *
   * `Redirect` returns instead of the Map, so the Map's own content is never in
   * the tree at all. A `router.replace` in an effect would paint the
   * constellation for a frame first — invisible to a pure test, and the whole
   * reason this file mounts anything.
   */
  test("and the Map is never mounted on the way through", async () => {
    const container = await mountLanding(dataWith(CONTEXTS));
    expect(container.textContent ?? "").toBe("");
  });
});

describe("the two states that do not redirect", () => {
  /**
   * `landingHref` answers `null` for both, and they are different facts with
   * the same instruction — do not navigate. They no longer get the same
   * *screen*: somebody who can reach nothing sees the one pane that is about
   * having nothing, and somebody whose list is still in flight sees nothing at
   * all, because the pane about having nothing is a claim and the list has not
   * answered. Telling the two apart is the caller's job, not the URL's.
   */
  test("an account that can reach no context sees the Map instead", async () => {
    const container = await mountLanding(dataWith([] as unknown as ConsoleData["contexts"]));
    expect(container.querySelector('[data-testid="redirect"]')).toBeNull();
    expect(container.textContent ?? "").not.toBe("");
  });

  test("a list that has not arrived yet navigates nowhere and draws nothing", async () => {
    const loading = { ...dataWith([] as unknown as ConsoleData["contexts"]), loading: true };
    const container = await mountLanding(loading);
    expect(container.querySelector('[data-testid="redirect"]')).toBeNull();
    expect(container.textContent ?? "").toBe("");
  });
});
