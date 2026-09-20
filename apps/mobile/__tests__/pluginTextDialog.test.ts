/**
 * @jest-environment jsdom
 *
 * THE PLAIN DIALOG A PLUGIN ASKED FOR, AS THE READER SEES IT.
 *
 * `pluginSandboxGuest.test.ts` proves the half that matters for safety — the
 * plugin builds into a `contentEl` inside the sandbox and only its text
 * crosses. This proves the half that makes it a feature rather than a stub:
 * the text is drawn, whoever is showing it is named, and the reader can always
 * get out.
 *
 * A stub is exactly what this exists instead of. `Modal` had to be a real class
 * or the bundle never finished evaluating, and a real class that drew nothing
 * would have been "present and inert" — the plugin loads, somebody presses its
 * command, and nothing happens anywhere.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { SafeAreaProvider, initialWindowMetrics } from "react-native-safe-area-context";
import { PluginTextDialog } from "../features/console/plugins/PluginTextDialog";
import type { RuntimeView } from "../features/console/plugins/runtime";

const METRICS = initialWindowMetrics ?? {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const roots: Array<() => void> = [];
afterEach(() => {
  while (roots.length) roots.pop()?.();
});

/*
  Hands back `document.body`, not the container: `Modal` on react-native-web
  renders through a portal appended to the body, so a query scoped to the
  container finds nothing — and finds it for every assertion equally, which is
  how an empty dialog and a working one look identical. The same trap
  `pluginSuggestDialog.test.ts` records falling into.
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
    textModal: {
      pluginId: "obsidian-bible-reference",
      nonce: "n1",
      title: "Genesis 1:1",
      text: "In the beginning God created the heaven and the earth.",
    },
    actions: {
      start: async () => {},
      stop: async () => {},
      run: () => {},
      dismissTextModal: () => {},
    } as NonNullable<RuntimeView["actions"]>,
    ...over,
  };
}

describe("the plain dialog a plugin asked for", () => {
  test("nothing is drawn until a plugin opens one", () => {
    const body = mount(createElement(PluginTextDialog, { runtime: view({ textModal: null }) }));
    expect(body.querySelector("[data-testid='plugin-text-dialog']")).toBeNull();
  });

  test("the title and the body are the plugin's, and both are drawn", () => {
    const body = mount(createElement(PluginTextDialog, { runtime: view() }));
    expect(body.querySelector("[data-testid='plugin-text-title']")?.textContent).toBe("Genesis 1:1");
    expect(body.querySelector("[data-testid='plugin-text-body']")?.textContent).toContain(
      "In the beginning",
    );
  });

  test("and whoever is showing it is named", () => {
    const body = mount(createElement(PluginTextDialog, { runtime: view() }));
    expect(body.textContent).toContain("obsidian-bible-reference");
  });

  /*
    A dialog is sent the moment it opens, before a plugin fetching its content
    has anything to put in it. That window is real and short, and an empty box
    in it reads as broken.
  */
  test("an empty dialog says so rather than drawing an empty box", () => {
    const body = mount(
      createElement(PluginTextDialog, {
        runtime: view({
          textModal: { pluginId: "p", nonce: "n1", title: "", text: "" },
        }),
      }),
    );
    expect(body.querySelector("[data-testid='plugin-text-empty']")).not.toBeNull();
    expect(body.querySelector("[data-testid='plugin-text-title']")).toBeNull();
  });

  test("the reader can get out by the button", () => {
    const closed = jest.fn();
    const body = mount(
      createElement(PluginTextDialog, {
        runtime: view({
          actions: {
            start: async () => {},
            stop: async () => {},
            run: () => {},
            dismissTextModal: closed,
          } as NonNullable<RuntimeView["actions"]>,
        }),
      }),
    );
    act(() => {
      body
        .querySelector("[data-testid='plugin-text-close']")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(closed).toHaveBeenCalled();
  });

  test("and by pressing outside it", () => {
    const closed = jest.fn();
    const body = mount(
      createElement(PluginTextDialog, {
        runtime: view({
          actions: {
            start: async () => {},
            stop: async () => {},
            run: () => {},
            dismissTextModal: closed,
          } as NonNullable<RuntimeView["actions"]>,
        }),
      }),
    );
    act(() => {
      body
        .querySelector("[aria-label='Close']")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(closed).toHaveBeenCalled();
  });

  /*
    A viewer who is not the owner has no runtime, and neither does the landing
    page. Reaching into it was a crash that took the whole console down with it
    when the suggestion dialog shipped; the same shape must not arrive twice.
  */
  test("a console with no plugin runtime at all draws nothing", () => {
    const body = mount(createElement(PluginTextDialog, { runtime: undefined }));
    expect(body.querySelector("[data-testid='plugin-text-dialog']")).toBeNull();
  });
});
