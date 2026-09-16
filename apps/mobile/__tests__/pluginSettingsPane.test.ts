/**
 * @jest-environment jsdom
 *
 * A PLUGIN'S SETTINGS PANE, AS THE READER SEES IT.
 *
 * `pluginSandboxGuest.test.ts` proves the half that matters for safety — the
 * plugin's `display()` runs in the sandbox and only a description of its
 * controls crosses. This proves the half that makes it a feature: the controls
 * are drawn, working one sends the change back addressed by index, and the two
 * things a reader must not be misled about are said outright.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { SafeAreaProvider, initialWindowMetrics } from "react-native-safe-area-context";
import { LINKS_NOTE, PluginSettingsPane } from "../features/console/plugins/PluginSettingsPane";
import type { PluginSettingRow, RuntimeView } from "../features/console/plugins/runtime";

const METRICS = initialWindowMetrics ?? {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const roots: Array<() => void> = [];
afterEach(() => {
  while (roots.length) roots.pop()?.();
});

/** `document.body`, not the container — `Modal` portals. See the dialog tests. */
function mount(element: ReturnType<typeof createElement>): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => root.render(createElement(SafeAreaProvider, { initialMetrics: METRICS }, element)));
  return document.body;
}

const ROWS: PluginSettingRow[] = [
  { kind: "note", text: "Support us at example" },
  { kind: "heading", level: 2, text: "Verses Rendering" },
  {
    kind: "toggle",
    index: 0,
    name: "Show Verse Translation",
    desc: "Show or hide the translation",
    label: "",
    placeholder: "",
    disabled: false,
    value: true,
  },
  {
    kind: "dropdown",
    index: 1,
    name: "Verse Reference Position",
    desc: "Where to put the reference",
    label: "",
    placeholder: "",
    disabled: false,
    value: "top",
    options: [
      { value: "top", label: "Top" },
      { value: "bottom", label: "Bottom" },
    ],
  },
];

function view(over: Partial<RuntimeView> = {}, actions: Partial<NonNullable<RuntimeView["actions"]>> = {}): RuntimeView {
  return {
    loading: false,
    settingsPane: {
      pluginId: "obsidian-bible-reference",
      nonce: "n1",
      rows: ROWS,
      error: null,
    },
    actions: {
      start: async () => {},
      stop: async () => {},
      run: () => {},
      changeSetting: () => {},
      closeSettingsPane: () => {},
      ...actions,
    } as NonNullable<RuntimeView["actions"]>,
    ...over,
  };
}

describe("a plugin's settings pane", () => {
  test("nothing is drawn until a pane is open", () => {
    const body = mount(
      createElement(PluginSettingsPane, { runtime: view({ settingsPane: null }) }),
    );
    expect(body.querySelector("[data-testid='plugin-settings-pane']")).toBeNull();
  });

  test("the controls are drawn, with the plugin's own names and order", () => {
    const body = mount(createElement(PluginSettingsPane, { runtime: view() }));
    expect(body.querySelector("[data-testid='plugin-settings-heading']")?.textContent).toBe(
      "Verses Rendering",
    );
    expect(body.querySelector("[data-testid='plugin-setting-0']")?.textContent).toContain(
      "Show Verse Translation",
    );
    expect(body.querySelector("[data-testid='plugin-setting-1']")?.textContent).toContain(
      "Verse Reference Position",
    );
  });

  test("and whose settings they are is named", () => {
    const body = mount(createElement(PluginSettingsPane, { runtime: view() }));
    expect(body.textContent).toContain("obsidian-bible-reference");
  });

  test("working a toggle sends its index and the new value", () => {
    const changed: Array<[number, unknown]> = [];
    const body = mount(
      createElement(PluginSettingsPane, {
        runtime: view({}, { changeSetting: (index: number, value: unknown) => changed.push([index, value]) }),
      }),
    );
    act(() => {
      body
        .querySelector("[data-testid='plugin-setting-toggle-0']")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // The value it would become, not the one it has — the plugin's `onChange`
    // is given the new state, the way Obsidian gives it.
    expect(changed).toEqual([[0, false]]);
  });

  test("choosing from a dropdown sends the option's value", () => {
    const changed: Array<[number, unknown]> = [];
    const body = mount(
      createElement(PluginSettingsPane, {
        runtime: view({}, { changeSetting: (index: number, value: unknown) => changed.push([index, value]) }),
      }),
    );
    act(() => {
      body
        .querySelector("[data-testid='plugin-setting-dropdown-1']")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    act(() => {
      body
        .querySelector("[data-testid='plugin-setting-option-1-bottom']")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(changed).toEqual([[1, "bottom"]]);
  });

  /*
    The two things a reader must not be misled about. Both are about the
    boundary rather than about this plugin: a link cannot cross it, and a
    `display()` that threw leaves a pane that looks complete.
  */
  test("it says once that links do not survive the boundary", () => {
    const body = mount(createElement(PluginSettingsPane, { runtime: view() }));
    expect(body.textContent).toContain(LINKS_NOTE);
  });

  test("a pane that stopped part-way says so rather than looking short", () => {
    const body = mount(
      createElement(PluginSettingsPane, {
        runtime: view({
          settingsPane: {
            pluginId: "p",
            nonce: "n1",
            rows: [ROWS[2]!],
            error: "settingEl.hide is not a function",
          },
        }),
      }),
    );
    expect(body.textContent).toContain("stopped part-way");
    expect(body.textContent).toContain("settingEl.hide is not a function");
    // And what it did draw is still usable rather than withheld.
    expect(body.querySelector("[data-testid='plugin-setting-0']")).not.toBeNull();
  });

  test("the reader can always get out", () => {
    const closed = jest.fn();
    const body = mount(
      createElement(PluginSettingsPane, { runtime: view({}, { closeSettingsPane: closed }) }),
    );
    act(() => {
      body
        .querySelector("[data-testid='plugin-settings-close']")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(closed).toHaveBeenCalled();
  });

  test("a console with no plugin runtime at all draws nothing", () => {
    const body = mount(createElement(PluginSettingsPane, { runtime: undefined }));
    expect(body.querySelector("[data-testid='plugin-settings-pane']")).toBeNull();
  });
});
