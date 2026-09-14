/**
 * @jest-environment jsdom
 */

/**
 * An editor command is not a button that is always pressable.
 *
 * ## What this fixes, and how it was found
 *
 * Seyi, looking at YouVersion Linker's card: *"I don't think that is supposed
 * to be a command surfaced to the user."* Half right, and the half that is
 * wrong is the interesting one.
 *
 * `Generate links` **is** a real user-facing command — the plugin registers it
 * with `addCommand({ id, name, editorCallback })`, which is exactly how an
 * Obsidian plugin puts an entry in the command palette, and #545 made it work
 * here end to end. What it is not is a command that can run at any time:
 * `editorCallback` means it operates on the note you have open, and **Obsidian
 * filters editor commands out of the palette when no editor is focused.**
 *
 * Context surfaced it as a button that is always visible and conditionally
 * broken. Press it with nothing open and the guest throws `Open a note before
 * running this command` — a refusal delivered *after* the press, for a
 * precondition the console could see before drawing the control. That is the
 * shape this section has refused everywhere else: a control whose only outcome
 * is an error teaches somebody the product is broken.
 *
 * And it edits the note you have open, which the card never said. "Generate
 * links" reads like it generates something somewhere; it rewrites your active
 * file in place.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { PluginRuntimeCard } from "../features/console/settings/panels/PluginRuntimeCard";
import { EDITOR_COMMAND_HINT, editorCommandState } from "../features/console/plugins/runtime";
import type {
  PluginRegistration,
  RuntimeState,
  RuntimeView,
} from "../features/console/plugins/runtime";
import type { GrantsView } from "../features/console/plugins/grants";
import type { ConsolePlugin } from "../features/console/plugins/plugins";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

const GENERATE: PluginRegistration = {
  kind: "command",
  id: "generate-links",
  name: "Generate links",
  needsEditor: true,
};

const ANYTIME: PluginRegistration = {
  kind: "command",
  id: "sync-now",
  name: "Sync now",
  needsEditor: false,
};

describe("what an editor command needs before it can run", () => {
  test("a command that takes no editor is pressable with nothing open", () => {
    const state = editorCommandState(ANYTIME, null);
    expect(state.runnable).toBe(true);
    expect(state.hint).toBeNull();
    expect(state.label).toBe("Command · Sync now");
  });

  /*
    The target in the label, because "Generate links" does not say what it
    changes. The basename rather than the whole path: a button is not the place
    for `1-projects/sermons/2026/john-3.md`, and the hint carries the rest.
  */
  test("an editor command names the note it will edit", () => {
    const state = editorCommandState(GENERATE, "1-projects/sermons/john-3.md");
    expect(state.runnable).toBe(true);
    expect(state.label).toBe("Command · Generate links → john-3.md");
    expect(state.hint).toBeNull();
  });

  /*
    The precondition the console could always see. Obsidian filters these out
    of its palette entirely; drawing it disabled with the reason is the same
    honesty with the name kept visible, so somebody knows the plugin has it.
  */
  test("with no note open it is not pressable, and says why", () => {
    const state = editorCommandState(GENERATE, null);
    expect(state.runnable).toBe(false);
    expect(state.label).toBe("Command · Generate links");
    expect(state.hint).toBe(EDITOR_COMMAND_HINT);
  });

  test("an unknown open note is treated as none rather than guessed at", () => {
    expect(editorCommandState(GENERATE, undefined).runnable).toBe(false);
  });

  /*
    A guest older than this field reports no `needsEditor`. Reading that as
    "takes an editor" would disable every command on every card; reading it as
    "does not" restores exactly today's behaviour, and the guest still refuses
    the call itself. So absence means false.
  */
  test("a registration from before this field behaves as it does today", () => {
    const legacy = { kind: "command", id: "old", name: "Old" } as PluginRegistration;
    expect(editorCommandState(legacy, null).runnable).toBe(true);
  });

  test("a ribbon action is never editor-scoped", () => {
    const ribbon: PluginRegistration = {
      kind: "ribbon",
      id: "ribbon-0",
      name: "Do it",
      needsEditor: false,
    };
    expect(editorCommandState(ribbon, null).label).toBe("Ribbon · Do it");
  });
});

/* -------------------------------------------------------------------------- */

const PLUGIN: ConsolePlugin = {
  id: "youversion-linker",
  source: "obsidian",
  bundleFingerprint: "fp-1",
  name: "YouVersion Linker",
  verdict: "needs-approval",
  evidence: [],
  limitations: [],
  notes: [],
};

const GRANTS: GrantsView = {
  loading: false,
  egress: true,
  grants: [{
    pluginId: "youversion-linker",
    bundleFingerprint: "fp-1",
    capabilities: ["vault:read", "vault:write", "network:request"],
    networkHosts: ["www.bible.com"],
    status: "active",
    grantedAt: 1,
    updatedAt: 1,
  }],
};

const LOADED: RuntimeState = {
  pluginId: "youversion-linker",
  bundleFingerprint: "fp-1",
  status: "loaded",
  attempts: 1,
  updatedAt: 1,
};

function card(view: RuntimeView): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(createElement(PluginRuntimeCard, { plugin: PLUGIN, view, grants: GRANTS }));
  });
  roots.push(() => act(() => root.unmount()));
  return host;
}

function generateButton(host: HTMLElement): Element | undefined {
  return [...host.querySelectorAll("[role='button']")].find((one) =>
    (one.textContent ?? "").includes("Generate links"),
  );
}

function base(openNote: string | null, run: (pluginId: string, id: string) => void): RuntimeView {
  return {
    loading: false,
    states: [LOADED],
    openNote,
    registrations: { "youversion-linker": [GENERATE] },
    actions: { start: async () => {}, stop: async () => {}, run },
  };
}

describe("the card draws the precondition instead of discovering it", () => {
  test("with a note open, the button names it and is pressable", () => {
    const host = card(base("1-projects/sermons/john-3.md", () => {}));
    const button = generateButton(host);
    expect(button).toBeDefined();
    expect(button?.textContent).toContain("john-3.md");
    expect(button?.getAttribute("aria-disabled")).not.toBe("true");
    expect(host.textContent).not.toContain(EDITOR_COMMAND_HINT);
  });

  /*
    The point of the whole change: no press, no round trip to the guest, no
    error afterwards. The reason is on screen before anybody reaches for it.
  */
  test("with nothing open, the button is disabled and the reason is on the card", () => {
    const host = card(base(null, () => {}));
    const button = generateButton(host);
    expect(button).toBeDefined();
    expect(button?.getAttribute("aria-disabled")).toBe("true");
    expect(host.textContent).toContain(EDITOR_COMMAND_HINT);
  });

  test("pressing a disabled editor command does nothing", () => {
    const pressed: string[] = [];
    const host = card(base(null, (_pluginId, id) => pressed.push(id)));
    act(() => {
      generateButton(host)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(pressed).toEqual([]);
  });

  test("with a note open the press still reaches the runtime", () => {
    const pressed: string[] = [];
    const host = card(base("1-projects/sermons/john-3.md", (_pluginId, id) => pressed.push(id)));
    act(() => {
      generateButton(host)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(pressed).toEqual(["generate-links"]);
  });
});
