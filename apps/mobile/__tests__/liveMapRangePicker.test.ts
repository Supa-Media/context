/**
 * @jest-environment jsdom
 */

/**
 * The map's controls and the custom range picker, as a person meets them. On a
 * desktop every control is in one dock at the bottom of the map (Dev2 picked
 * it, 2026-10-14): Live, Replay with its stretches in a menu, Map or Columns,
 * and zoom; the workspace menu in the top left stands for the breadcrumb and
 * the scope pills. Pick dates opens the picker, whose Replay hands the stretch
 * to the page, and Escape closes it. On a phone the calendar segment is the
 * same picker, named "Pick a stretch of time".
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

// The days hook mints a grant through Convex; with no endpoint it asks nothing.
jest.mock("convex/react", () => ({ useAction: () => async () => null }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom reports a zero-wide window, which is a phone: pin a desktop one so
// the menus are popovers, and dispatch the resize that drops the cached size.
function desktopWindow(): void {
  Object.defineProperty(document.documentElement, "clientWidth", { value: 1440, configurable: true });
  Object.defineProperty(document.documentElement, "clientHeight", { value: 900, configurable: true });
  Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });
  window.dispatchEvent(new Event("resize"));
}

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { MapPageState } from "../features/console/map/live/hooks/useMapPage";
import { MapBar } from "../features/console/map/live/ui/MapBar";
import { MapDock, WorkspaceMenu } from "../features/console/map/live/ui/MapDock";
import { createCameraStore } from "../features/console/map/live/ui/CanvasOverlay";
import { RangePicker } from "../features/console/map/live/ui/RangePicker";
import { DAY_MS, startOfDay, type Stretch } from "../features/console/map/live/replayClock";

const NOW = new Date(2026, 9, 13, 15, 30).getTime();

function pageWith(extra: Record<string, unknown> = {}) {
  const calls: { playStretch: Stretch[]; setMode: string[]; setView: string[]; setScope: string[] } = { playStretch: [], setMode: [], setView: [], setScope: [] };
  const page = {
    mode: "live",
    setMode: (m: string) => calls.setMode.push(m),
    view: "map",
    setView: (v: string) => calls.setView.push(v),
    scope: "one",
    setScope: (s: string) => calls.setScope.push(s),
    many: true,
    reducedMotion: true,
    follow: null,
    custom: null,
    replay: null,
    historyLoading: false,
    selected: { id: "ws-a", slug: "seyi", displayName: "seyi", kind: "personal" },
    workspaces: [
      { id: "ws-a", slug: "seyi", displayName: "seyi", kind: "personal" },
      { id: "ws-b", slug: "supa", displayName: "Supa", kind: "shared" },
    ],
    engineRef: { current: null },
    now: NOW,
    events: [],
    workspaceIds: ["ws-a"],
    historyEndpoint: null,
    localHistoryDays: null,
    playStretch: (s: Stretch) => calls.playStretch.push(s),
    ...extra,
  } as unknown as MapPageState;
  return { page, calls };
}

const roots: Root[] = [];
async function mount(element: ReturnType<typeof createElement>) {
  desktopWindow();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(element));
  return host;
}
const find = (host: ParentNode, testID: string) => host.querySelector(`[data-testid="${testID}"]`) as HTMLElement | null;

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = "";
});

const press = async (el: Element | null) => {
  expect(el).not.toBeNull();
  await act(async () => {
    (el as HTMLElement).click();
    // `measureInWindow` answers on the next frame.
    await new Promise((r) => setTimeout(r, 30));
  });
};

describe("the desktop dock", () => {
  test("holds Live, Replay, Map, Columns and zoom in one row, and no stretch until Replay is pressed", async () => {
    const { page } = pageWith();
    const host = await mount(createElement(MapDock, { page }));
    const text = host.textContent ?? "";
    for (const word of ["Live", "Replay", "Map", "Columns"]) expect(text).toContain(word);
    expect(text).not.toContain("Folders");
    expect(text).not.toContain("Past week");
    expect(find(host, "map-zoom-in")).not.toBeNull();
    expect(find(host, "map-zoom-out")).not.toBeNull();
    expect(find(host, "map-replay-bar")).toBeNull();
  });

  test("Replay opens the past 24 hours, the past week and Pick dates, and a pick plays it", async () => {
    const { page, calls } = pageWith();
    const host = await mount(createElement(MapDock, { page }));
    await press(find(host, "map-replay"));
    const menu = document.body.textContent ?? "";
    expect(menu).toContain("Past 24 hours");
    expect(menu).toContain("Pick dates…");
    await press(find(document.body, "map-when-week"));
    expect(calls.setMode).toEqual(["week"]);
  });

  test("Pick dates opens the range picker rather than playing anything", async () => {
    const { page, calls } = pageWith();
    const host = await mount(createElement(MapDock, { page }));
    await press(find(host, "map-replay"));
    await press(find(document.body, "map-when-custom"));
    expect(calls.setMode).toEqual([]);
    expect(find(document.body, "map-range-picker")).not.toBeNull();
  });

  test("while a stretch plays, the Replay button names it and the replay bar opens in the dock", async () => {
    const from = startOfDay(NOW - 11 * DAY_MS);
    const { page } = pageWith({ mode: "custom", custom: { from, to: NOW, open: true } });
    const host = await mount(createElement(MapDock, { page }));
    expect(find(host, "map-replay")!.textContent).toContain("– now");
    expect(find(host, "map-replay-bar")).not.toBeNull();
    await press(find(host, "map-when-live"));
  });

  test("Columns has nothing to zoom, so it has no − and +", async () => {
    const { page, calls } = pageWith({ view: "folders" });
    const host = await mount(createElement(MapDock, { page }));
    expect(find(host, "map-zoom-in")).toBeNull();
    await press(find(host, "map-view-map"));
    expect(calls.setView).toEqual(["map"]);
  });
});

describe("the workspace menu", () => {
  test("names the workspace drawn, and lists every workspace and All my workspaces", async () => {
    const { page } = pageWith();
    const picked: string[] = [];
    const host = await mount(createElement(WorkspaceMenu, { page, camera: createCameraStore(), onSelectWorkspace: (id: string) => picked.push(id) }));
    expect(find(host, "map-scope")!.textContent).toContain("seyi");
    await press(find(host, "map-scope"));
    expect(find(document.body, "map-scope-ws-supa")).not.toBeNull();
    await press(find(document.body, "map-scope-ws-supa"));
    expect(picked).toEqual(["ws-b"]);
  });

  test("All my workspaces draws every workspace", async () => {
    const { page, calls } = pageWith();
    const host = await mount(createElement(WorkspaceMenu, { page, camera: createCameraStore(), onSelectWorkspace: () => {} }));
    await press(find(host, "map-scope"));
    await press(find(document.body, "map-scope-all"));
    expect(calls.setScope).toEqual(["all"]);
  });

  test("with one workspace there is nothing to choose, so it is a label", async () => {
    const { page } = pageWith({ many: false });
    const host = await mount(createElement(WorkspaceMenu, { page, camera: createCameraStore(), onSelectWorkspace: () => {} }));
    expect(find(host, "map-scope")!.getAttribute("role")).not.toBe("button");
  });
});

describe("the phone bar", () => {
  test("the calendar segment is named for what it does, and offers no words while no stretch is picked", async () => {
    const { page } = pageWith();
    const host = await mount(createElement(MapBar, { page }));
    const calendar = find(host, "map-when-custom")!;
    expect(calendar.getAttribute("aria-label")).toBe("Pick a stretch of time");
    expect(host.textContent).toContain("24h");
    expect(host.textContent).toContain("Week");
    expect(host.textContent).toContain("This one");
  });
});

describe("the range picker", () => {
  test("Replay hands the stretch to the page, from the first day to now, and closes", async () => {
    const { page, calls } = pageWith();
    let closed = 0;
    await mount(createElement(RangePicker, { page, compact: false, anchor: null, onClose: () => closed++ }));
    const title = document.body.textContent ?? "";
    expect(title).toContain("Replay a stretch of time");
    expect(title).toContain("Nothing has happened here yet");
    expect(title).toContain("0 changes · plays in 30 s");
    const replay = Array.from(document.querySelectorAll('[role="button"]')).find((b) => b.textContent === "Replay")!;
    await act(async () => (replay as HTMLElement).click());
    expect(calls.playStretch).toHaveLength(1);
    expect(calls.playStretch[0]).toMatchObject({ open: true });
    expect(closed).toBe(1);
  });

  test("Escape closes it", async () => {
    const { page } = pageWith();
    let closed = 0;
    await mount(createElement(RangePicker, { page, compact: false, anchor: null, onClose: () => closed++ }));
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(closed).toBe(1);
  });
});
