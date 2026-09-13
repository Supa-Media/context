/**
 * @jest-environment jsdom
 */

/**
 * The consent card, actually rendered.
 *
 * The pure module decides what is true; this file exists because a component
 * can be perfectly correct about that and still put the wrong control on
 * screen. Mutations that were green with only `pluginGrants.test.ts`:
 *
 *  - rendering Approve for a networked plugin, whose press returns
 *    `NETWORK_RUNTIME_UNAVAILABLE`;
 *  - rendering Approve for a viewer with no `actions` — the demo, and anyone
 *    who is not the owner;
 *  - opening the capability form expanded, so a plugin list becomes a column of
 *    consent forms nobody asked for;
 *  - a single-press Revoke.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { PluginGrantCard } from "../features/console/settings/panels/PluginGrantCard";
import type { GrantsView, PluginGrant } from "../features/console/plugins/grants";
import type { ConsolePlugin } from "../features/console/plugins/plugins";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

function plugin(over: Partial<ConsolePlugin> = {}): ConsolePlugin {
  return {
    id: "highlightr-plugin",
    source: "obsidian",
    bundleFingerprint: "fp-1",
    name: "Highlightr",
    verdict: "runs",
    evidence: [],
    limitations: [],
    notes: [],
    hosts: [],
    ...over,
  };
}

function grant(over: Partial<PluginGrant> = {}): PluginGrant {
  return {
    pluginId: "highlightr-plugin",
    bundleFingerprint: "fp-1",
    capabilities: ["vault:read"],
    networkHosts: [],
    status: "active",
    grantedAt: 1,
    updatedAt: 1,
    ...over,
  };
}

const approved: string[] = [];
const revoked: string[] = [];

function actions(): GrantsView["actions"] {
  return {
    approve: async (input) => {
      approved.push(`${input.pluginId}:${input.capabilities.join(",")}`);
    },
    revoke: async (pluginId) => {
      revoked.push(pluginId);
    },
  };
}

function card(one: ConsolePlugin, view: GrantsView): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(createElement(PluginGrantCard, { plugin: one, view }));
  });
  return container;
}

/** Every pressable, by its accessible name. */
function buttons(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[role='button']")).map(
    (node) => (node.getAttribute("aria-label") ?? node.textContent ?? "").trim(),
  );
}

function press(container: HTMLElement, name: string) {
  const target = Array.from(container.querySelectorAll("[role='button'], [role='checkbox']")).find(
    (node) => ((node.getAttribute("aria-label") ?? node.textContent) ?? "").trim().includes(name),
  );
  if (!target) throw new Error(`no control named ${name} — found ${buttons(container).join(" | ")}`);
  act(() => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("no control that cannot succeed", () => {
  test("a networked plugin gets the sentence and no approval control", () => {
    const container = card(
      plugin({ verdict: "needs-approval", hosts: ["readwise.io"] }),
      { grants: [], loading: false, actions: actions() },
    );
    expect(container.textContent).toContain("egress service");
    expect(buttons(container).some((label) => /review|approve/i.test(label))).toBe(false);
  });

  test("a viewer with no actions is offered nothing to press", () => {
    const container = card(plugin(), { grants: [], loading: false });
    expect(buttons(container)).toHaveLength(0);
  });

  test("a plugin that cannot run here is offered nothing", () => {
    const container = card(plugin({ verdict: "wont-run" }), {
      grants: [],
      loading: false,
      actions: actions(),
    });
    expect(buttons(container).some((label) => /approve/i.test(label))).toBe(false);
  });

  test("grants still loading renders nothing rather than an empty standing", () => {
    const container = card(plugin(), { loading: true, actions: actions() });
    expect(container.textContent).toBe("");
  });
});

describe("the form opens closed", () => {
  test("no capability rows until Review access is pressed", () => {
    const container = card(plugin(), { grants: [], loading: false, actions: actions() });
    expect(container.querySelector("[data-testid='plugin-approve-highlightr-plugin']")).toBeNull();
    press(container, "Review access");
    expect(container.querySelector("[data-testid='plugin-approve-highlightr-plugin']")).not.toBeNull();
  });

  test("what it opens with is read-only", () => {
    const container = card(plugin(), { grants: [], loading: false, actions: actions() });
    press(container, "Review access");
    const ticked = Array.from(container.querySelectorAll("[role='checkbox']"))
      .filter((node) => node.getAttribute("aria-checked") === "true")
      .map((node) => node.getAttribute("aria-label"));
    expect(ticked).not.toContain("Create and change notes");
    expect(ticked).not.toContain("Delete notes");
    expect(ticked).toContain("Read your notes");
  });

  test("network is never a row here — it is not grantable yet", () => {
    const container = card(plugin(), { grants: [], loading: false, actions: actions() });
    press(container, "Review access");
    expect(container.querySelector("[data-testid='capability-network:request']")).toBeNull();
  });

  test("approving sends the ticked capabilities and the installed fingerprint", async () => {
    approved.length = 0;
    const container = card(plugin(), { grants: [], loading: false, actions: actions() });
    press(container, "Review access");
    await act(async () => {
      press(container, "Approve this bundle");
    });
    expect(approved).toHaveLength(1);
    expect(approved[0]).toContain("highlightr-plugin:");
    expect(approved[0]).toContain("vault:read");
    expect(approved[0]).not.toContain("vault:delete");
  });
});

describe("a changed bundle returns to review", () => {
  test("a stale grant says so and offers to review the new bundle", () => {
    const container = card(plugin({ bundleFingerprint: "fp-2" }), {
      grants: [grant()],
      loading: false,
      actions: actions(),
    });
    expect(container.textContent).toContain("Needs review");
    expect(container.textContent).toContain("no access at all until you review it");
    expect(buttons(container).some((label) => /Review the new bundle/.test(label))).toBe(true);
  });

  test("an active grant lists what it is allowed, and never says 'running'", () => {
    const container = card(plugin(), {
      grants: [grant({ capabilities: ["vault:read", "metadata:read"] })],
      loading: false,
      actions: actions(),
    });
    expect(container.textContent).toContain("Approved");
    expect(container.textContent).toContain("read your notes");
    expect(container.textContent).not.toMatch(/running|loaded/i);
  });
});

describe("revoke takes two presses", () => {
  test("one press arms, the second revokes", () => {
    revoked.length = 0;
    const container = card(plugin(), {
      grants: [grant()],
      loading: false,
      actions: actions(),
    });
    press(container, "Revoke");
    expect(revoked).toHaveLength(0);
    expect(container.textContent).toContain("press again");
    press(container, "press again");
    expect(revoked).toEqual(["highlightr-plugin"]);
  });

  test("nothing to revoke where nothing was granted", () => {
    const container = card(plugin(), { grants: [], loading: false, actions: actions() });
    expect(buttons(container).some((label) => /revoke/i.test(label))).toBe(false);
  });
});
