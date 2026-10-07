/**
 * @jest-environment jsdom
 */

/**
 * WHAT CHANGED IS A PAGE WITH AN ADDRESS.
 *
 * `?changes=1` beside `?note=`, the way `?settings=` rides: the page is drawn
 * where a note would be, opening it closes the suggestions popover and
 * Settings, choosing a note leaves it, and only a person who sees suggestions
 * at all can be on it.
 */

import { afterEach, describe, expect, test } from "@jest/globals";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { changesFromQuery, changesHref } from "../features/organizer/changesRoute";
import { routeOrganizer } from "../features/organizer/consoleOrganizer";
import { changesCount, footCount, phoneChangesCount } from "../features/organizer/rules";
import type { OrganizerStatus } from "../features/organizer/types";
import { useLeavePageOnOpen } from "../features/organizer/useLeavePageOnOpen";
import type { OrganizerView } from "../features/organizer/useOrganizer";

const STATUS: OrganizerStatus = {
  available: true,
  isOwner: true,
  on: true,
  noticeNeeded: false,
  startsAt: null,
  sweep: null,
  pending: 5,
  changes: 2,
  autopilot: { done: false, archive: false, file: false },
};

function view(status: OrganizerStatus | null = STATUS, closed: string[] = []): OrganizerView {
  return {
    status,
    openReview: () => closed.push("tidy"),
    pageOpen: false,
    openPage: () => {},
    closePage: () => {},
  } as unknown as OrganizerView;
}

describe("the address", () => {
  test("only `1` is open; anything else, or nothing, is closed", () => {
    expect(changesFromQuery("1")).toBe(true);
    expect(changesFromQuery(["1"])).toBe(true);
    for (const value of [undefined, "", "0", "true", "open", ["x"]]) expect(changesFromQuery(value)).toBe(false);
    expect(changesHref("seyi")).toMatch(/\?changes=1$/);
  });
});

describe("routing", () => {
  test("opening the page closes Settings; closing it clears the parameter", () => {
    const params: Record<string, unknown>[] = [];
    const closed: string[] = [];
    const routed = routeOrganizer(view(STATUS, closed), { setParams: (p: Record<string, unknown>) => params.push(p) } as never);
    routed.openPage();
    routed.closePage();
    expect(closed).toEqual([]);
    expect(params).toEqual([{ changes: "1", settings: undefined }, { changes: undefined }]);
  });

  test("looking over the suggestions, from anywhere, is the page on its Tidy up tab", () => {
    const params: Record<string, unknown>[] = [];
    const tabs: string[] = [];
    const routed = routeOrganizer(view(STATUS, tabs), { setParams: (p: Record<string, unknown>) => params.push(p) } as never);
    routed.openReview({ closeSettings: true });
    expect(tabs).toEqual(["tidy"]);
    expect(params).toEqual([{ changes: "1", settings: undefined }]);
  });

  test("the page is open only for somebody who sees suggestions", () => {
    const router = { setParams: () => {} } as never;
    expect(routeOrganizer(view(), router, true).pageOpen).toBe(true);
    expect(routeOrganizer(view(), router, false).pageOpen).toBe(false);
    expect(routeOrganizer(view({ ...STATUS, isOwner: false }), router, true).pageOpen).toBe(false);
    expect(routeOrganizer(view({ ...STATUS, on: false }), router, true).pageOpen).toBe(false);
    expect(routeOrganizer(view(null), router, true).pageOpen).toBe(false);
  });
});

describe("the counts", () => {
  test("cards have their own count; Tidy up counts the rest", () => {
    expect(changesCount(STATUS)).toBe(2);
    expect(footCount(STATUS)).toBe(3);
    expect(footCount({ ...STATUS, pending: 2 })).toBeNull();
    // A server older than the page sends no `changes`: every waiting row is a suggestion.
    const { changes: _none, ...older } = STATUS;
    expect(changesCount(older)).toBe(0);
    expect(footCount(older)).toBe(5);
    expect(changesCount({ ...STATUS, isOwner: false })).toBeNull();
  });

  test("the phone's line is on the workspace page, and only when cards are waiting", () => {
    expect(phoneChangesCount(STATUS, { compact: true, atRoot: true })).toBe(2);
    expect(phoneChangesCount(STATUS, { compact: true, atRoot: false })).toBeNull();
    expect(phoneChangesCount(STATUS, { compact: false, atRoot: true })).toBeNull();
    expect(phoneChangesCount({ ...STATUS, changes: 0 }, { compact: true, atRoot: true })).toBeNull();
  });
});

describe("choosing a note leaves the page", () => {
  const roots: (() => void)[] = [];
  afterEach(() => {
    while (roots.length > 0) roots.pop()!();
  });

  function Host({ organizer, path }: { organizer: OrganizerView; path: string | null }) {
    useLeavePageOnOpen(organizer, path);
    return null;
  }

  test("a new selection closes it; opening it over what was already open does not", () => {
    let closes = 0;
    const open = { ...view(), pageOpen: true, closePage: () => (closes += 1) } as OrganizerView;
    const root = createRoot(document.createElement("div"));
    roots.push(() => act(() => root.unmount()));
    act(() => root.render(createElement(Host, { organizer: open, path: "a.md" })));
    expect(closes).toBe(0);
    act(() => root.render(createElement(Host, { organizer: open, path: "a.md" })));
    expect(closes).toBe(0);
    act(() => root.render(createElement(Host, { organizer: open, path: "b.md" })));
    expect(closes).toBe(1);
  });
});
