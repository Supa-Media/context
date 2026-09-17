/**
 * @jest-environment jsdom
 */

/**
 * ONE SWITCH PER ROW, AND THE ONE THING IT IS ALLOWED TO MEAN.
 *
 * Reported from a phone, and the reason `PluginRow` exists at all: "people just
 * want to enable or disable a plugin". Obsidian answers that with a switch per
 * row, and this list answered it with a button reading Start or Stop — which is
 * the same press, drawn as the thing you read rather than the thing you flick.
 *
 * ## Why this is not simply "draw Obsidian's switch"
 *
 * Obsidian's toggle means *run this code*, and it can, because there is nothing
 * to consent to. Ours cannot: turning a plugin on for the first time names
 * folders and hosts, and a switch that quietly granted a default set would be
 * the consent screen skipped by a control too small to hold the question. So
 * `pluginRowSummary` already splits the press two ways — start and stop are
 * complete on the row, anything with a choice inside it opens a door and ends
 * in an ellipsis — and this file holds that line at the control:
 *
 *   **a complete action is a switch; a choice is still a door.**
 *
 * ## The second rule: the switch is not the status
 *
 * A switch says *is it on*, which is the thing the reader controls. The pill
 * says *what it is doing*, which is the thing the console reports. They come
 * apart on exactly the rows that matter — a plugin that crash-looped is off and
 * did not choose to be — so the switch is drawn in the accent, the one hue the
 * palette spends on "here, active, yours", and never in a status tone. A switch
 * that turned green when a plugin was healthy would be a status light somebody
 * can press.
 *
 * Mutations this is written to catch:
 *
 *  - the switch rendered for `open`, so first-time enabling skips consent;
 *  - the switch drawn in `ok`, collapsing the control into the status;
 *  - the switch offered to a reader with no runtime actions, which is a member
 *    being shown a control the server will refuse;
 *  - a switch with no role and no checked state, which is a box a screen reader
 *    can neither report nor operate;
 *  - the crash-looped row losing its own words to a flat "Off".
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { PluginsPanel } from "../features/console/settings/panels/PluginsPanel";
import { ThemeProvider } from "../features/design/theme";
import { darkColors } from "../features/design/tokens";
import type { ManagedInstallsView } from "../features/console/plugins/managedInstalls";
import type { GrantActions, GrantsView, PluginGrant } from "../features/console/plugins/grants";
import type { BrowseView } from "../features/console/plugins/lifecycle";
import type { RuntimeState, RuntimeView } from "../features/console/plugins/runtime";
import type { ContextPluginsView } from "../features/console/plugins/contextPlugins";
import type { ConsolePlugin, PluginVerdict, PluginsView } from "../features/console/plugins/plugins";

const NO_INSTALLS: ManagedInstallsView = {
  state: "ready",
  installs: [],
  truncated: false,
  read: async () => {},
};

const NO_CONTEXT_PLUGINS: ContextPluginsView = {
  state: "ready",
  plugins: [],
  settingsError: null,
  canManage: false,
};

/** Enough of the grant actions to make the console one that *could* approve. */
const CAN_GRANT: GrantActions = {
  approve: async () => {},
  revoke: async () => {},
};

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

/** react-native-web resolves colours to `rgb()`; the tokens are hex. */
function rgb(hex: string): string {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return `rgb(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255})`;
}

const PLUGIN_ID = "highlightr-plugin";

function plugin(over: Partial<ConsolePlugin> & { verdict: PluginVerdict } = { verdict: "runs" }): ConsolePlugin {
  return {
    id: over.id ?? PLUGIN_ID,
    source: "obsidian",
    bundleFingerprint: over.bundleFingerprint ?? `fp-${over.id ?? PLUGIN_ID}`,
    name: over.name ?? "Highlightr",
    evidence: [],
    limitations: [],
    notes: [],
    ...over,
  };
}

function inventory(...plugins: ConsolePlugin[]): PluginsView {
  return {
    state: "ready",
    inventory: {
      found: plugins.length,
      scanned: plugins.length,
      truncated: false,
      checkedAt: "2026-09-17T09:41:00.000Z",
      plugins,
    },
  };
}

function grant(over: Partial<PluginGrant> = {}): PluginGrant {
  return {
    pluginId: PLUGIN_ID,
    bundleFingerprint: `fp-${PLUGIN_ID}`,
    capabilities: ["vault:read"],
    networkHosts: [],
    status: "active",
    grantedAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function running(status: RuntimeState["status"] = "loaded"): RuntimeState {
  return {
    pluginId: PLUGIN_ID,
    bundleFingerprint: `fp-${PLUGIN_ID}`,
    status,
    attempts: 1,
    updatedAt: 1,
  };
}

const BROWSE: BrowseView = { query: "", limit: 20, searching: false, failure: null };

function panel({
  view = inventory(plugin({ verdict: "runs" })),
  grants = { grants: [], loading: false, egress: false },
  runtime = { states: [], loading: false },
}: {
  view?: PluginsView;
  grants?: GrantsView;
  runtime?: RuntimeView;
} = {}): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(
      createElement(ThemeProvider, {
        scheme: "dark",
        children: createElement(PluginsPanel, {
          view,
          contextPlugins: NO_CONTEXT_PLUGINS,
          installs: NO_INSTALLS,
          grants,
          browse: BROWSE,
          runtime,
        }),
      }),
    );
  });
  return container;
}

const theSwitch = (container: HTMLElement, id = PLUGIN_ID) =>
  container.querySelector(`[data-testid='plugin-switch-${id}']`) as HTMLElement | null;

const theDoor = (container: HTMLElement, id = PLUGIN_ID) =>
  container.querySelector(`[data-testid='plugin-primary-${id}']`) as HTMLElement | null;

describe("a complete action is a switch", () => {
  test("a running plugin's row is a switch that is on, and flicking it stops the plugin", async () => {
    const stop = jest.fn(async () => {});
    const container = panel({
      grants: { grants: [grant()], loading: false, egress: false, actions: CAN_GRANT },
      runtime: {
        states: [running()],
        loading: false,
        actions: { start: async () => {}, stop, run: () => {} },
      },
    });

    const control = theSwitch(container);
    expect(control).not.toBeNull();
    expect(control!.getAttribute("role")).toBe("switch");
    expect(control!.getAttribute("aria-checked")).toBe("true");

    await act(async () => control!.click());
    expect(stop).toHaveBeenCalledWith(PLUGIN_ID, `fp-${PLUGIN_ID}`);
  });

  test("an approved plugin that is not running is a switch that is off, and flicking it starts it", async () => {
    const start = jest.fn(async () => {});
    const container = panel({
      grants: { grants: [grant()], loading: false, egress: false, actions: CAN_GRANT },
      runtime: { states: [], loading: false, actions: { start, stop: async () => {}, run: () => {} } },
    });

    const control = theSwitch(container);
    expect(control).not.toBeNull();
    expect(control!.getAttribute("aria-checked")).toBe("false");

    await act(async () => control!.click());
    expect(start).toHaveBeenCalledWith(PLUGIN_ID, `fp-${PLUGIN_ID}`);
  });

  /*
    The switch names the plugin, because a screen reader announcing "switch,
    off" four times down a list has told the reader nothing about which code
    they are about to run.
  */
  test("the switch carries the plugin's name, not just its state", () => {
    const container = panel({
      grants: { grants: [grant()], loading: false, egress: false, actions: CAN_GRANT },
      runtime: { states: [], loading: false, actions: { start: async () => {}, stop: async () => {}, run: () => {} } },
    });
    expect(theSwitch(container)!.getAttribute("aria-label")).toContain("Highlightr");
  });
});

describe("a choice is still a door", () => {
  test("a plugin nobody has approved has no switch — the press opens the consent screen", () => {
    const container = panel({
      grants: { grants: [], loading: false, egress: false, actions: CAN_GRANT },
      runtime: { states: [], loading: false, actions: { start: async () => {}, stop: async () => {}, run: () => {} } },
    });

    expect(theSwitch(container)).toBeNull();
    const door = theDoor(container);
    expect(door).not.toBeNull();
    // The ellipsis is the punctuation that carries "this opens something".
    expect(door!.textContent).toMatch(/…$/);
  });

  test("a plugin Context cannot run has neither a switch nor a press", () => {
    const container = panel({
      view: inventory(plugin({ verdict: "wont-run" })),
      grants: { grants: [], loading: false, egress: false, actions: CAN_GRANT },
      runtime: { states: [], loading: false, actions: { start: async () => {}, stop: async () => {}, run: () => {} } },
    });

    expect(theSwitch(container)).toBeNull();
    expect(theDoor(container)).toBeNull();
  });

  test("a reader whose console cannot start anything is offered no switch", () => {
    const container = panel({
      grants: { grants: [grant()], loading: false, egress: false },
      runtime: { states: [running()], loading: false },
    });

    expect(theSwitch(container)).toBeNull();
  });
});

describe("the switch is the control, and the pill is the state", () => {
  test("the switch is drawn in the accent, never in the healthy tone", () => {
    const container = panel({
      grants: { grants: [grant()], loading: false, egress: false, actions: CAN_GRANT },
      runtime: {
        states: [running()],
        loading: false,
        actions: { start: async () => {}, stop: async () => {}, run: () => {} },
      },
    });

    const track = container.querySelector(
      `[data-testid='plugin-switch-${PLUGIN_ID}-track']`,
    ) as HTMLElement;
    const paint = window.getComputedStyle(track).backgroundColor;
    expect(paint).toBe(rgb(darkColors.accent));
    expect(paint).not.toBe(rgb(darkColors.ok));
  });

  /*
    The row where the two halves genuinely disagree. The plugin is off — the
    switch says so — but nobody turned it off, and "Off" is the one word this
    row must not be flattened into.
  */
  test("a plugin that stopped itself reads off at the switch and says why at the pill", () => {
    const container = panel({
      grants: { grants: [grant()], loading: false, egress: false, actions: CAN_GRANT },
      runtime: {
        states: [running("crash-looped")],
        loading: false,
        actions: { start: async () => {}, stop: async () => {}, run: () => {} },
      },
    });

    expect(theSwitch(container)!.getAttribute("aria-checked")).toBe("false");
    const row = container.querySelector(`[data-testid='plugin-row-${PLUGIN_ID}']`) as HTMLElement;
    expect(row.textContent).toContain("Stopped itself");
  });
});
