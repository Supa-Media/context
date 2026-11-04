/**
 * @jest-environment jsdom
 */

/**
 * The map's controls and the custom range picker, as a person meets them. On a
 * desktop every control is in one dock at the bottom of the map (Dev2 picked
 * it, 2026-10-14): Map or Columns and zoom; the workspace menu in the top
 * left stands for the breadcrumb and the scope pills. The replay moved into
 * the map's settings (Dev2, 2026-11-04): Live, the past 24 hours, the past
 * week and Pick dates, which opens the picker, whose Replay hands the stretch
 * to the page, and Escape closes it. While replaying, the dock (or the phone
 * bar) keeps a way back to live.
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
import { MapSettings } from "../features/console/map/live/ui/MapSettings";
import { DEFAULT_LOOK } from "../features/console/map/live/look";
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
  test("holds Map, Columns and zoom; the replay lives in the map's settings now", async () => {
    const { page } = pageWith();
    const host = await mount(createElement(MapDock, { page }));
    const text = host.textContent ?? "";
    for (const word of ["Map", "Columns"]) expect(text).toContain(word);
    expect(text).not.toContain("Replay");
    expect(text).not.toContain("Past week");
    expect(find(host, "map-zoom-in")).not.toBeNull();
    expect(find(host, "map-zoom-out")).not.toBeNull();
    expect(find(host, "map-replay-bar")).toBeNull();
    expect(find(host, "map-when-live")).toBeNull();
  });

  test("while a stretch plays, the replay bar opens in the dock with a way back to live", async () => {
    const from = startOfDay(NOW - 11 * DAY_MS);
    const { page, calls } = pageWith({ mode: "custom", custom: { from, to: NOW, open: true } });
    const host = await mount(createElement(MapDock, { page }));
    expect(find(host, "map-replay-bar")).not.toBeNull();
    await press(find(host, "map-when-live"));
    expect(calls.setMode).toEqual(["live"]);
  });

  test("Columns has nothing to zoom, so it has no − and +", async () => {
    const { page, calls } = pageWith({ view: "folders" });
    const host = await mount(createElement(MapDock, { page }));
    expect(find(host, "map-zoom-in")).toBeNull();
    await press(find(host, "map-view-map"));
    expect(calls.setView).toEqual(["map"]);
  });
});

describe("the map's settings", () => {
  const withLook = (extra: Record<string, unknown> = {}) => {
    const looks: Array<Record<string, unknown>> = [];
    let resets = 0;
    const made = pageWith({ look: { ...DEFAULT_LOOK }, setLook: (p: Record<string, unknown>) => looks.push(p), resetLook: () => resets++, ...extra });
    return { ...made, looks, resets: () => resets };
  };

  test("Replay offers Live, the past 24 hours, the past week, and a pick plays it", async () => {
    const { page, calls } = withLook();
    const host = await mount(createElement(MapSettings, { page, compact: false, onClose: () => {} }));
    const text = host.textContent ?? "";
    for (const word of ["Live", "Past 24 hours", "Past week", "Pick dates…"]) expect(text).toContain(word);
    expect(find(host, "map-settings-when-live")!.getAttribute("aria-checked")).toBe("true");
    await press(find(host, "map-settings-when-week"));
    expect(calls.setMode).toEqual(["week"]);
  });

  test("Pick dates opens the range picker rather than playing anything", async () => {
    const { page, calls } = withLook();
    const host = await mount(createElement(MapSettings, { page, compact: false, onClose: () => {} }));
    await press(find(host, "map-settings-pick-dates"));
    expect(calls.setMode).toEqual([]);
    expect(find(document.body, "map-range-picker")).not.toBeNull();
  });

  test("a picked stretch shows no preset as chosen, and offers other dates", async () => {
    const from = startOfDay(NOW - 11 * DAY_MS);
    const { page } = withLook({ mode: "custom", custom: { from, to: NOW, open: true } });
    const host = await mount(createElement(MapSettings, { page, compact: false, onClose: () => {} }));
    for (const v of ["live", "day", "week"]) expect(find(host, `map-settings-when-${v}`)!.getAttribute("aria-checked")).toBe("false");
    expect(find(host, "map-settings-pick-dates")!.textContent).toBe("Other dates…");
  });

  test("a board and a choice of names change the look, and Restore defaults resets it", async () => {
    const made = withLook();
    const host = await mount(createElement(MapSettings, { page: made.page, compact: false, onClose: () => {} }));
    expect(find(host, "map-settings-board-auto")!.getAttribute("aria-checked")).toBe("true");
    await press(find(host, "map-settings-board-chalk"));
    await press(find(host, "map-settings-names-hover"));
    expect(made.looks).toEqual([{ board: "chalk" }, { names: "hover" }]);
    await press(find(host, "map-settings-reset"));
    expect(made.resets()).toBe(1);
  });

  test("the show switches, colour and lines change the look", async () => {
    const made = withLook();
    const host = await mount(createElement(MapSettings, { page: made.page, compact: false, onClose: () => {} }));
    await press(find(host, "map-settings-archive"));
    await press(find(host, "map-settings-color-pressure"));
    await press(find(host, "map-settings-lines-near"));
    await press(find(host, "map-settings-merge"));
    expect(made.looks).toEqual([{ showArchive: true }, { colorBy: "pressure" }, { lines: "near" }, { mergeLines: false }]);
    expect(find(host, "map-settings-color-workspace")!.getAttribute("aria-checked")).toBe("true");
  });

  test("Find lists notes whose names hold the words, and a pick goes to it", async () => {
    const graphs = [
      { workspaceId: "ws-a", slug: "seyi", name: "seyi", kind: "personal", edges: [], nodes: [
        { path: "areas/bible/Romans 8.md", title: "Romans 8" },
        { path: "areas/bible/Romans 12.md", title: "Romans 12" },
        { path: "inbox/groceries.md", title: "Groceries" },
      ] },
    ];
    const made = withLook({ data: { graphs, scope: { kind: "one", workspaceId: "ws-a" } } });
    const found: Array<{ workspaceId: string; path: string }> = [];
    const host = await mount(createElement(MapSettings, { page: made.page, compact: false, onClose: () => {}, onFind: (n: { workspaceId: string; path: string }) => found.push(n) }));
    const input = find(host, "map-settings-find") as HTMLInputElement;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, "roma");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(find(host, "map-settings-find-areas/bible/Romans 8.md")).not.toBeNull();
    expect(find(host, "map-settings-find-inbox/groceries.md")).toBeNull();
    expect(host.textContent).toContain("areas › bible");
    await press(find(host, "map-settings-find-areas/bible/Romans 8.md"));
    expect(found).toEqual([{ workspaceId: "ws-a", path: "areas/bible/Romans 8.md" }]);
  });

  test("the movement and 3D depth change the look", async () => {
    const made = withLook();
    const host = await mount(createElement(MapSettings, { page: made.page, compact: false, onClose: () => {} }));
    await press(find(host, "map-settings-motion-still"));
    await press(find(host, "map-settings-depth"));
    expect(made.looks).toEqual([{ motion: "still" }, { depth: false }]);
  });

  test("shows Dev2's defaults, and the close button closes it", async () => {
    const { page } = withLook();
    let closed = 0;
    const host = await mount(createElement(MapSettings, { page, compact: false, onClose: () => closed++ }));
    const text = host.textContent ?? "";
    for (const v of ["0.55", "0.40", "0.65", "1.80", "11"]) expect(text).toContain(v);
    expect(find(host, "map-settings-names-busy")!.getAttribute("aria-checked")).toBe("true");
    await press(find(host, "map-settings-close"));
    expect(closed).toBe(1);
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
  test("holds the layout, the workspaces and the gear; Back to live only while replaying", async () => {
    const { page } = pageWith();
    let opened = 0;
    const host = await mount(createElement(MapBar, { page, onSettings: () => opened++ }));
    expect(host.textContent).toContain("This one");
    expect(find(host, "map-when-live")).toBeNull();
    await press(find(host, "map-settings-open"));
    expect(opened).toBe(1);
    const { page: replaying, calls } = pageWith({ mode: "week" });
    const again = await mount(createElement(MapBar, { page: replaying, onSettings: () => {} }));
    await press(find(again, "map-when-live"));
    expect(calls.setMode).toEqual(["live"]);
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
