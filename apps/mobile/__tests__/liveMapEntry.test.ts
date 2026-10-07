/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, test } from "@jest/globals";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { SafeAreaProvider, initialWindowMetrics } from "react-native-safe-area-context";
import { Explorer } from "../features/console/files/Explorer";
import { FileTree } from "../features/console/files/FileTree";
import type { TreeRow } from "../features/console/files/tree";
import { setMapFolderCounts } from "../features/console/map/live/mapCounts";
import type { FileBrowser } from "../features/console/files/browser";
import { emptyEditor } from "../features/console/files/editor";
import { PhoneHome } from "../features/console/home/PhoneHome";
import { HOME_LABEL, phoneBackTarget, slideDirection } from "../features/console/home/phoneBack";
import { MapRouteProvider, useLeaveMapOnOpen } from "../features/console/map/live/MapRouteContext";
import { mapFromQuery, mapHref, routeMap, type MapRoute } from "../features/console/map/live/route";
import { MAP_PAGE_KEY } from "../features/console/panes/browsePane/DocumentSurface";

/**
 * THE WAYS INTO THE LIVE MAP, AND OUT OF IT.
 *
 * The map is `?map=1` over Browse: a press on the sidebar's Map button (or
 * its place on the phone's Home) sets it, the same press or ‹ Home clears it,
 * and choosing a note in the tree leaves it. These are the claims
 * `features/app/reachability.ts` makes about it, proven by pressing.
 */

const METRICS =
  initialWindowMetrics ??
  ({ frame: { x: 0, y: 0, width: 1280, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } } as never);

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

const noop = () => {};

function mount(element: ReactElement): { rerender: (next: ReactElement) => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  const wrap = (el: ReactElement) => createElement(SafeAreaProvider, { initialMetrics: METRICS }, el);
  act(() => root.render(wrap(element)));
  return { rerender: (next) => act(() => root.render(wrap(next))) };
}

const byId = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);

function press(node: Element | null): void {
  if (node === null) throw new Error("nothing to press");
  act(() => {
    for (const type of ["mousedown", "mouseup", "click"]) node.dispatchEvent(new MouseEvent(type, { bubbles: true }));
  });
}

/** A router that writes down what it was asked to do. */
function recorder() {
  const calls: unknown[] = [];
  return {
    calls,
    router: {
      setParams: (params: Record<string, unknown>) => calls.push(["setParams", params]),
      push: (href: string) => calls.push(["push", href]),
    } as never,
  };
}

function browser(): FileBrowser {
  return {
    canEdit: true,
    loading: false,
    busy: false,
    listings: { "": { path: "", folderDefault: "private", truncated: false, manifestUsable: true, entries: [] } },
    expanded: new Set<string>(),
    toggleFolder: noop,
    selectedPath: null,
    select: noop,
    deselect: () => true,
    editor: emptyEditor,
    notice: null,
    toasts: [],
    collapseAll: noop,
    createUntitled: noop,
  } as unknown as FileBrowser;
}

describe("the map's address", () => {
  test("is ?map=1 on the workspace, and nothing else opens it", () => {
    expect(mapHref("seyi")).toBe("/console/@seyi?map=1");
    expect(mapFromQuery("1")).toBe(true);
    expect(mapFromQuery(["1"])).toBe(true);
    for (const value of [undefined, "", "0", "true", "yes"]) expect(mapFromQuery(value)).toBe(false);
  });

  test("opening it closes What changed and Settings; closing clears only its own key", () => {
    const { calls, router } = recorder();
    routeMap(router, false).openMap();
    routeMap(router, true).closeMap();
    expect(calls).toEqual([
      ["setParams", { map: "1", changes: undefined, settings: undefined }],
      ["setParams", { map: undefined }],
    ]);
  });

  test("the button's one press opens it when closed and closes it when open", () => {
    const { calls, router } = recorder();
    routeMap(router, false).toggle();
    routeMap(router, true).toggle();
    expect(calls).toEqual([
      ["setParams", { map: "1", changes: undefined, settings: undefined }],
      ["setParams", { map: undefined }],
    ]);
  });

  test("a note in another workspace opens at its own address", () => {
    const { calls, router } = recorder();
    routeMap(router, true).openNoteIn("supa", "1-projects/launch.md");
    expect(calls).toEqual([["push", "/console/@supa?note=1-projects%2Flaunch.md"]]);
  });

  test("choosing a note in the tree leaves the map, and the first draw does not", () => {
    const closed: string[] = [];
    const route: MapRoute = { open: true, openMap: noop, closeMap: () => closed.push("close"), toggle: noop, openNoteIn: noop };
    function Probe({ path }: { path: string | null }) {
      useLeaveMapOnOpen(route, path);
      return null;
    }
    const view = mount(createElement(Probe, { path: "1-projects/a.md" }));
    expect(closed).toEqual([]);
    view.rerender(createElement(Probe, { path: "1-projects/b.md" }));
    expect(closed).toEqual(["close"]);
    // Going back to nothing selected (Home) is not choosing a note.
    view.rerender(createElement(Probe, { path: null }));
    expect(closed).toEqual(["close"]);
  });
});

describe("the Map button in the sidebar's top row", () => {
  function explorerWith(route: MapRoute | undefined) {
    const explorer = createElement(Explorer, { files: browser(), contextLabel: "@somebody" });
    return route === undefined ? explorer : createElement(MapRouteProvider, { value: route }, explorer);
  }
  const route = (open: boolean, toggled: string[] = []): MapRoute => ({
    open,
    openMap: noop,
    closeMap: noop,
    toggle: () => toggled.push(open ? "close" : "open"),
    openNoteIn: noop,
  });

  test("sits after View options, and a press toggles the map", () => {
    const toggled: string[] = [];
    mount(explorerWith(route(false, toggled)));
    const tools = [...document.body.querySelectorAll("[data-testid^='explorer-']")].map((n) => n.getAttribute("data-testid"));
    expect(tools.indexOf("explorer-map")).toBeGreaterThan(tools.indexOf("explorer-view"));
    expect(byId("explorer-map")?.getAttribute("aria-label")).toBe("Map");
    press(byId("explorer-map"));
    expect(toggled).toEqual(["open"]);
  });

  test("is lit while the map is open, and then says it closes it", () => {
    // The lit look is the toolbar's own `iconButtonOn`, which the New and View menus use while open.
    const look = (node: HTMLElement) => `${node.className}|${node.getAttribute("style") ?? ""}`;
    mount(explorerWith(route(false)));
    const closedLook = look(byId("explorer-map")!);
    while (roots.length > 0) roots.pop()!();
    mount(explorerWith(route(true)));
    const map = byId("explorer-map")!;
    expect(map.getAttribute("aria-label")).toBe("Close the map");
    expect(look(map)).not.toBe(closedLook);
  });

  test("is not drawn outside the console layout, where nothing could open the map", () => {
    mount(explorerWith(undefined));
    expect(byId("explorer-header")).not.toBeNull();
    expect(byId("explorer-map")).toBeNull();
  });
});

describe("the map on a phone", () => {
  function home(onOpenMap?: () => void) {
    return createElement(PhoneHome, {
      title: "Seyi",
      source: { notes: [], folders: [], shared: new Set<string>() },
      pins: [],
      opened: [],
      recents: [],
      onOpen: noop,
      onTogglePin: null,
      onOpenMap,
    });
  }

  test("is a place on Home that opens it", () => {
    const opened: string[] = [];
    mount(home(() => opened.push("map")));
    expect(byId("phone-home-map")?.textContent).toContain("Map");
    press(byId("phone-home-map"));
    expect(opened).toEqual(["map"]);
  });

  test("has no place on Home where there is no map (a visitor, the demo)", () => {
    mount(home(undefined));
    expect(byId("phone-home")).not.toBeNull();
    expect(byId("phone-home-map")).toBeNull();
  });

  test("goes back to Home, whatever is selected under it", () => {
    expect(phoneBackTarget(null, true)).toEqual({ folder: null, label: HOME_LABEL });
    expect(phoneBackTarget("1-projects/launch/plan.md", true)).toEqual({ folder: null, label: HOME_LABEL });
    // And with the map closed, back is what it always was.
    expect(phoneBackTarget(null, false)).toBeNull();
  });

  test("slides forward in from Home and back out to it", () => {
    expect(slideDirection("", MAP_PAGE_KEY)).toBe("forward");
    expect(slideDirection(MAP_PAGE_KEY, "")).toBe("back");
  });
});

describe("the tree's folder counts while the map is open", () => {
  const folder = (path: string, depth: number): TreeRow => ({
    kind: "folder",
    key: path,
    path,
    name: path.split("/").pop()!,
    label: path.split("/").pop()!,
    depth,
    expanded: false,
    selected: false,
    markerIsDefault: false,
    readOnly: false,
  });
  const tree = (workspaceId: string | null) =>
    createElement(FileTree, {
      rows: [folder("0-inbox", 0), folder("1-projects", 0), folder("1-projects/launch", 1)],
      canSetVisibility: false,
      onSelect: noop,
      onToggle: noop,
      onCycleVisibility: noop,
      workspaceId,
    });
  const counts = () => [...document.body.querySelectorAll("[data-testid='tree-map-count']")].map((n) => n.textContent);
  afterEach(() => act(() => setMapFolderCounts(null)));

  test("are not drawn at all while the map is shut", () => {
    mount(tree("ws-1"));
    expect(counts()).toEqual([]);
  });

  test("put the map's number on every top folder alike, and none on a subfolder", () => {
    mount(tree("ws-1"));
    act(() => setMapFolderCounts({ workspaceId: "ws-1", byRoot: { "0-inbox": 12, "1-projects": 34 } }));
    expect(counts()).toEqual(["12", "34"]);
    // The replay winds them back: the rows follow the playhead.
    act(() => setMapFolderCounts({ workspaceId: "ws-1", byRoot: { "0-inbox": 3 } }));
    expect(counts()).toEqual(["3", "0"]);
    act(() => setMapFolderCounts(null));
    expect(counts()).toEqual([]);
  });

  test("never show one workspace's numbers in another's tree", () => {
    mount(tree("ws-2"));
    act(() => setMapFolderCounts({ workspaceId: "ws-1", byRoot: { "0-inbox": 12 } }));
    expect(counts()).toEqual([]);
  });
});
