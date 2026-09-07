/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * `useNoteUrl` always clears `?anchor=` when it writes `?note=` — see its own
 * comment for the stale-anchor bug this closes: `setParams` merges rather
 * than replaces, so writing `note` alone after a comms link had set both
 * would leave an old message's anchor attached to a new note.
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

  test("writing a note also clears anchor", () => {
    const address = mount();
    act(() => address("1-projects/a.md"));
    expect(calls.at(-1)).toEqual({ note: "1-projects/a.md", anchor: undefined });
  });

  test("clearing the note (closing) also clears anchor", () => {
    const address = mount();
    act(() => address(null));
    expect(calls.at(-1)).toEqual({ note: undefined, anchor: undefined });
  });
});
