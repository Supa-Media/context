/**
 * @jest-environment jsdom
 */
/**
 * Above the rail's rule, full-page apps; below it, side-panel apps (Dev,
 * 2026-11-26, a standing rule). `features/console/aside/railApps.ts` is the one
 * list of which is which; these hold the drawing and the behaviour to it.
 *
 * SABOTAGE: draw the map's button under the rule in `AsideStrip`, or add a tab
 * to `ASIDE_TABS` that opens a page, and the first test fails; let a page app's
 * press open the panel and the second does.
 */
import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { AsideStrip } from "../features/console/aside/AsideStrip";
import { ASIDE_TABS, type AsideTab } from "../features/console/aside/tabs";
import { RAIL_PAGE_APPS, RAIL_PANEL_APPS, railOpens, type RailApp } from "../features/console/aside/railApps";
import { MapRouteProvider } from "../features/console/map/live/MapRouteContext";
import { MailRouteProvider, type MailRoute } from "../features/console/mailPage/MailRouteContext";
import type { MapRoute } from "../features/console/map/live/route";
import type { FullPages } from "../features/console/layout/leaveFullPage";

jest.mock("../features/console/mailPage/useConversations", () => ({ useConversations: () => ({ fresh: 0 }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const unmounts: (() => void)[] = [];
afterEach(() => {
  while (unmounts.length > 0) unmounts.pop()!();
  document.body.innerHTML = "";
});

function rail() {
  const onUnfold = jest.fn<(tab: AsideTab | null) => void>();
  const onSearch = jest.fn<() => void>();
  const map = { open: false, openMap: jest.fn(), closeMap: jest.fn(), toggle: jest.fn() } as unknown as MapRoute;
  const mail: MailRoute = { open: false, workspaceId: "w1", openMail: jest.fn(), openThread: jest.fn(), closeMail: jest.fn(), toggle: jest.fn() };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const tabs = RAIL_PANEL_APPS.filter((tab) => tab !== "note");
  act(() =>
    root.render(
      createElement(
        MapRouteProvider,
        { value: map },
        createElement(
          MailRouteProvider,
          { value: mail },
          createElement(AsideStrip, { tabs, showing: "meetings", recording: false, open: true, onUnfold, onSearch }),
        ),
      ),
    ),
  );
  unmounts.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  const strip = container.querySelector<HTMLElement>('[data-testid="aside-strip"]')!;
  const order = Array.from(strip.children).map((c) => c.getAttribute("data-testid") ?? "");
  const press = (id: string) =>
    act(() => {
      strip.querySelector(`[data-testid="${id}"]`)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  return { order, press, onUnfold, onSearch, map, mail, tabs };
}

/** The rail's own name for a button, back to the app it opens. */
function appOf(testID: string): RailApp | null {
  const key = testID.replace(/^aside-(strip|tab)-/, "");
  return (RAIL_PAGE_APPS as readonly string[]).includes(key) || (ASIDE_TABS.map((t) => t.key) as string[]).includes(key) ? (key as RailApp) : null;
}

describe("the rail's rule: full pages above, side panels below", () => {
  test("every app above the rule opens a page, every app below it opens in the panel", () => {
    const r = rail();
    const rule = r.order.indexOf("aside-strip-rule");
    expect(rule).toBeGreaterThan(0);
    const above = r.order.slice(1, rule).map(appOf);
    const below = r.order.slice(rule + 1).map(appOf);
    expect(above).toEqual([...RAIL_PAGE_APPS]);
    expect(below).toEqual(r.tabs);
    for (const app of above) expect(railOpens(app!)).toBe("page");
    for (const app of below) expect(railOpens(app!)).toBe("panel");
  });

  test("a page app never opens the panel; a panel app always does", () => {
    const r = rail();
    r.press("aside-strip-map");
    r.press("aside-strip-mail");
    r.press("aside-strip-search");
    expect(r.onUnfold).not.toHaveBeenCalled();
    expect(r.map.toggle).toHaveBeenCalledTimes(1);
    expect(r.mail.toggle).toHaveBeenCalledTimes(1);
    expect(r.onSearch).toHaveBeenCalledTimes(1);
    r.press("aside-tab-tex");
    expect(r.onUnfold).toHaveBeenCalledWith("tex");
  });

  test("no app is on both sides, and every full page but search is one a sidebar click leaves", () => {
    for (const app of RAIL_PAGE_APPS) expect(RAIL_PANEL_APPS).not.toContain(app);
    // `leaveFullPages` closes these; search is the ⌘K palette, which closes itself.
    const left: Record<Exclude<(typeof RAIL_PAGE_APPS)[number], "search">, keyof FullPages> = { map: "map", mail: "mail" };
    expect(Object.keys(left).sort()).toEqual(RAIL_PAGE_APPS.filter((app) => app !== "search").sort());
  });
});
