import { describe, expect, test } from "@jest/globals";
import {
  APP_SECTIONS,
  MAP_ROUTE,
  browseHref,
  closeSettings,
  contextSegment,
  hrefFor,
  isSettingsOpen,
  openSettings,
  resolveContextRoute,
  routeContextSlug,
  routeForPath,
  sameRoute,
  selectContextRoute,
  settingsHref,
  slugFromSegment,
  type ConsoleRoute,
} from "../features/console/nav";

/**
 * The console's two scopes.
 *
 * These are URL rules, and URL rules are exactly the kind of thing that looks
 * right when you click it and is wrong when somebody pastes a link. The jest
 * suite here runs in plain node with no renderer (see `jest.config.js`), which
 * is why the whole model is a pure module rather than state inside the shell.
 */

const contexts = [
  { id: "w1", slug: "seyi" },
  { id: "w2", slug: "lk" },
  { id: "w3", slug: "public-worship" },
];

describe("the route table", () => {
  test("app level is exactly Map and Connections", () => {
    expect(APP_SECTIONS.map((section) => section.key)).toEqual(["map", "connections"]);
  });

  test("every app section has a distinct URL", () => {
    const hrefs = APP_SECTIONS.map((section) => section.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  test("the map is the root of the console", () => {
    expect(hrefFor(MAP_ROUTE)).toBe("/console");
    expect(routeForPath("/console")).toEqual({ kind: "app", section: "map" });
  });

  test("connections is app level, not inside a context", () => {
    expect(routeForPath("/console/connections")).toEqual({
      kind: "app",
      section: "connections",
    });
    expect(routeContextSlug(routeForPath("/console/connections"))).toBeNull();
  });

  test("a context is addressed by its @name, and Browse is its default view", () => {
    expect(browseHref("seyi")).toBe("/console/@seyi");
    expect(routeForPath("/console/@seyi")).toEqual({
      kind: "context",
      slug: "seyi",
      view: "browse",
    });
  });

  test("settings hangs off the context, not off the app", () => {
    expect(settingsHref("public-worship")).toBe("/console/@public-worship/settings");
    expect(routeForPath("/console/@public-worship/settings")).toEqual({
      kind: "context",
      slug: "public-worship",
      view: "settings",
    });
  });

  test("there is no top-level storage URL any more", () => {
    // It was never app level: a binding belongs to a workspace. The old URL
    // must not resolve to something that renders a different context's bucket.
    expect(routeForPath("/console/storage")).toEqual(MAP_ROUTE);
  });

  test("every href round-trips through routeForPath", () => {
    const routes: ConsoleRoute[] = [
      { kind: "app", section: "map" },
      { kind: "app", section: "connections" },
      { kind: "context", slug: "seyi", view: "browse" },
      { kind: "context", slug: "public-worship", view: "settings" },
    ];
    for (const route of routes) {
      expect(routeForPath(hrefFor(route))).toEqual(route);
    }
  });
});

describe("parsing a console URL", () => {
  test("a trailing slash is not a different place", () => {
    expect(routeForPath("/console/")).toEqual(MAP_ROUTE);
    expect(routeForPath("/console/@lk/")).toEqual({
      kind: "context",
      slug: "lk",
      view: "browse",
    });
    expect(routeForPath("/console/@lk/settings/")).toEqual({
      kind: "context",
      slug: "lk",
      view: "settings",
    });
  });

  test("a percent-encoded @ is the same context", () => {
    expect(routeForPath("/console/%40seyi")).toEqual({
      kind: "context",
      slug: "seyi",
      view: "browse",
    });
  });

  test("a query string or fragment does not change the route", () => {
    expect(routeForPath("/console/@seyi?from=email")).toEqual({
      kind: "context",
      slug: "seyi",
      view: "browse",
    });
    expect(routeForPath("/console/connections#grants")).toEqual({
      kind: "app",
      section: "connections",
    });
  });

  test("an unrecognised view inside a context is still that context's Browse", () => {
    expect(routeForPath("/console/@seyi/nope")).toEqual({
      kind: "context",
      slug: "seyi",
      view: "browse",
    });
  });

  test("a bare word where a context should be is not invented into one", () => {
    // Otherwise `/console/browse` — the URL this restructuring removed — would
    // silently become a context called "browse".
    expect(routeForPath("/console/browse")).toEqual(MAP_ROUTE);
    expect(routeForPath("/console/nope")).toEqual(MAP_ROUTE);
  });

  test("nonsense falls back to the map rather than rendering nothing", () => {
    expect(routeForPath("")).toEqual(MAP_ROUTE);
    expect(routeForPath("/")).toEqual(MAP_ROUTE);
    expect(routeForPath("/login")).toEqual(MAP_ROUTE);
    expect(routeForPath("/console/@")).toEqual(MAP_ROUTE);
  });

  test("a malformed escape is somebody's hand-edited URL, not a crash", () => {
    expect(() => routeForPath("/console/@%E0%A4%A")).not.toThrow();
  });
});

describe("@names", () => {
  test("the @ lives in the URL and nowhere else", () => {
    expect(contextSegment("seyi")).toBe("@seyi");
    expect(slugFromSegment("@seyi")).toBe("seyi");
  });

  test("prefixing is idempotent, so a slug that already has one is left alone", () => {
    expect(contextSegment("@seyi")).toBe("@seyi");
    expect(slugFromSegment("seyi")).toBe("seyi");
  });
});

describe("the settings sheet opens and closes over Browse", () => {
  const browsing: ConsoleRoute = { kind: "context", slug: "seyi", view: "browse" };

  test("it starts closed", () => {
    expect(isSettingsOpen(browsing)).toBe(false);
  });

  test("opening it stays in the same context", () => {
    const opened = openSettings(browsing);
    expect(opened).toEqual({ kind: "context", slug: "seyi", view: "settings" });
    expect(isSettingsOpen(opened)).toBe(true);
    expect(routeContextSlug(opened)).toBe("seyi");
  });

  test("closing it returns to that context's Browse, never to the map", () => {
    const closed = closeSettings(openSettings(browsing));
    expect(closed).toEqual(browsing);
    expect(isSettingsOpen(closed)).toBe(false);
  });

  test("opening twice is opening once", () => {
    const once = openSettings(browsing);
    expect(openSettings(once)).toEqual(once);
  });

  test("closing something already closed changes nothing", () => {
    expect(closeSettings(browsing)).toEqual(browsing);
  });

  test("there is no app-level settings, so opening from one is a no-op", () => {
    // Settings is always *a context's* settings. Guessing which one was meant
    // is how you edit the wrong bucket.
    expect(openSettings(MAP_ROUTE)).toEqual(MAP_ROUTE);
    expect(isSettingsOpen(MAP_ROUTE)).toBe(false);
    expect(closeSettings({ kind: "app", section: "connections" })).toEqual({
      kind: "app",
      section: "connections",
    });
  });

  test("the open and closed states are different URLs, so the back button works", () => {
    expect(hrefFor(browsing)).not.toBe(hrefFor(openSettings(browsing)));
  });
});

describe("selecting a context in the rail", () => {
  test("lands on Browse, which is a context's default view", () => {
    expect(selectContextRoute("lk")).toEqual({ kind: "context", slug: "lk", view: "browse" });
  });

  test("never carries the previous context's settings across", () => {
    const wasInSettings: ConsoleRoute = {
      kind: "context",
      slug: "seyi",
      view: "settings",
    };
    expect(isSettingsOpen(wasInSettings)).toBe(true);
    expect(isSettingsOpen(selectContextRoute("lk"))).toBe(false);
  });
});

describe("resolving a URL against the contexts you can actually reach", () => {
  test("an app-level route asks nothing of the selection", () => {
    expect(
      resolveContextRoute({
        route: MAP_ROUTE,
        contexts,
        selectedContextId: "w2",
        loading: false,
      }),
    ).toEqual({ action: "stay" });
  });

  test("the URL wins: a context route selects the context it names", () => {
    expect(
      resolveContextRoute({
        route: routeForPath("/console/@public-worship"),
        contexts,
        selectedContextId: "w1",
        loading: false,
      }),
    ).toEqual({ action: "select", contextId: "w3" });
  });

  test("settings for a context selects that context too", () => {
    expect(
      resolveContextRoute({
        route: routeForPath("/console/@lk/settings"),
        contexts,
        selectedContextId: "w1",
        loading: false,
      }),
    ).toEqual({ action: "select", contextId: "w2" });
  });

  test("an agreeing URL does not re-select and loop", () => {
    expect(
      resolveContextRoute({
        route: routeForPath("/console/@lk"),
        contexts,
        selectedContextId: "w2",
        loading: false,
      }),
    ).toEqual({ action: "stay" });
  });

  test("a context that is not yours redirects rather than showing another one", () => {
    expect(
      resolveContextRoute({
        route: routeForPath("/console/@someone-else"),
        contexts,
        selectedContextId: "w1",
        loading: false,
      }),
    ).toEqual({ action: "redirect", href: "/console" });
  });

  test("'not loaded yet' is not 'not yours'", () => {
    expect(
      resolveContextRoute({
        route: routeForPath("/console/@seyi"),
        contexts: [],
        selectedContextId: null,
        loading: true,
      }),
    ).toEqual({ action: "stay" });
  });

  test("an account with no contexts at all waits rather than bouncing", () => {
    expect(
      resolveContextRoute({
        route: routeForPath("/console/@seyi"),
        contexts: [],
        selectedContextId: null,
        loading: false,
      }),
    ).toEqual({ action: "stay" });
  });
});

describe("sameRoute", () => {
  test("distinguishes the views of one context", () => {
    expect(
      sameRoute(
        { kind: "context", slug: "seyi", view: "browse" },
        { kind: "context", slug: "seyi", view: "settings" },
      ),
    ).toBe(false);
  });

  test("distinguishes two contexts on the same view", () => {
    expect(
      sameRoute(
        { kind: "context", slug: "seyi", view: "browse" },
        { kind: "context", slug: "lk", view: "browse" },
      ),
    ).toBe(false);
  });

  test("matches identical routes across scopes", () => {
    expect(sameRoute(MAP_ROUTE, { kind: "app", section: "map" })).toBe(true);
    expect(sameRoute(MAP_ROUTE, { kind: "app", section: "connections" })).toBe(false);
    expect(sameRoute(MAP_ROUTE, { kind: "context", slug: "seyi", view: "browse" })).toBe(
      false,
    );
  });
});
