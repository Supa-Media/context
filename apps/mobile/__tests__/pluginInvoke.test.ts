/**
 * @jest-environment jsdom
 */

/**
 * Running a plugin's command from the console.
 *
 * Until this landed, the registrations card listed what a plugin had added and
 * said Context could not run it. That sentence was true of the console and — as
 * a correction in #527 recorded — false of the sandbox: the guest has always
 * handled an inbound `command`. This is the host half.
 *
 * What the pure tests in `pluginRuntime.test.ts` cannot reach, and this file
 * exists for, is the card actually calling `run`. A button wired to nothing
 * renders identically to one wired correctly, and "commands are pressable now"
 * is exactly the claim a reader would take on trust.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { PluginRuntimeCard } from "../features/console/settings/panels/PluginRuntimeCard";
import type { GrantsView } from "../features/console/plugins/grants";
import type { RuntimeView } from "../features/console/plugins/runtime";
import type { ConsolePlugin } from "../features/console/plugins/plugins";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

const PLUGIN: ConsolePlugin = {
  id: "highlightr-plugin",
  source: "obsidian",
  bundleFingerprint: "fp-1",
  name: "Highlightr",
  verdict: "runs",
  evidence: [],
  limitations: [],
  notes: [],
};

const GRANTS: GrantsView = {
  loading: false,
  grants: [{
    pluginId: "highlightr-plugin",
    bundleFingerprint: "fp-1",
    capabilities: ["vault:read"],
    networkHosts: [],
  }] as unknown as GrantsView["grants"],
};

const LOADED = {
  pluginId: "highlightr-plugin",
  bundleFingerprint: "fp-1",
  status: "loaded" as const,
  attempts: 1,
  updatedAt: 1_757_800_000_000,
};

function card(over: Partial<RuntimeView> = {}): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(createElement(PluginRuntimeCard, {
      plugin: PLUGIN,
      grants: GRANTS,
      view: {
        states: [LOADED],
        loading: false,
        registrations: {
          "highlightr-plugin": [
            { kind: "command", id: "toggle", name: "Toggle highlight" },
            { kind: "ribbon", id: "ribbon-0", name: "Highlight" },
          ],
        },
        actions: { start: async () => {}, stop: async () => {}, run: () => {} },
        ...over,
      } as RuntimeView,
    }));
  });
  return container;
}

function pressableNamed(container: HTMLElement, label: string): HTMLElement | undefined {
  return [...container.querySelectorAll("[role='button'], button")]
    .find((one) => (one.textContent ?? "").includes(label)) as HTMLElement | undefined;
}

describe("a registered command is a control now, not a sentence", () => {
  test("pressing one asks the runtime to run exactly that command", () => {
    const ran: [string, string][] = [];
    const container = card({
      actions: {
        start: async () => {},
        stop: async () => {},
        run: (pluginId: string, id: string) => { ran.push([pluginId, id]); },
      },
    });
    const button = pressableNamed(container, "Toggle highlight");
    expect(button).toBeDefined();
    act(() => { button!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(ran).toEqual([["highlightr-plugin", "toggle"]]);
  });

  /*
    A ribbon action is a command with a different origin, and the shim invokes
    both through the same map. A card that ran only the `command` kind would
    leave half of what a plugin registered listed and inert.
  */
  test("a ribbon action is runnable too", () => {
    const ran: string[] = [];
    const container = card({
      actions: {
        start: async () => {},
        stop: async () => {},
        run: (_pluginId: string, id: string) => { ran.push(id); },
      },
    });
    act(() => {
      pressableNamed(container, "Highlight")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(ran).toContain("ribbon-0");
  });

  /*
    The rule this section has held in five other places: never a control that
    cannot succeed. Without `run` there is no way to reach the frame, so the
    names go back to being names.
  */
  test("with no actions the names are not pressable", () => {
    const container = card({ actions: undefined });
    expect(container.textContent).toContain("Toggle highlight");
    expect(pressableNamed(container, "Toggle highlight")).toBeUndefined();
  });

  /*
    `registrationsFor` already refuses to list a stopped plugin's commands, so
    this asserts the control follows the list rather than the map — a card that
    read `view.registrations` directly would draw buttons for a plugin whose
    frame is gone.
  */
  test("a plugin the owner stopped offers nothing to press", () => {
    const container = card({
      states: [{ ...LOADED, status: "blocked" as const, errorCode: "OWNER_DISABLED" }],
    });
    expect(pressableNamed(container, "Toggle highlight")).toBeUndefined();
  });
});

describe("what happened to the command it ran", () => {
  test("a command that failed says so, and names itself", () => {
    const container = card({
      outcomes: {
        "highlightr-plugin": { id: "toggle", ok: false, error: "Cannot read properties of null" },
      },
    });
    expect(container.textContent).toContain("Toggle highlight");
    expect(container.textContent).toContain("Cannot read properties of null");
  });

  /*
    The failure is the plugin's, and the copy has to say so — a reader who
    reads it as Context breaking goes looking in the wrong place, and the
    plugin's own author never hears about it.
  */
  test("a failure is attributed to the plugin, not to Context", () => {
    const container = card({
      outcomes: { "highlightr-plugin": { id: "toggle", ok: false, error: "boom" } },
    });
    const failure = container.querySelector("[data-testid='plugin-command-outcome-highlightr-plugin']");
    expect(failure).not.toBeNull();
    expect(failure!.textContent).toMatch(/the plugin/i);
    expect(failure!.textContent).not.toMatch(/Context (failed|broke|could not)/i);
  });

  test("a command that worked says so without inventing a result", () => {
    const container = card({
      outcomes: { "highlightr-plugin": { id: "toggle", ok: true, error: null } },
    });
    expect(container.textContent).toContain("Ran");
    expect(container.textContent).not.toMatch(/error|failed/i);
  });

  test("an outcome for a command this plugin no longer lists is not shown", () => {
    const container = card({
      outcomes: { "highlightr-plugin": { id: "gone", ok: false, error: "boom" } },
    });
    expect(container.textContent).not.toContain("boom");
  });
});
