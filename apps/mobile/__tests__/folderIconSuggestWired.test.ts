/**
 * @jest-environment jsdom
 */

/**
 * The picker's Suggested cell is drawn only when the file browser carries
 * `suggestIcon`. On 2026-10-14 the hook made it but the browser value left it
 * out, so the real app never asked and showed Random alone. This mounts the
 * value builder with every input stubbed and checks the suggestion comes
 * through.
 *
 * Sabotage: dropping `suggestIcon` from `useFileBrowserValue` fails it.
 */

import { expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { FileBrowser } from "../features/console/files/browser/contract";
import { useFileBrowserValue } from "../features/console/files/fileBrowser/useFileBrowserValue";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test("the file browser carries the suggestion the picker asks for", () => {
  const suggestIcon = async () => "🧾";
  // Every other input is a stand-in that answers anything with itself and
  // iterates as empty; only what reaches the browser matters here.
  const anything: unknown = new Proxy(() => anything, {
    get: (_, key) => (key === Symbol.iterator ? [][Symbol.iterator].bind([]) : key === Symbol.toPrimitive ? () => 0 : anything),
    apply: () => anything,
  });
  const deps = new Proxy({ options: anything, suggestIcon } as Record<string, unknown>, {
    get: (target, key) => (key in target ? target[key as string] : anything),
  });
  let browser: FileBrowser | null = null;
  function Probe() {
    browser = useFileBrowserValue(deps as never);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(createElement(Probe)));
  expect(browser!.suggestIcon).toBe(suggestIcon);
  act(() => root.unmount());
});
