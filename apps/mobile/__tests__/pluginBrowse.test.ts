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
import {
  PluginBrowse,
  REGISTRY_DEBOUNCE_MS,
} from "../features/console/settings/panels/PluginBrowse";
import { PluginManagedCard } from "../features/console/settings/panels/PluginManagedCard";
import type { BrowseView, CommunityPlugin } from "../features/console/plugins/lifecycle";
import type { ConsolePlugin } from "../features/console/plugins/plugins";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

const searched: string[] = [];
/** `query|limit` per call, so "show more" can be told from a fresh search. */
const searchedWithLimit: string[] = [];
const installed: string[] = [];
const removed: string[] = [];

function actions(): BrowseView["actions"] {
  return {
    search: async (query, limit) => {
      searched.push(query);
      searchedWithLimit.push(`${query}|${limit ?? "default"}`);
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
        view: { query: "", limit: 20, searching: false, failure: null, actions: actions() },
      }),
    );
    expect(container.textContent).toBe("");
  });

  test("a managed install gets Remove, and says what Remove keeps", () => {
    const container = mount(
      createElement(PluginManagedCard, {
        plugin: plugin({ id: "highlightr-plugin", source: "context" }),
        view: { query: "", limit: 20, searching: false, failure: null, actions: actions() },
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
        view: { query: "", limit: 20, searching: false, failure: null, actions: actions() },
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
        view: { query: "", limit: 20, searching: false, failure: null },
      }),
    );
    expect(container.textContent).toBe("");
  });
});

describe("the registry is not fetched until somebody asks", () => {
  const view = (over: Partial<BrowseView> = {}): BrowseView => ({
    query: "",
    limit: 20,
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

  /*
    This test used to assert that opening sent nothing at all, and it was
    changed deliberately on 2026-09-14 rather than deleted.

    The rule it was written for — never fetch a third party's registry on mount,
    on a screen somebody came to read — is still held, by the test above: the
    card is closed on arrival and sends nothing. What changed is that pressing
    Browse now *is* the ask. Before, a person who did not already know the name
    of the plugin they wanted faced an empty box and could not browse at all.

    If this ever regresses to a fetch without a press, the test above reddens,
    which is the half that was ever about consent.
  */
  test("opening asks for the head of the registry, so there is something to browse", () => {
    searched.length = 0;
    searchedWithLimit.length = 0;
    const container = mount(createElement(PluginBrowse, { view: view(), installed: [] }));
    press(container, "Browse");
    expect(container.querySelector("[data-testid='plugin-browse']")).not.toBeNull();
    expect(searched).toEqual([""]);
    expect(searchedWithLimit).toEqual(["|20"]);
  });

  test("a viewer with no actions gets no entry point at all", () => {
    const container = mount(
      createElement(PluginBrowse, { view: view({ actions: undefined }), installed: [] }),
    );
    expect(container.textContent).toBe("");
  });
});

/*
  `PLUGIN_LIFECYCLE_BUSY` arrives for two opposite situations — an operation
  that is running, and one that stopped part-way — and nothing on the client can
  tell them apart. So both sentences are shown and the reader decides, rather
  than the console offering a recovery for a job that is simply still going.
*/
describe("a stuck lifecycle offers recovery, and only to the row it refused", () => {
  const refused = (over: Partial<BrowseView> = {}): BrowseView => ({
    query: "",
    limit: 20,
    searching: false,
    failure: "Plugin files are changing; try again when it finishes",
    failureCode: "PLUGIN_LIFECYCLE_BUSY",
    failedPluginId: "highlightr-plugin",
    actions: actions(),
    ...over,
  });

  test("both sentences are shown, so the reader picks which one they are in", () => {
    const container = mount(
      createElement(PluginManagedCard, {
        plugin: plugin({ id: "highlightr-plugin", source: "context" }),
        view: refused(),
      }),
    );
    expect(container.textContent).toContain("Wait for it to finish");
    expect(container.textContent).toContain("stopped part-way");
    expect(container.textContent).toContain("never deletes a note");
  });

  test("the control lands on the row that was refused, not on its neighbours", () => {
    const container = mount(
      createElement(PluginManagedCard, {
        plugin: plugin({ id: "obsidian-git", source: "context" }),
        view: refused(),
      }),
    );
    expect(container.querySelector("[data-testid='plugin-stuck-obsidian-git']")).toBeNull();
  });

  test("an unrelated refusal offers no recovery at all", () => {
    const container = mount(
      createElement(PluginManagedCard, {
        plugin: plugin({ id: "highlightr-plugin", source: "context" }),
        view: refused({ failureCode: "PLUGIN_NOT_FOUND" }),
      }),
    );
    expect(container.querySelector("[data-testid='plugin-stuck-highlightr-plugin']")).toBeNull();
  });

  test("recovering takes two presses", () => {
    const recovered: string[] = [];
    const container = mount(
      createElement(PluginManagedCard, {
        plugin: plugin({ id: "highlightr-plugin", source: "context" }),
        view: refused({
          actions: { ...actions()!, recover: async (id) => { recovered.push(id); } },
        }),
      }),
    );
    press(container, "It's stuck: recover");
    expect(recovered).toHaveLength(0);
    press(container, "Recover — press again");
    expect(recovered).toEqual(["highlightr-plugin"]);
  });
});

describe("a result says what installing it would do to this bucket", () => {
  const opened = (installedPlugins: ConsolePlugin[]) => {
    const container = mount(
      createElement(PluginBrowse, {
        view: {
          query: "high",
          limit: 20,
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
          limit: 20,
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

/*
  Slice 9: the registry had to become something a person can go *through*, not
  only something they can query. Four mutations these close, each of which was
  green before this block existed:

   - opening the card and showing an empty box, so somebody who does not know a
     plugin's name cannot find one (covered above, where the old assertion
     changed);
   - a keystroke sending a request, which re-downloads the whole community list
     per letter because nothing caches it server-side;
   - "Show more" on a page that is already the server's ceiling, which asks for
     rows that cannot come;
   - fifty rows presented as the list rather than as its first fifty.
*/
describe("the registry is browsable, not only searchable", () => {
  const rows = (count: number): CommunityPlugin[] =>
    Array.from({ length: count }, (_unused, index) => ({
      ...row,
      id: `plugin-${index}`,
      name: `Plugin ${index}`,
    }));

  const open = (over: Partial<BrowseView> = {}): HTMLElement => {
    const container = mount(
      createElement(PluginBrowse, {
        view: {
          query: "",
          limit: 20,
          searching: false,
          failure: null,
          actions: actions(),
          ...over,
        },
        installed: [],
      }),
    );
    press(container, "Browse");
    return container;
  };

  function type(container: HTMLElement, text: string) {
    const input = container.querySelector("input");
    if (!input) throw new Error("no search field");
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  test("typing does not reach the registry until it settles", () => {
    jest.useFakeTimers();
    try {
      searchedWithLimit.length = 0;
      const container = open({ results: rows(20) });
      // The opening search only.
      expect(searchedWithLimit).toEqual(["|20"]);

      type(container, "high");
      type(container, "highlight");
      expect(searchedWithLimit).toEqual(["|20"]);

      act(() => {
        jest.advanceTimersByTime(REGISTRY_DEBOUNCE_MS);
      });
      // One request for the two keystrokes, and the last text wins.
      expect(searchedWithLimit).toEqual(["|20", "highlight|20"]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a full page offers more, and asks for the ceiling rather than one more page", () => {
    searchedWithLimit.length = 0;
    const container = open({ results: rows(20), query: "note" });
    press(container, "Show more");
    expect(searchedWithLimit).toContain("note|50");
  });

  test("a short page is the end of the matches, so nothing offers more", () => {
    const container = open({ results: rows(4) });
    expect(container.querySelector("[data-testid='plugin-browse-more']")).toBeNull();
    expect(container.querySelector("[data-testid='plugin-browse-ceiling']")).toBeNull();
  });

  test("the ceiling says it is the first fifty, and stops offering more", () => {
    const container = open({ results: rows(50), limit: 50 });
    expect(container.querySelector("[data-testid='plugin-browse-more']")).toBeNull();
    expect(container.textContent).toContain("Showing the first 50");
  });

  test("an unsearched list says its order is not a ranking", () => {
    const container = open({ results: rows(20) });
    expect(container.textContent).toContain("not a popularity order");
  });

  test("a searched list drops that line, because the order is then a match order", () => {
    const container = open({ results: rows(3), query: "highlight" });
    expect(container.textContent).not.toContain("not a popularity order");
  });

  /*
    The bug this closes was in the first draft of this component and was found
    by reading the diff, not by a red test.

    `useLifecycle` rebuilds its `actions` object on every render, so a debounce
    that depended on it restarted its timer on every render of the console —
    and the console holds live subscriptions. A steady trickle of unrelated
    updates would reset the 350ms for ever and the search would never be sent,
    which looks exactly like a search box that does nothing.
  */
  test("unrelated re-renders do not keep pushing the debounce back", () => {
    jest.useFakeTimers();
    try {
      searchedWithLimit.length = 0;
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container, {
        onUncaughtError: () => {},
        onCaughtError: () => {},
      });
      roots.push(() => {
        act(() => root.unmount());
        container.remove();
      });
      // A fresh `actions` object each time, which is what the real hook does.
      const render = () =>
        act(() => {
          root.render(
            createElement(PluginBrowse, {
              view: {
                query: "",
                limit: 20,
                searching: false,
                failure: null,
                results: rows(20),
                actions: actions(),
              },
              installed: [],
            }),
          );
        });
      render();
      press(container, "Browse");
      searchedWithLimit.length = 0;

      const input = container.querySelector("input");
      if (!input) throw new Error("no search field");
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        )?.set;
        setter?.call(input, "dataview");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });

      /*
        Re-render every fifth of the window and never stop, for three windows'
        worth of time. There is deliberately no quiet period at the end: with
        the timer restarting on each render the search never goes out at all,
        and a test that waited quietly afterwards would watch the backlog fire
        and call the bug fixed. Sabotage proved that — the first version of
        this test passed with the dependency restored.
      */
      for (let tick = 0; tick < 15; tick += 1) {
        act(() => {
          jest.advanceTimersByTime(REGISTRY_DEBOUNCE_MS / 5);
        });
        render();
      }

      expect(searchedWithLimit).toEqual(["dataview|20"]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("reopening starts on the registry, not on the last thing typed", () => {
    jest.useFakeTimers();
    try {
      const container = open({ results: rows(20) });
      type(container, "templater");
      act(() => {
        jest.advanceTimersByTime(REGISTRY_DEBOUNCE_MS);
      });
      press(container, "Close");
      searchedWithLimit.length = 0;
      press(container, "Browse");
      act(() => {
        jest.advanceTimersByTime(REGISTRY_DEBOUNCE_MS * 2);
      });
      // The empty-query search, and nothing replaying the old filter after it.
      expect(searchedWithLimit).toEqual(["|20"]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("an empty result says which kind of empty it is", () => {
    const searchedNothing = open({ results: [], query: "zzzz" });
    expect(searchedNothing.textContent).toContain("Nothing in the community list matches");

    const listEmpty = open({ results: [], query: "" });
    expect(listEmpty.textContent).toContain("could not be read just now");
  });
});
