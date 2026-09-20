/**
 * @jest-environment jsdom
 */

/**
 * A plugin's own status bar, drawn by the console.
 *
 * The first thing in this section that puts a plugin's **own words** on the
 * screen. Everything before it was the console's sentence about a plugin — a
 * pill, a count, a list of names it read out — and the rule those obeyed was
 * that nothing is claimed the server did not say. This obeys a second one: the
 * text is the plugin's, so it is marked as the plugin's, bounded before it
 * arrives, and drawn with the console's own components rather than the plugin's
 * markup. The element never leaves the sandbox; only what it says does.
 *
 * The guest half — that the shim reports the text at all, and stops when the
 * plugin is unloaded — is proven in `pluginSandboxGuest.test.ts` against the
 * real shim. This is the half that puts it on a card.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { PluginRuntimeCard } from "../features/console/settings/panels/PluginRuntimeCard";
import { STATUS_BAR_NOTE, statusItemsFor } from "../features/console/plugins/runtime";
import type { RuntimeState, RuntimeView } from "../features/console/plugins/runtime";
import type { GrantsView } from "../features/console/plugins/grants";
import type { ConsolePlugin } from "../features/console/plugins/plugins";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

const PLUGIN: ConsolePlugin = {
  id: "obsidian-tasks-plugin",
  source: "obsidian",
  bundleFingerprint: "fp-1",
  name: "Tasks",
  verdict: "runs",
  evidence: [],
  limitations: [],
  notes: [],
};

const GRANTS: GrantsView = {
  loading: false,
  egress: false,
  grants: [{
    pluginId: "obsidian-tasks-plugin",
    bundleFingerprint: "fp-1",
    capabilities: ["vault:read"],
    networkHosts: [],
    status: "active",
    grantedAt: 1,
    updatedAt: 1,
  }],
};

const LOADED: RuntimeState = {
  pluginId: "obsidian-tasks-plugin",
  bundleFingerprint: "fp-1",
  status: "loaded",
  attempts: 1,
  updatedAt: 1,
};

function render(view: RuntimeView) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(createElement(PluginRuntimeCard, { plugin: PLUGIN, view, grants: GRANTS }));
  });
  roots.push(() => act(() => root.unmount()));
  return host;
}

describe("a status bar item belongs to a frame that exists", () => {
  const items = [{ id: "status-1", text: "412 words" }];

  test("a loaded plugin's items are shown", () => {
    expect(statusItemsFor(LOADED, { "obsidian-tasks-plugin": items })).toEqual(items);
  });

  /*
    The same rule `registrationsFor` keeps, and for the same reason. A status
    bar item is a live reading — "412 words", "syncing" — and one left on screen
    for a plugin that has stopped is not stale, it is false: nothing is counting
    those words any more.
  */
  test("a stopped plugin's items are not, whatever is left in the map", () => {
    const stopped: RuntimeState = { ...LOADED, status: "blocked", errorCode: "OWNER_DISABLED" };
    expect(statusItemsFor(stopped, { "obsidian-tasks-plugin": items })).toEqual([]);
  });

  test("a plugin that has added nothing has nothing", () => {
    expect(statusItemsFor(LOADED, {})).toEqual([]);
    expect(statusItemsFor(LOADED, undefined)).toEqual([]);
  });
});

describe("the console draws what the plugin says", () => {
  test("each item is on the card, and marked as the plugin's own words", () => {
    const host = render({
      loading: false,
      states: [LOADED],
      statusItems: {
        "obsidian-tasks-plugin": [
          { id: "status-1", text: "412 words" },
          { id: "status-2", text: "3 tasks due" },
        ],
      },
    });
    const bar = host.querySelector('[data-testid="plugin-status-bar-obsidian-tasks-plugin"]');
    expect(bar).not.toBeNull();
    expect(bar?.textContent).toContain("412 words");
    expect(bar?.textContent).toContain("3 tasks due");
    /*
      The marking is the point rather than decoration. This is the first text in
      the console written by third-party code, and a reader who takes "412
      words" for something Context measured has been misled by the frame it was
      put in.
    */
    expect(bar?.textContent).toContain(STATUS_BAR_NOTE);
  });

  test("a plugin with no status bar gets no empty row", () => {
    const host = render({ loading: false, states: [LOADED], statusItems: {} });
    expect(host.querySelector('[data-testid="plugin-status-bar-obsidian-tasks-plugin"]')).toBeNull();
  });

  test("a stopped plugin's status bar is off the card, not merely stale", () => {
    const host = render({
      loading: false,
      states: [{ ...LOADED, status: "blocked", errorCode: "OWNER_DISABLED" }],
      statusItems: { "obsidian-tasks-plugin": [{ id: "status-1", text: "412 words" }] },
    });
    expect(host.querySelector('[data-testid="plugin-status-bar-obsidian-tasks-plugin"]')).toBeNull();
  });
});
