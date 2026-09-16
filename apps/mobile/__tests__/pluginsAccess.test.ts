/**
 * @jest-environment jsdom
 */

/**
 * The Plugins section, read without colour and operated without a mouse.
 *
 * The frontend brief asks for accessible keyboard, screen-reader, focus,
 * contrast and reduced-motion behaviour, and for responsive behaviour across
 * web, desktop and mobile. Four earlier files cover what the section *says*;
 * none of them covered whether it can be read or operated, and that gap is
 * exactly where a security screen fails quietly.
 *
 * This section is the worst place in the console for colour to be load-bearing.
 * Five verdicts and three grant standings are drawn with tone as the fastest
 * signal — green runs, red won't, dashed was not checked — and a reader who
 * cannot separate those hues is being asked to make a decision about running
 * somebody else's code against their own notes. So the rule is: **every state
 * that has a colour also has a word**, and a control that has an icon also has
 * a name.
 *
 * Mutations these are written to catch:
 *
 *  - a verdict conveyed only by pill tone, so the list is unreadable in
 *    greyscale;
 *  - the destructive capabilities marked only by their amber chip, so the three
 *    that change somebody's notes read like the four that do not;
 *  - a capability row that is a coloured box with no role and no checked state,
 *    which is a checkbox a screen reader cannot report or operate;
 *  - a control whose only label is its icon;
 *  - content that disappears at phone width.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { PluginsPanel } from "../features/console/settings/panels/PluginsPanel";
import type { ManagedInstallsView } from "../features/console/plugins/managedInstalls";
import { PluginGrantCard } from "../features/console/settings/panels/PluginGrantCard";
import { PluginBrowse } from "../features/console/settings/panels/PluginBrowse";
import { VERDICT_ORDER, verdictHeading, type ConsolePlugin, type PluginsView } from "../features/console/plugins/plugins";
import { ALL_CAPABILITIES, capabilityLabel, isDestructive, type GrantsView } from "../features/console/plugins/grants";
import type { BrowseView } from "../features/console/plugins/lifecycle";
import type { RuntimeView } from "../features/console/plugins/runtime";
import type { ContextPluginsView } from "../features/console/plugins/contextPlugins";

/** No scan, nothing installed — the state a bucket with no plugins is really in. */
const NO_INSTALLS: ManagedInstallsView = {
  state: "ready",
  installs: [],
  truncated: false,
  read: async () => {},
};

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

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

/** One plugin per verdict, so the whole palette is on screen at once. */
const EVERY_VERDICT: PluginsView = {
  state: "ready",
  inventory: {
    found: 5,
    scanned: 5,
    truncated: false,
    checkedAt: "2026-09-12T09:41:00.000Z",
    plugins: VERDICT_ORDER.map((verdict) =>
      plugin({
        id: `plugin-${verdict}`,
        name: `Plugin ${verdict}`,
        verdict,
        evidence:
          verdict === "runs" || verdict === "files-only"
            ? []
            : [{ id: "child_process", reason: "runs another program" }],
      }),
    ),
  },
};

const NO_GRANTS: GrantsView = { grants: [], loading: false, egress: false };
const NO_BROWSE: BrowseView = { query: "", limit: 20, searching: false, failure: null };
const NO_RUNTIME: RuntimeView = { states: [], loading: false };
/** See `pluginsPanel.test.ts`: this file is about the vault half. */
const NO_CONTEXT_PLUGINS: ContextPluginsView = {
  state: "ready",
  plugins: [],
  settingsError: null,
  canManage: false,
};

function panel(): HTMLElement {
  return mount(
    createElement(PluginsPanel, {
      view: EVERY_VERDICT,
      contextPlugins: NO_CONTEXT_PLUGINS,
      installs: NO_INSTALLS,
      grants: NO_GRANTS,
      browse: NO_BROWSE,
      runtime: NO_RUNTIME,
    }),
  );
}

/**
 * Open one plugin's own screen inside a mounted panel.
 *
 * The plugin row now answers "is it on" and nothing else — the evidence, the
 * refusals and the route out moved to the plugin's own screen. That is a
 * placement change and never a licence to drop any of it, so the checks below
 * press through to where the words went rather than being deleted with the
 * wall they were part of.
 */
function open(container: HTMLElement, pluginId: string): HTMLElement {
  const details = container.querySelector(
    `[data-testid='plugin-details-${pluginId}']`,
  ) as HTMLElement | null;
  if (details === null) throw new Error(`no Details control for ${pluginId}`);
  act(() => {
    details.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  return container;
}

/** Everything a pointer or a screen reader can act on. */
function controls(container: HTMLElement): Element[] {
  return Array.from(container.querySelectorAll("[role='button'], [role='checkbox']"));
}

function accessibleName(node: Element): string {
  return (node.getAttribute("aria-label") ?? node.textContent ?? "").trim();
}

describe("nothing in this section is carried by colour alone", () => {
  /*
    Five verdicts drawn with tone as the fastest signal, in front of somebody
    deciding whether to run other people's code against their own notes. Every
    one of them is a word as well.
  */
  test("every verdict appears as text, not only as a tone", () => {
    const text = panel().textContent ?? "";
    for (const verdict of VERDICT_ORDER) {
      expect(text).toContain(verdictHeading(verdict));
    }
  });

  test("the unchecked state is named, not merely drawn dashed", () => {
    expect(panel().textContent).toContain("Couldn't be checked");
  });

  test("a refusal names its call in text", () => {
    expect(open(panel(), "plugin-wont-run").textContent).toContain("child_process");
  });

  test("the count of each verdict is a number beside its name", () => {
    const text = panel().textContent ?? "";
    for (const verdict of VERDICT_ORDER) {
      expect(text).toContain(`${verdictHeading(verdict)} · 1`);
    }
  });

  /*
    The three capabilities that change somebody's notes are marked with an amber
    chip. In greyscale that chip is the same as every other chip, so the words
    have to do the work too.
  */
  test("the capabilities that change notes say so in words", () => {
    const container = mount(
      createElement(PluginGrantCard, {
        plugin: plugin({ id: "highlightr-plugin" }),
        view: { grants: [], loading: false, egress: false, actions: { approve: async () => {}, revoke: async () => {} } },
      }),
    );
    const open = controls(container).find((node) => /Choose what it can do/.test(accessibleName(node)));
    act(() => {
      open?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const text = container.textContent ?? "";
    for (const capability of ALL_CAPABILITIES) {
      if (capability === "network:request") continue;
      expect(text).toContain(capabilityLabel(capability));
      if (isDestructive(capability)) expect(text).toContain("Changes notes");
    }
  });
});

describe("a screen reader can report and operate the consent form", () => {
  function openForm(): HTMLElement {
    const container = mount(
      createElement(PluginGrantCard, {
        plugin: plugin({ id: "highlightr-plugin" }),
        view: { grants: [], loading: false, egress: false, actions: { approve: async () => {}, revoke: async () => {} } },
      }),
    );
    const open = controls(container).find((node) => /Choose what it can do/.test(accessibleName(node)));
    act(() => {
      open?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    return container;
  }

  test("every capability is a checkbox with a name and a reported state", () => {
    const boxes = Array.from(openForm().querySelectorAll("[role='checkbox']"));
    expect(boxes.length).toBeGreaterThan(0);
    for (const box of boxes) {
      expect(accessibleName(box)).not.toBe("");
      expect(box.getAttribute("aria-checked")).toMatch(/^(true|false)$/);
    }
  });

  test("toggling one reports the change rather than only recolouring a box", () => {
    const container = openForm();
    const box = container.querySelector("[data-testid='capability-vault:delete']");
    expect(box?.getAttribute("aria-checked")).toBe("false");
    act(() => {
      box?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(
      container.querySelector("[data-testid='capability-vault:delete']")?.getAttribute("aria-checked"),
    ).toBe("true");
  });

  test("every control has a name that is not just its icon", () => {
    for (const node of controls(openForm())) {
      const name = accessibleName(node);
      expect(name).not.toBe("");
      // A lone glyph is not a name — the shortest real label here is "Cancel".
      expect(name.length).toBeGreaterThan(2);
    }
  });

  test("the search field is labelled", () => {
    const container = mount(
      createElement(PluginBrowse, {
        view: {
          ...NO_BROWSE,
          actions: {
            search: async () => {},
            install: async () => {},
            uninstall: async () => {},
            recover: async () => {},
          },
        },
        installed: [],
      }),
    );
    const open = controls(container).find((node) => /Browse/.test(accessibleName(node)));
    act(() => {
      open?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const field = container.querySelector("[data-testid='plugin-browse-query']");
    expect(field).not.toBeNull();
    const labelledBy = field?.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(container.querySelector(`#${labelledBy}`)?.textContent?.trim()).not.toBe("");
  });
});

/*
  jsdom reports a viewport width of 0, so every mount here takes the components'
  **compact** branch — the phone one. That is the half worth spending a render
  test on: the wide layout shows everything side by side, where a mistake is
  visible, and compact is where a row that wraps badly silently drops what it
  cannot fit.
*/
describe("nothing is lost at phone width", () => {
  test("every verdict group, its evidence and the floor line all survive", () => {
    const text = panel().textContent ?? "";
    for (const verdict of VERDICT_ORDER) expect(text).toContain(verdictHeading(verdict));
    expect(text).toContain("floor, not a guarantee");
    expect(text).toContain("shared into this context");
    // The evidence is a fact about one plugin, so it is on that plugin's screen
    // — still a screen a phone has to fit, which is what this block is for.
    expect(open(panel(), "plugin-wont-run").textContent).toContain("child_process");
  });

  test("the route out of a refusal is not what gets cut for width", () => {
    expect(open(panel(), "plugin-wont-run").textContent).toContain("Keep it in Obsidian");
  });

  test("controls stay reachable rather than being clipped away", () => {
    const container = mount(
      createElement(PluginsPanel, {
        view: EVERY_VERDICT,
        contextPlugins: NO_CONTEXT_PLUGINS,
        installs: NO_INSTALLS,
        grants: {
          grants: [],
          loading: false,
          egress: false,
          actions: { approve: async () => {}, revoke: async () => {} },
        },
        browse: NO_BROWSE,
        runtime: NO_RUNTIME,
      }),
    );
    /*
      THE LIST'S controls, which are now two per row and no more: the press that
      changes the plugin's state, and the way to everything else. Five plugins,
      so ten — and the check that matters is the shape rather than the count:
      every row has a Details, and only the two verdicts Context can run have a
      press of their own.
    */
    const names = controls(container).map(accessibleName);
    expect(names.filter((name) => name === "Details")).toHaveLength(5);
    /*
      One press of its own, on the one plugin that has one. `plugin-runs` can be
      approved here; `plugin-needs-approval` names hosts and this fixture has no
      egress, so it cannot be approved at all and is offered no door to a screen
      that could only refuse it. The other three cannot run in Context.
    */
    expect(names.filter((name) => name === "Enable…")).toHaveLength(1);
    expect(names.filter((name) => name === "Approve…")).toHaveLength(0);

    /*
      And the consent form is still reachable, one screen in. It was on the row
      before; deleting the wall must not have deleted the way to it.
    */
    const inside = controls(open(container, "plugin-runs")).map(accessibleName);
    expect(inside.filter((name) => /^Enable$/.test(name))).toHaveLength(1);
    expect(inside.filter((name) => /Choose what it can do/.test(name))).toHaveLength(1);
  });
});
