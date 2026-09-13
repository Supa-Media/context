/**
 * @jest-environment jsdom
 */

/**
 * Browsing the registry, and the control a vault plugin must never be offered.
 *
 * The pure module decides both; these two components are where that decision
 * becomes a button somebody can press. Mutations that were green with only
 * `pluginLifecycle.test.ts`:
 *
 *  - `PluginManagedCard` rendering for a vault row, which is a Remove over a
 *    file in `.obsidian/`;
 *  - the browse card fetching a third party's registry on mount;
 *  - a single-press Remove;
 *  - install ignoring what is already in the bucket, so an update reads as a
 *    first install.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { PluginBrowse } from "../features/console/settings/panels/PluginBrowse";
import { PluginManagedCard } from "../features/console/settings/panels/PluginManagedCard";
import type { BrowseView, CommunityPlugin } from "../features/console/plugins/lifecycle";
import type { ConsolePlugin } from "../features/console/plugins/plugins";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

const searched: string[] = [];
const installed: string[] = [];
const removed: string[] = [];

function actions(): BrowseView["actions"] {
  return {
    search: async (query) => {
      searched.push(query);
    },
    install: async (pluginId) => {
      installed.push(pluginId);
    },
    uninstall: async (pluginId, fingerprint) => {
      removed.push(`${pluginId}@${fingerprint}`);
    },
    recover: async () => {},
  };
}

function plugin(over: Partial<ConsolePlugin> & { id: string }): ConsolePlugin {
  return {
    source: "obsidian",
    bundleFingerprint: `fp-${over.id}`,
    name: over.name ?? over.id,
    verdict: "runs",
    evidence: [],
    limitations: [],
    notes: [],
    ...over,
  };
}

const row: CommunityPlugin = {
  id: "highlightr-plugin",
  name: "Highlightr",
  author: "Chetachi",
  description: "Highlight text in several colours.",
  repository: "chetachiezikeuzor/Highlightr-Plugin",
};

function mount(element: ReactElement): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(element);
  });
  return container;
}

function press(container: HTMLElement, name: string) {
  const target = Array.from(container.querySelectorAll("[role='button']")).find((node) =>
    ((node.getAttribute("aria-label") ?? node.textContent) ?? "").includes(name),
  );
  if (!target) throw new Error(`no control named ${name}`);
  act(() => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("a vault plugin is offered nothing that writes", () => {
  test("no card at all for a vault row", () => {
    const container = mount(
      createElement(PluginManagedCard, {
        plugin: plugin({ id: "obsidian-git" }),
        view: { query: "", searching: false, failure: null, actions: actions() },
      }),
    );
    expect(container.textContent).toBe("");
  });

  test("a managed install gets Remove, and says what Remove keeps", () => {
    const container = mount(
      createElement(PluginManagedCard, {
        plugin: plugin({ id: "highlightr-plugin", source: "context" }),
        view: { query: "", searching: false, failure: null, actions: actions() },
      }),
    );
    expect(container.textContent).toContain("stays in your");
    expect(container.textContent).toContain("Remove from Context");
  });

  test("removing takes two presses, and carries the exact fingerprint", () => {
    removed.length = 0;
    const container = mount(
      createElement(PluginManagedCard, {
        plugin: plugin({ id: "highlightr-plugin", source: "context" }),
        view: { query: "", searching: false, failure: null, actions: actions() },
      }),
    );
    press(container, "Remove from Context");
    expect(removed).toHaveLength(0);
    press(container, "press again");
    expect(removed).toEqual(["highlightr-plugin@fp-highlightr-plugin"]);
  });

  test("a viewer with no actions is offered nothing", () => {
    const container = mount(
      createElement(PluginManagedCard, {
        plugin: plugin({ id: "highlightr-plugin", source: "context" }),
        view: { query: "", searching: false, failure: null },
      }),
    );
    expect(container.textContent).toBe("");
  });
});

describe("the registry is not fetched until somebody asks", () => {
  const view = (over: Partial<BrowseView> = {}): BrowseView => ({
    query: "",
    searching: false,
    failure: null,
    actions: actions(),
    ...over,
  });

  test("closed on arrival, with no search sent", () => {
    searched.length = 0;
    const container = mount(
      createElement(PluginBrowse, { view: view(), installed: [] }),
    );
    expect(container.querySelector("[data-testid='plugin-browse-closed']")).not.toBeNull();
    expect(container.querySelector("[data-testid='plugin-browse']")).toBeNull();
    expect(searched).toHaveLength(0);
  });

  test("opening still sends nothing — the search is a press of its own", () => {
    searched.length = 0;
    const container = mount(createElement(PluginBrowse, { view: view(), installed: [] }));
    press(container, "Browse");
    expect(container.querySelector("[data-testid='plugin-browse']")).not.toBeNull();
    expect(searched).toHaveLength(0);
  });

  test("a viewer with no actions gets no entry point at all", () => {
    const container = mount(
      createElement(PluginBrowse, { view: view({ actions: undefined }), installed: [] }),
    );
    expect(container.textContent).toBe("");
  });
});

describe("a result says what installing it would do to this bucket", () => {
  const opened = (installedPlugins: ConsolePlugin[]) => {
    const container = mount(
      createElement(PluginBrowse, {
        view: {
          query: "high",
          searching: false,
          failure: null,
          results: [row],
          actions: actions(),
        },
        installed: installedPlugins,
      }),
    );
    press(container, "Browse");
    return container;
  };

  test("nothing installed reads as Install", () => {
    expect(opened([]).textContent).toContain("Install");
  });

  test("already managed reads as an update", () => {
    const container = opened([plugin({ id: "highlightr-plugin", source: "context" })]);
    expect(container.textContent).toContain("Update to the latest release");
    expect(container.textContent).toContain("Installed here");
  });

  test("already in the vault says a second, managed copy", () => {
    const container = opened([plugin({ id: "highlightr-plugin", source: "obsidian" })]);
    expect(container.textContent).toContain("Also install a managed copy");
    expect(container.textContent).toContain("In your vault");
  });

  test("installing sends the id, and the note says it will not run it", () => {
    installed.length = 0;
    const container = opened([]);
    press(container, "Install");
    expect(installed).toEqual(["highlightr-plugin"]);
    expect(container.textContent).toContain("does not run it");
  });

  test("a refused search or install keeps the server's own words", () => {
    const container = mount(
      createElement(PluginBrowse, {
        view: {
          query: "x",
          searching: false,
          failure: "That plugin is not in the official registry",
          results: [],
          actions: actions(),
        },
        installed: [],
      }),
    );
    press(container, "Browse");
    expect(container.textContent).toContain("That plugin is not in the official registry");
  });
});
