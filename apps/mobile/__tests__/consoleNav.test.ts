import { describe, expect, test } from "@jest/globals";
import {
  APP_SECTIONS,
  appSectionsFor,
  LANDING_ROUTE,
  landingHref,
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
  settingsFromQuery,
} from "../features/console/nav";
import { DEFAULT_SETTINGS_SECTION } from "../features/console/settings/sections";

/**
 * The console's two scopes.
 *
 * These are URL rules, and URL rules are exactly the kind of thing that looks
 * right when you click it and is wrong when somebody pastes a link. The jest
 * suite here runs in plain node with no renderer (see `jest.config.js`), which
 * is why the whole model is a pure module rather than state inside the shell.
 */

const contexts = [
  { id: "w1", slug: "seyi", role: "owner" },
  { id: "w2", slug: "lk", role: "member" },
  { id: "w3", slug: "public-worship", role: "editor" },
];

describe("the route table", () => {
  test("app level is exactly Search, Map and Connections", () => {
    expect(APP_SECTIONS.map((section) => section.key)).toEqual([
      "search",
      "map",
      "connections",
    ]);
  });

  /**
   * Search is app level rather than a context's, and it is conditional.
   *
   * The first half is why it exists at all: the question it answers spans more
   * than one context, and a Search *inside* a context would default its scope
   * to that one — which is the search that already lives behind the palette.
   *
   * The second half is the rule that shows on screen. Somebody whose contexts
   * all have fast search off has a destination that can only apologise, so the
   * row goes; somebody whose eligible list has not arrived yet keeps it,
   * because a navigation item that appears a beat late is one people learn not
   * to look for. `undefined` is therefore emphatically not zero.
   */
  test("Search is drawn until something says nothing would answer it", () => {
    expect(appSectionsFor(undefined).map((section) => section.key)).toContain("search");
    expect(appSectionsFor(2).map((section) => section.key)).toContain("search");
    expect(appSectionsFor(0).map((section) => section.key)).not.toContain("search");
    // And nothing else moves with it.
    expect(appSectionsFor(0).map((section) => section.key)).toEqual([
      "map",
      "connections",
    ]);
  });

  test("every app section has a distinct URL", () => {
    const hrefs = APP_SECTIONS.map((section) => section.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  /**
   * The root of the console is a landing, not a pane.
   *
   * `/console` used to be the Map's own URL, so signing in put somebody in
   * front of a diagram of their contexts rather than in one of them. It is now
   * its own route kind — the redirect to the first reachable context happens in
   * `app/(app)/console/index.tsx`, and the *route* exists so that the rail can
   * paint nothing at all while it is on screen. Leaving `/console` mapped to
   * `MAP_ROUTE` and redirecting from the component would light Map up in the
   * rail for the frame before the redirect landed, on the transition somebody
   * sees most often.
   */
  test("the root of the console is the landing, and the map has its own URL", () => {
    expect(hrefFor(LANDING_ROUTE)).toBe("/console");
    expect(routeForPath("/console")).toEqual({ kind: "landing" });

    expect(hrefFor(MAP_ROUTE)).toBe("/console/map");
    expect(routeForPath("/console/map")).toEqual({ kind: "app", section: "map" });
  });

  /**
   * Where the landing actually sends somebody.
   *
   * **A context you own**, and the first of the list only when you own none.
   * See `defaultContext`: this used to be the first of the list outright, and
   * that list is ordered by nothing a person would recognise — so an account
   * that owns `@agent` and was invited into `@seyi` was redirected into
   * `@seyi`, and `resolveContextRoute` then selected it over the top of a
   * correct default, because the URL wins.
   */
  test("the landing resolves to a context you own", () => {
    expect(landingHref(contexts)).toBe("/console/@seyi");
    // The same list with ownership somewhere other than the front, which is
    // the arrangement that shipped broken.
    expect(
      landingHref([
        { slug: "lk", role: "member" },
        { slug: "agent", role: "owner" },
      ]),
    ).toBe("/console/@agent");
    expect(landingHref([{ slug: "public-worship", role: "editor" }])).toBe(
      "/console/@public-worship",
    );
  });

  /**
   * `null` covers two states on purpose: still loading, and none at all.
   *
   * Both mean *do not navigate*, and telling them apart belongs to the caller
   * — which draws the Map either way, so an account with no contexts sees the
   * one pane that is about not having any.
   */
  test("an account with nothing to land in gets no href rather than a bad one", () => {
    expect(landingHref([])).toBeNull();
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
    // Still the context's, and now a parameter on the context's own page
    // rather than a route that replaces it: the console renders one `<Slot />`,
    // so a settings *route* covers Browse instead of overlaying it, and
    // closing it had to guess whether to return to the context root or to
    // whatever note was open. As a parameter there is nothing to guess.
    expect(settingsHref("public-worship")).toBe(
      "/console/@public-worship?settings=storage",
    );
    expect(settingsHref("public-worship", "sources")).toBe(
      "/console/@public-worship?settings=sources",
    );
    // The old path stays a context route, because it is in the wild — the
    // Dropbox failure notice and the search nudge both link to it — and
    // `app/(app)/console/[slug]/settings.tsx` redirects it to the parameter.
    expect(routeForPath("/console/@public-worship/settings")).toEqual({
      kind: "context",
      slug: "public-worship",
      view: "settings",
    });
  });

  test("a settings parameter is read back fail-closed", () => {
    // The same shape `safeNotePath` uses: a hand-edited or stale value closes
    // the overlay rather than opening a blank panel on a section we do not
    // have — and an empty value closes, because closing is what produces it.
    expect(settingsFromQuery("sources")).toBe("sources");
    expect(settingsFromQuery(DEFAULT_SETTINGS_SECTION)).toBe(DEFAULT_SETTINGS_SECTION);
    // Empty is *closed*, not the default: closing sets the parameter to
    // `undefined`, and a router that serialises that as a bare `?settings=`
    // would otherwise re-open the panel the press was trying to dismiss.
    expect(settingsFromQuery("")).toBeNull();
    expect(settingsFromQuery(undefined)).toBeNull();
    expect(settingsFromQuery("not-a-section")).toBeNull();
    // The nudge's destination is a real section, not just any string.
    expect(settingsFromQuery("search")).toBe("search");
    expect(settingsFromQuery(["sources", "storage"])).toBe("sources");
  });

  test("there is no top-level storage URL any more", () => {
    // It was never app level: a binding belongs to a workspace. The old URL
    // must not resolve to something that renders a different context's bucket.
    expect(routeForPath("/console/storage")).toEqual(LANDING_ROUTE);
  });

  test("every href round-trips through routeForPath", () => {
    const routes: ConsoleRoute[] = [
      { kind: "landing" },
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
    expect(routeForPath("/console/")).toEqual(LANDING_ROUTE);
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
    expect(routeForPath("/console/browse")).toEqual(LANDING_ROUTE);
    expect(routeForPath("/console/nope")).toEqual(LANDING_ROUTE);
  });

  /**
   * The fallback moved with the root, and it is a better one.
   *
   * It used to be the map, "the one view that is always meaningful". The
   * landing is more meaningful than the map was: a dead link puts somebody in
   * their notes rather than in a diagram of them.
   */
  test("nonsense falls back to the landing rather than rendering nothing", () => {
    expect(routeForPath("")).toEqual(LANDING_ROUTE);
    expect(routeForPath("/")).toEqual(LANDING_ROUTE);
    expect(routeForPath("/login")).toEqual(LANDING_ROUTE);
    expect(routeForPath("/console/@")).toEqual(LANDING_ROUTE);
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
