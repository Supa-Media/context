/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * `useNoteUrl` writes a plain `?note=` with no anchor of its own — see its
 * own comment. An anchor is embedded inside a `note` value (`path#anchor`,
 * the shape a per-message search hit and a contact's activity link both
 * produce), not a second query key, so overwriting `note` here replaces
 * whatever it held, anchor included, the same as writing any other single
 * value would.
 */
describe("useNoteUrl", () => {
  const calls: Record<string, unknown>[] = [];
  const setParams = (params: Record<string, unknown>) => calls.push(params);

  jest.mock("expo-router", () => ({
    useNavigation: () => ({ setParams }),
  }));

  const roots: (() => void)[] = [];
  afterEach(() => {
    while (roots.length > 0) roots.pop()!();
    document.body.innerHTML = "";
    calls.length = 0;
  });

  function mount(): (note: string | null) => void {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { useNoteUrl } = require("../features/console/useNoteUrl") as typeof import("../features/console/useNoteUrl");
    let address: ((note: string | null) => void) | null = null;
    function Probe() {
      address = useNoteUrl();
      return null;
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(() => {
      act(() => root.unmount());
      container.remove();
    });
    act(() => {
      root.render(createElement(Probe));
    });
    if (address === null) throw new Error("useNoteUrl did not return a callback");
    return address;
  }

  test("writing a note writes only the note", () => {
    const address = mount();
    act(() => address("1-projects/a.md"));
    expect(calls.at(-1)).toEqual({ note: "1-projects/a.md" });
  });

  test("clearing the note (closing) clears it", () => {
    const address = mount();
    act(() => address(null));
    expect(calls.at(-1)).toEqual({ note: undefined });
  });
});
