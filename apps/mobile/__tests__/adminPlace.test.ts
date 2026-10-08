/**
 * The staff console's addresses (`features/admin/place.ts`) and the router
 * that gives moving between them a Back step (`features/admin/placeRouter.ts`).
 *
 * The owner, 2026-10-08: the console's tabs did not change the URL, so a
 * refresh lost the tab and Back left the console. These pin that every place
 * round-trips through its address, that nonsense addresses name nothing, and
 * that the router adds a Back step for a new place, none for a replace or a
 * filter, and restores the place before on Back.
 */

import { describe, expect, test } from "@jest/globals";
import {
  DEFAULT_PLACE,
  SEARCH_PLACES,
  adminPath,
  parseAdminPlace,
  parseWindow,
  sectionSegments,
  type AdminPlace,
} from "../features/admin/place";
import { PlaceRouter, type PlaceState } from "../features/admin/placeRouter";
import { SEARCH_SUBVIEWS } from "../features/admin/SearchSection";
import { waitlistPlace, waitlistView } from "../features/admin/WaitlistSection";

describe("every place has one address", () => {
  const places: AdminPlace[] = [
    { tab: "growth", sub: null },
    { tab: "estate", sub: null },
    { tab: "activity", sub: null },
    { tab: "agent", sub: null },
    { tab: "agent", sub: "j57abc_DEF-9" },
    { tab: "aiCosts", sub: null },
    { tab: "aiCosts", sub: "k17user" },
    { tab: "search", sub: null },
    { tab: "search", sub: "indexes" },
    { tab: "search", sub: "speed" },
    { tab: "credentials", sub: null },
    { tab: "waitlist", sub: null },
    { tab: "waitlist", sub: "let-in" },
    { tab: "waitlist", sub: "friends" },
  ];

  test.each(places)("%o round-trips", (place: AdminPlace) => {
    const path = adminPath(place);
    expect(path.startsWith("/admin/")).toBe(true);
    expect(parseAdminPlace(sectionSegments(path.slice("/admin/".length)))).toEqual(place);
  });

  test("bare /admin is Growth, and AI costs reads like an address", () => {
    expect(parseAdminPlace([])).toEqual(DEFAULT_PLACE);
    expect(adminPath({ tab: "aiCosts", sub: null })).toBe("/admin/ai-costs");
    expect(adminPath({ tab: "search", sub: "speed" })).toBe("/admin/search/speed");
  });

  test.each([
    [["nope"]],
    [["aiCosts"]], // the code key is not a second spelling
    [["search", "bogus"]],
    [["waitlist", "admitted"]], // the address word is let-in
    [["growth", "anything"]],
    [["agent", "../secrets"]],
    [["agent", "a b"]],
    [["search", "speed", "extra"]],
    [["constructor"]],
  ])("%o names no place", (segments: string[]) => {
    expect(parseAdminPlace(segments)).toBeNull();
  });

  test("the window is one of the offered ones or the default", () => {
    expect(parseWindow("7")).toBe(7);
    expect(parseWindow(["90"])).toBe(90);
    expect(parseWindow("8")).toBe(30);
    expect(parseWindow(undefined)).toBe(30);
    expect(parseWindow("7; drop")).toBe(30);
  });

  test("every Search view the tab offers has an address", () => {
    expect(SEARCH_SUBVIEWS.map((entry) => entry.key).sort()).toEqual([...SEARCH_PLACES].sort());
  });

  test("waitlist views and their address words are inverses", () => {
    for (const view of ["waiting", "admitted", "removed", "friends"] as const) {
      expect(waitlistView(waitlistPlace(view))).toBe(view);
    }
    expect(waitlistPlace("admitted")).toBe("let-in");
    expect(waitlistView(null)).toBe("waiting");
  });
});

describe("the router gives places a Back step without a second page", () => {
  const options = { routeNames: ["[...section]", "index"], routeParamList: {} as Record<string, object | undefined> };
  const router = PlaceRouter({});
  const section = (...parts: string[]) => ({ section: parts });

  function start(): PlaceState {
    const initial = router.getInitialState(options);
    return router.getStateForAction(
      initial,
      { type: "REPLACE", payload: { name: "[...section]", params: section("growth") } },
      options,
    )!;
  }

  const push = (state: PlaceState, params: object) =>
    router.getStateForAction(state, { type: "PUSH", payload: { name: "[...section]", params } }, options)!;

  test("a new place keeps the mounted route and adds one history entry", () => {
    const at = start();
    const next = push(at, section("search"));
    expect(next.routes).toHaveLength(1);
    expect(next.routes[0]!.key).toBe(at.routes[0]!.key);
    expect(next.routes[0]!.params).toEqual(section("search"));
    expect(next.history).toHaveLength(at.history.length + 1);
  });

  test("the place already open is not a Back step", () => {
    const at = push(start(), section("search"));
    expect(push(at, section("search"))).toBe(at);
  });

  test("Back restores the place before, then hands Back on", () => {
    const first = start();
    const second = push(push(first, section("search")), section("search", "speed"));
    const back = router.getStateForAction(second, { type: "GO_BACK" }, options)!;
    expect(back.routes[0]!.params).toEqual(section("search"));
    const again = router.getStateForAction(back, { type: "GO_BACK" }, options)!;
    expect(again.routes[0]!.params).toEqual(section("growth"));
    expect(again.history).toHaveLength(first.history.length);
    expect(router.getStateForAction(again, { type: "GO_BACK" }, options)).toBeNull();
  });

  test("a replace and a filter change add no Back step", () => {
    const at = push(start(), section("search"));
    const replaced = router.getStateForAction(
      at,
      { type: "REPLACE", payload: { name: "[...section]", params: section("waitlist") } },
      options,
    )!;
    expect(replaced.history).toHaveLength(at.history.length);
    const filtered = router.getStateForAction(replaced, { type: "SET_PARAMS", payload: { params: { days: "7" } } }, options)!;
    expect(filtered.history).toHaveLength(at.history.length);
    expect(filtered.routes[0]!.params).toEqual({ ...section("waitlist"), days: "7" });
  });

  test("a route that is not here is not handled here", () => {
    expect(router.getStateForAction(start(), { type: "PUSH", payload: { name: "elsewhere" } }, options)).toBeNull();
  });

  test("a stored state comes back as it was, history and all", () => {
    const stored = push(start(), section("search"));
    expect(router.getRehydratedState(stored, options)).toBe(stored);
  });
});
