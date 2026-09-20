/**
 * @jest-environment jsdom
 *
 * THE DIALOG A PLUGIN ASKED FOR, AS THE READER SEES IT.
 *
 * `pluginSandboxGuest.test.ts` proves the half that matters for safety: the
 * plugin's own `getSuggestions` and `renderSuggestion` run in the sandbox and
 * only text crosses. This proves the half that matters for it being a feature —
 * that the text is drawn, that a press is routed back as an index, and that the
 * reader can always get out.
 *
 * The three properties here:
 *
 *  1. **It is absent until a plugin asks.** A dialog surface that renders
 *     anything at rest is one sitting over every pane of the console.
 *  2. **The rows are the plugin's, in the plugin's order.** This is why it is
 *     not `Palette`: ranking them here would reorder somebody else's answers
 *     and drop the ones whose text does not contain the query — which is most
 *     of them, since "Gen 1:1" does not appear in the verse it returns.
 *  3. **Whoever is asking is named.** A reader is being asked to choose
 *     something by third-party code.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { SafeAreaProvider, initialWindowMetrics } from "react-native-safe-area-context";
import { PluginSuggestDialog } from "../features/console/plugins/PluginSuggestDialog";
import type { RuntimeView } from "../features/console/plugins/runtime";

/** The dialog reaches for safe-area insets, and that hook throws outside a provider. */
const METRICS = initialWindowMetrics ?? {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const roots: Array<() => void> = [];
afterEach(() => {
  while (roots.length) roots.pop()?.();
});

/*
  Mounts, and hands back `document.body` rather than the container.

  `Modal` on react-native-web renders through a portal appended to the body, so
  a query scoped to the container finds nothing — and finds it for every
  assertion equally, which is how an empty dialog and a working one look
  identical. Found by a passing test that should not have passed.
*/
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

function view(over: Partial<RuntimeView> = {}): RuntimeView {
  return {
    loading: false,
    modal: {
      pluginId: "obsidian-bible-reference",
      nonce: "n1",
      placeholder: "Find a verse",
      instructions: [{ command: "↵", purpose: "insert" }],
    },
    ...over,
  };
}

function actions(over: Partial<NonNullable<RuntimeView["actions"]>> = {}) {
  return {
    start: async () => {},
    stop: async () => {},
    run: () => {},
    askModalSuggestions: async () => [{ text: "Genesis 1:1 — In the beginning" }, { text: "Genesis 1:2" }],
    pickModalSuggestion: () => {},
    dismissModal: () => {},
    ...over,
  } as NonNullable<RuntimeView["actions"]>;
}

/** Let the effect's await on `askModalSuggestions` settle. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("the dialog a plugin asked for", () => {
  test("nothing is drawn until a plugin asks for one", () => {
    const container = mount(
      createElement(PluginSuggestDialog, { runtime: view({ modal: null, actions: actions() }) }),
    );
    // Not "the body is empty" — other tests share this document. The dialog's
    // own marker is what must be absent.
    expect(container.querySelector("[data-testid='plugin-suggest-dialog']")).toBeNull();
    expect(container.querySelector("[data-testid='plugin-suggest-query']")).toBeNull();
  });

  test("the rows are the plugin's, in the plugin's order", async () => {
    const container = mount(
      createElement(PluginSuggestDialog, { runtime: view({ actions: actions() }) }),
    );
    await settle();
    const rows = Array.from(container.querySelectorAll("[data-testid^='plugin-suggest-row-']"));
    expect(rows.map((row) => row.textContent)).toEqual([
      "Genesis 1:1 — In the beginning",
      "Genesis 1:2",
    ]);
  });

  test("and whoever is asking is named on it", async () => {
    const container = mount(
      createElement(PluginSuggestDialog, { runtime: view({ actions: actions() }) }),
    );
    await settle();
    expect(container.textContent).toContain("obsidian-bible-reference");
    expect(container.textContent).toContain("insert");
  });

  test("pressing a row sends its index back, and nothing else", async () => {
    const picked: number[] = [];
    const container = mount(
      createElement(PluginSuggestDialog, {
        runtime: view({ actions: actions({ pickModalSuggestion: (index: number) => picked.push(index) }) }),
      }),
    );
    await settle();
    const second = container.querySelector("[data-testid='plugin-suggest-row-1']");
    act(() => {
      second?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(picked).toEqual([1]);
  });

  /*
    RENAMED AFTER A SABOTAGE IT SURVIVED.

    It read "a press on a row that is not there sends nothing" and pressed
    nothing — with no rows there is no row element, so deleting the component's
    own bounds check left it green. What it can honestly hold is the property
    one step earlier: an empty answer draws nothing pressable, so there is no
    row to aim at.

    The bounds check stays, and the half it guards — a pick arriving for an
    index the current list does not have — is held in the guest, by `a pick past
    the end of the current list chooses nothing`. That is the side that decides,
    because the guest owns the values.
  */
  test("an empty answer draws nothing to press", async () => {
    const picked: number[] = [];
    const container = mount(
      createElement(PluginSuggestDialog, {
        runtime: view({
          actions: actions({
            askModalSuggestions: async () => [],
            pickModalSuggestion: (index: number) => picked.push(index),
          }),
        }),
      }),
    );
    await settle();
    expect(container.querySelector("[data-testid='plugin-suggest-empty']")).not.toBeNull();
    expect(container.querySelectorAll("[data-testid^='plugin-suggest-row-']")).toHaveLength(0);
    expect(picked).toEqual([]);
  });

  test("the reader can always get out of it", async () => {
    const closed = jest.fn();
    const container = mount(
      createElement(PluginSuggestDialog, {
        runtime: view({ actions: actions({ dismissModal: closed }) }),
      }),
    );
    await settle();
    const scrim = container.querySelector("[aria-label='Close']");
    act(() => {
      scrim?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(closed).toHaveBeenCalled();
  });

  /*
    A plugin can open a dialog it is not allowed to answer for — a console with
    no actions is the landing page's demo, and a reader there must not press
    into nothing. Absent controls rather than dead ones, the rule the plugins
    panel already follows.
  */
  test("a console with no plugin runtime at all draws nothing", () => {
    // A viewer who is not the owner has no runtime, and neither does the
    // landing page. Reaching into it was a crash that took the whole console
    // down with it, which is how this arrived.
    const container = mount(createElement(PluginSuggestDialog, { runtime: undefined }));
    expect(container.querySelector("[data-testid='plugin-suggest-dialog']")).toBeNull();
  });

  test("a surface with no actions draws no dialog at all", () => {
    const container = mount(
      createElement(PluginSuggestDialog, { runtime: view({ actions: undefined }) }),
    );
    expect(container.querySelectorAll("[data-testid^='plugin-suggest-row-']")).toHaveLength(0);
  });
});

/*
  AND WHAT THE READER GETS WHEN THEIR PICK DID NOTHING.

  The report this whole path was repaired for was "I click on the verse and
  nothing happens" — which is what a pick with nowhere to write looks like from
  the outside: the row goes down, the dialog closes, the note is unchanged, and
  no surface anywhere says why. The dialog itself cannot carry the message,
  because the guest closes its own before running the plugin's handler, so this
  takes its place.
*/
describe("a pick that did nothing says so", () => {
  test("nothing is drawn while there is nothing to report", () => {
    const container = mount(
      createElement(PluginSuggestDialog, {
        runtime: view({ modal: null, pickFailure: null, actions: actions() }),
      }),
    );
    expect(container.querySelector("[data-testid='plugin-pick-failed']")).toBeNull();
  });

  test("the reason is Context's sentence, and the plugin is named beside it", () => {
    const container = mount(
      createElement(PluginSuggestDialog, {
        runtime: view({
          modal: null,
          pickFailure: { pluginId: "obsidian-bible-reference", reason: "not-allowed" },
          actions: actions(),
        }),
      }),
    );
    const note = container.querySelector("[data-testid='plugin-pick-failed-note']");
    expect(note?.textContent).toContain("not allowed to change your notes");
    /*
      Whose refusal this is. The panel is Context's words about a named
      plugin — never the plugin's words, which is the rule every surface in
      this feature keeps.
    */
    expect(container.textContent).toContain("obsidian-bible-reference");
  });

  test("no note open is a different sentence from not being allowed", () => {
    const container = mount(
      createElement(PluginSuggestDialog, {
        runtime: view({
          modal: null,
          pickFailure: { pluginId: "obsidian-bible-reference", reason: "no-note" },
          actions: actions(),
        }),
      }),
    );
    expect(
      container.querySelector("[data-testid='plugin-pick-failed-note']")?.textContent,
    ).toContain("nothing was open");
  });

  test("the reader can put it away", () => {
    let dismissed = 0;
    const container = mount(
      createElement(PluginSuggestDialog, {
        runtime: view({
          modal: null,
          pickFailure: { pluginId: "obsidian-bible-reference", reason: "failed" },
          actions: actions({ dismissPickFailure: () => { dismissed += 1; } }),
        }),
      }),
    );
    act(() => {
      container
        .querySelector("[data-testid='plugin-pick-failed-close']")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(dismissed).toBe(1);
  });

  /*
    A dialog on screen wins. The plugin reopened one from inside its own
    handler — the two-step flows do — and putting a complaint about the last
    pick over the question it is asking now would be answering the wrong thing.
  */
  test("a dialog the plugin reopened is drawn instead of the complaint", async () => {
    const container = mount(
      createElement(PluginSuggestDialog, {
        runtime: view({
          pickFailure: { pluginId: "obsidian-bible-reference", reason: "failed" },
          actions: actions(),
        }),
      }),
    );
    await settle();
    expect(container.querySelector("[data-testid='plugin-suggest-dialog']")).not.toBeNull();
    expect(container.querySelector("[data-testid='plugin-pick-failed']")).toBeNull();
  });
});
