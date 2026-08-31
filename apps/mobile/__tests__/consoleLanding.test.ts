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

function mountLanding(data: ConsoleData): HTMLElement {
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
  test("the first context in the rail's own order, on its Browse", () => {
    const container = mountLanding(dataWith(CONTEXTS));
    const redirect = container.querySelector('[data-testid="redirect"]');

    expect(redirect).not.toBeNull();
    expect(redirect!.getAttribute("data-href")).toBe("/console/@seyi");
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
  test("and the Map is never mounted on the way through", () => {
    const container = mountLanding(dataWith(CONTEXTS));
    expect(container.textContent ?? "").toBe("");
  });
});

describe("the two states that do not redirect", () => {
  /**
   * `landingHref` answers `null` for both, and they are different facts with
   * the same instruction — do not navigate. Somebody who can reach nothing sees
   * the one pane that is *about* having nothing; somebody whose list is still in
   * flight sees it for the moment before it arrives, rather than a blank screen.
   * Telling the two apart is the caller's job, not the URL's.
   */
  test("an account that can reach no context sees the Map instead", () => {
    const container = mountLanding(dataWith([] as unknown as ConsoleData["contexts"]));
    expect(container.querySelector('[data-testid="redirect"]')).toBeNull();
    expect(container.textContent ?? "").not.toBe("");
  });

  test("so does a list that has not arrived yet", () => {
    const loading = { ...dataWith([] as unknown as ConsoleData["contexts"]), loading: true };
    const container = mountLanding(loading);
    expect(container.querySelector('[data-testid="redirect"]')).toBeNull();
  });
});
