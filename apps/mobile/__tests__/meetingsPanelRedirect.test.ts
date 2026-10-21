/**
 * @jest-environment jsdom
 */

import { describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * `/meetings` is a phone's page and nobody else's (owner, 2026-10-21).
 *
 * On a layout with a right panel the list was a second copy of the panel's
 * Meetings tab, and on the Mac app a window with no way out. The address still
 * resolves — an old link or a typed URL must not break — but at medium and
 * wide it resolves to the console with the panel open on Meetings.
 *
 * SABOTAGE: drop the density check from the route, and the pointer case
 * renders the list; invert it, and the phone loses its only list.
 */

const redirected: string[] = [];
let mockQuery: Record<string, string> = {};
jest.mock("expo-router", () => ({
  useLocalSearchParams: () => mockQuery,
  Redirect: ({ href }: { href: string }) => {
    redirected.push(href);
    return null;
  },
}));
jest.mock("../features/meetings/MeetingsListScreen", () => ({
  MeetingsListScreen: () => {
    const { createElement: h } = require("react") as typeof import("react");
    return h("div", { "data-testid": "meetings-list" });
  },
}));

const MeetingsRoute = (require("../app/(app)/meetings/index") as { default: () => null }).default;
const { MEETINGS_PANEL_HREF, MEETINGS_RECORD_HREF, meetingsAskAction, meetingsPanelFromQuery } =
  require("../features/meetings/route") as typeof import("../features/meetings/route");

function mountAt(width: number) {
  Object.defineProperty(document.documentElement, "clientWidth", { value: width, configurable: true });
  Object.defineProperty(document.documentElement, "clientHeight", { value: 900, configurable: true });
  window.dispatchEvent(new Event("resize"));
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(createElement(MeetingsRoute)));
  return {
    list: () => container.querySelector('[data-testid="meetings-list"]'),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("/meetings", () => {
  test("a pointer layout is sent to the panel, and draws no page", () => {
    for (const width of [900, 1440]) {
      redirected.length = 0;
      const app = mountAt(width);
      expect(app.list()).toBeNull();
      expect(redirected).toEqual([MEETINGS_PANEL_HREF]);
      app.unmount();
    }
  });

  test("the widget's Record still records on the way to the panel", () => {
    redirected.length = 0;
    mockQuery = { quickAction: "meeting" };
    try {
      const app = mountAt(1024);
      expect(redirected).toEqual([MEETINGS_RECORD_HREF]);
      app.unmount();
    } finally {
      mockQuery = {};
    }
  });

  test("a phone keeps the list, because it has no panel", () => {
    redirected.length = 0;
    const app = mountAt(390);
    expect(app.list()).not.toBeNull();
    expect(redirected).toEqual([]);
    app.unmount();
  });

  test("the hrefs it sends to are ones the console reads", () => {
    const ask = (href: string) =>
      meetingsPanelFromQuery(new URL(href, "https://example.test").searchParams.get("meetings") ?? undefined);
    expect(ask(MEETINGS_PANEL_HREF)).toBe("open");
    expect(ask(MEETINGS_RECORD_HREF)).toBe("record");
    expect(meetingsPanelFromQuery(undefined)).toBeNull();
    expect(meetingsPanelFromQuery(["0"])).toBeNull();
  });
});

describe("what the console does with the ask", () => {
  const base = { hasAside: true, canRecord: true, ready: true, live: false };
  test("a panel opens on Meetings", () => {
    expect(meetingsAskAction({ ...base, ask: "open" })).toBe("open");
  });
  test("Record records, once the controller is ready", () => {
    expect(meetingsAskAction({ ...base, ask: "record", ready: false })).toBe("wait");
    expect(meetingsAskAction({ ...base, ask: "record" })).toBe("record");
  });
  test("a running meeting is shown, never a second one started", () => {
    expect(meetingsAskAction({ ...base, ask: "record", live: true })).toBe("open");
  });
  test("nowhere to record, or no panel, never waits forever", () => {
    expect(meetingsAskAction({ ...base, ask: "record", canRecord: false, ready: false })).toBe("open");
    expect(meetingsAskAction({ ...base, ask: "record", hasAside: false, ready: false })).toBe("clear");
  });
});
