/**
 * @jest-environment jsdom
 *
 * THE CONTEXT PLUGINS BLOCK, AND THE PANEL AROUND IT.
 *
 * Three properties carry this screen, and everything below is one of them:
 *
 *  1. **The built-ins are drawn in every state the vault half can be in.**
 *     This is the structural claim the whole restructure rests on. Every early
 *     return in `PluginsPanel` used to end the panel — a member got "only an
 *     owner can read this", a bucket with no `.obsidian/` got "no plugins" —
 *     while the context was running four plugins the whole time.
 *  2. **A switch says what it costs before it is pressed.** `switchConsequence`
 *     prints in both states, and its words come from the gateway's own
 *     catalogue, so the promise on screen and the behaviour of the tool gate
 *     cannot drift apart.
 *  3. **A reader who cannot change anything is told so, and shown no control.**
 *     Not a disabled button: a greyed switch invites somebody to go looking for
 *     the permission that enables it, and the answer is "ask an owner".
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ContextPluginsCard } from "../features/console/settings/panels/ContextPluginsCard";
import { PluginsPanel } from "../features/console/settings/panels/PluginsPanel";
import {
  contextCountLabel,
  contextEmptyNote,
  contextToolLine,
  filterContextPlugins,
  manageBlocker,
  matchesVaultQuery,
  settingsErrorNote,
  showsContext,
  showsObsidian,
  switchConsequence,
  switchLabel,
  type ContextPlugin,
  type ContextPluginsView,
} from "../features/console/plugins/contextPlugins";
import type { PluginsView } from "../features/console/plugins/plugins";
import type { GrantsView } from "../features/console/plugins/grants";
import type { BrowseView } from "../features/console/plugins/lifecycle";
import type { RuntimeView } from "../features/console/plugins/runtime";

const roots: Array<() => void> = [];
afterEach(() => {
  while (roots.length) roots.pop()?.();
});

function mount(element: ReturnType<typeof createElement>): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => root.render(element));
  return container;
}

function plugin(over: Partial<ContextPlugin> & { id: string }): ContextPlugin {
  return {
    name: over.name ?? "Markdown forms",
    description: over.description ?? "Collects answers into a sister note.",
    version: "1.0.0",
    author: "Context",
    enabled: over.enabled ?? true,
    defaultEnabled: true,
    tools: over.tools ?? ["submit_form", "vote_form"],
    surfaces: over.surfaces ?? ["Notes", "Editor"],
    offMeans:
      over.offMeans ??
      "Form blocks stop being drawn and the four form tools disappear. Every file is left exactly as it is.",
    ...over,
  };
}

const FORMS = plugin({ id: "context-forms" });
const MEETINGS = plugin({
  id: "context-meetings",
  name: "Meetings",
  enabled: false,
  tools: ["list_meetings", "read_meeting"],
  surfaces: ["Console"],
  offMeans: "The meeting tools disappear and the console stops listing meetings. Nothing is deleted.",
});
const DRAWINGS = plugin({
  id: "context-drawings",
  name: "Drawings",
  tools: [],
  surfaces: ["Notes", "Console"],
  offMeans: "A drawing stops being drawn and opens as the file it is. It is still never overwritten.",
});

function ready(over: Partial<Extract<ContextPluginsView, { state: "ready" }>> = {}): ContextPluginsView {
  return {
    state: "ready",
    plugins: [FORMS, MEETINGS, DRAWINGS],
    settingsError: null,
    canManage: true,
    actions: { setEnabled: () => {} },
    ...over,
  };
}

function card(view: ContextPluginsView, query = ""): HTMLElement {
  return mount(createElement(ContextPluginsCard, { view, query }));
}

function controlLabels(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[role='button']")).map(
    (node) => (node.getAttribute("aria-label") ?? node.textContent) ?? "",
  );
}

describe("the wording, without mounting anything", () => {
  test("the count says both halves once anything is off", () => {
    expect(contextCountLabel([FORMS, MEETINGS, DRAWINGS])).toBe("2 on · 1 off");
    expect(contextCountLabel([FORMS, DRAWINGS])).toBe("2 on");
  });

  test("the consequence is printed for both states, worded for the one it is in", () => {
    expect(switchConsequence(FORMS)).toContain("If you turn this off");
    expect(switchConsequence(FORMS)).toContain(FORMS.offMeans);
    expect(switchConsequence(MEETINGS)).toContain("Off.");
    expect(switchConsequence(MEETINGS)).toContain(MEETINGS.offMeans);
  });

  test("the button says what pressing it does, never what the state is", () => {
    // A control labelled "On" is a control whose press is a guess. The label is
    // the verb, so a screen reader gets the action without an extra attribute
    // restating the pill beside it.
    expect(switchLabel(FORMS)).toBe("Turn off");
    expect(switchLabel(MEETINGS)).toBe("Turn on");
  });

  test("a plugin that adds no tool claims none", () => {
    // Drawings changes how a file is read. A row printing "Tools:" with nothing
    // after it would be the panel telling a small lie about it.
    expect(contextToolLine(DRAWINGS)).toBeNull();
    expect(contextToolLine(FORMS)).toContain("submit_form");
  });

  test("the box matches a tool name, not only a title", () => {
    // Somebody who read `submit_form` in an agent's output and wants to know
    // where it came from types that, not "Markdown forms".
    expect(filterContextPlugins([FORMS, MEETINGS], "submit_form")).toEqual([FORMS]);
    expect(filterContextPlugins([FORMS, MEETINGS], "meet")).toEqual([MEETINGS]);
    expect(filterContextPlugins([FORMS, MEETINGS], "context-forms")).toEqual([FORMS]);
    expect(filterContextPlugins([FORMS, MEETINGS], "")).toHaveLength(2);
  });

  test("and the same box narrows the vault's list", () => {
    const vault = { id: "obsidian-git", name: "Obsidian Git", author: "Vinzent" };
    expect(matchesVaultQuery(vault, "git")).toBe(true);
    expect(matchesVaultQuery(vault, "vinzent")).toBe(true);
    expect(matchesVaultQuery(vault, "forms")).toBe(false);
    expect(matchesVaultQuery(vault, "  ")).toBe(true);
  });

  test("the filter shows one half, the other, or both", () => {
    expect([showsContext("all"), showsObsidian("all")]).toEqual([true, true]);
    expect([showsContext("context"), showsObsidian("context")]).toEqual([true, false]);
    expect([showsContext("obsidian"), showsObsidian("obsidian")]).toEqual([false, true]);
  });

  test("an empty list says which kind of empty it is", () => {
    expect(contextEmptyNote("")).not.toContain('""');
    expect(contextEmptyNote("templater")).toContain("templater");
  });

  test("an unreadable settings file is named, and says nothing was changed", () => {
    expect(settingsErrorNote(null)).toBeNull();
    const note = settingsErrorNote("not valid JSON") ?? "";
    expect(note).toContain("not valid JSON");
    expect(note).toContain("default");
    expect(note).toContain("Nothing was changed");
  });

  test("a reader who cannot manage is told who can", () => {
    expect(manageBlocker(true)).toBeNull();
    expect(manageBlocker(false)).toContain("owner");
  });
});

describe("the card", () => {
  test("draws every plugin with its state marked twice", () => {
    const container = card(ready());
    const text = container.textContent ?? "";
    expect(text).toContain("Markdown forms");
    expect(text).toContain("Meetings");
    expect(text).toContain("2 on · 1 off");
    // Not colour alone: the word is in the pill beside the dot.
    expect(text).toContain("On");
    expect(text).toContain("Off");
    expect(container.querySelector("[data-testid='context-plugin-context-forms']")).not.toBeNull();
  });

  test("the consequence is on screen before anything is pressed", () => {
    const text = card(ready()).textContent ?? "";
    expect(text).toContain("If you turn this off");
    expect(text).toContain("the four form tools disappear");
  });

  test("a member sees the list, no switches, and why", () => {
    const container = card(ready({ canManage: false, actions: undefined }));
    expect(container.textContent).toContain("Markdown forms");
    expect(container.textContent).toContain("Only an owner of this context");
    // No control at all rather than a disabled one.
    expect(controlLabels(container)).toHaveLength(0);
  });

  test("a change in flight offers nothing to press twice", () => {
    /*
      Two switches pressed in the same second are two read-modify-writes of one
      file, and the loser of that race is a decision somebody made and did not
      get. `pending` is what `useContextPlugins` sets while the write is out,
      and it withholds `actions` at the same time.
    */
    const container = card(ready({ pending: "context-forms", actions: undefined }));
    expect(container.textContent).toContain("Saving");
    for (const node of Array.from(container.querySelectorAll("[role='button']"))) {
      expect(node.getAttribute("aria-disabled")).toBe("true");
    }
  });

  test("a switch sends the opposite of what the row shows", () => {
    const sent: Array<[string, boolean]> = [];
    const container = card(ready({ actions: { setEnabled: (id, on) => sent.push([id, on]) } }));
    const off = container.querySelector("[data-testid='context-plugin-toggle-context-forms']");
    act(() => {
      off?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const on = container.querySelector("[data-testid='context-plugin-toggle-context-meetings']");
    act(() => {
      on?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(sent).toEqual([
      ["context-forms", false],
      ["context-meetings", true],
    ]);
  });

  test("an unreadable settings file says every row is a default", () => {
    const container = card(ready({ settingsError: "not valid JSON" }));
    expect(container.querySelector("[data-testid='context-plugins-settings-error']")).not.toBeNull();
    expect(container.textContent).toContain("not valid JSON");
  });

  test("a failure here says the notes are unaffected", () => {
    const container = card({ state: "failed", reason: "storage: 403" });
    expect(container.textContent).toContain("storage: 403");
    expect(container.textContent).toContain("notes are unaffected");
  });

  test("typing narrows the list and says so when nothing is left", () => {
    expect(card(ready(), "meet").textContent).not.toContain("Markdown forms");
    const empty = card(ready(), "templater");
    expect(empty.querySelector("[data-testid='context-plugins-empty']")).not.toBeNull();
    expect(empty.textContent).toContain("templater");
  });
});

const NO_GRANTS: GrantsView = { grants: [], loading: false };
const NO_BROWSE: BrowseView = { query: "", limit: 20, searching: false, failure: null };
const NO_RUNTIME: RuntimeView = { states: [], loading: false };

function panel(view: PluginsView, contextPlugins: ContextPluginsView = ready()): HTMLElement {
  return mount(
    createElement(PluginsPanel, {
      view,
      contextPlugins,
      grants: NO_GRANTS,
      browse: NO_BROWSE,
      runtime: NO_RUNTIME,
    }),
  );
}

describe("the built-ins survive every state the vault half can be in", () => {
  /*
    The property the restructure exists for. Each of these used to end the
    panel, in a context that was running four plugins at the time — so each one
    is checked by name rather than by a loop, because a loop over states is the
    thing a future early return would silently pass.
  */
  test("a reader the inventory is withheld from still sees what their context runs", () => {
    const container = panel({ state: "withheld" });
    expect(container.textContent).toContain("Only an owner can read this");
    expect(container.textContent).toContain("Markdown forms");
  });

  test("a bucket with no .obsidian/ at all still shows its Context plugins", () => {
    const container = panel({
      state: "ready",
      inventory: { found: 0, scanned: 0, truncated: false, checkedAt: "2026-09-14", plugins: [] },
    });
    expect(container.textContent).toContain("No Obsidian plugins in this bucket");
    expect(container.textContent).toContain("Markdown forms");
  });

  test("a storage failure reading the vault does not take them down with it", () => {
    const container = panel({ state: "failed", reason: "storage: 403" });
    expect(container.textContent).toContain("storage: 403");
    expect(container.textContent).toContain("Markdown forms");
  });

  test("a scan nobody has run does not hide them behind a button", () => {
    const container = panel({ state: "idle" });
    expect(container.textContent).toContain("Read my plugins");
    expect(container.textContent).toContain("Markdown forms");
  });
});

describe("one box and one filter over both halves", () => {
  function press(container: HTMLElement, testID: string) {
    const node = container.querySelector(`[data-testid='${testID}']`);
    act(() => {
      node?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  test("the Context filter puts the vault half away, and back", () => {
    const container = panel({ state: "withheld" });
    press(container, "plugins-filter-context");
    expect(container.textContent).toContain("Markdown forms");
    expect(container.textContent).not.toContain("Only an owner can read this");
    press(container, "plugins-filter-all");
    expect(container.textContent).toContain("Only an owner can read this");
  });

  test("the Obsidian filter puts the built-ins away", () => {
    const container = panel({ state: "withheld" });
    press(container, "plugins-filter-obsidian");
    expect(container.textContent).not.toContain("Markdown forms");
    expect(container.textContent).toContain("Only an owner can read this");
  });

  test("the current filter is marked by a glyph as well as a tint", () => {
    // The accent is the same hue links use, which is not a safe distinguisher
    // on its own — the rule `AppearancePanel`'s own chips follow.
    const container = panel({ state: "withheld" });
    const all = container.querySelector("[data-testid='plugins-filter-all']");
    expect(all?.textContent).toContain("✓");
    expect(all?.getAttribute("aria-label")).toContain("showing");
  });
});
