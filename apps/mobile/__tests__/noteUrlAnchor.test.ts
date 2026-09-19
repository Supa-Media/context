/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * `useNoteUrl` writes `?note=` — and decides whether the browser's own back
 * button gets a history entry for it.
 *
 * ## The anchor half, which is unchanged
 *
 * It writes a plain `?note=` with no anchor of its own — see its own comment.
 * An anchor is embedded inside a `note` value (`path#anchor`, the shape a
 * per-message search hit and a contact's activity link both produce), not a
 * second query key, so overwriting `note` here replaces whatever it held,
 * anchor included, the same as writing any other single value would.
 *
 * ## The half this file gained
 *
 * Every write used to be `setParams`, which replaces, so the address bar was a
 * label on the current screen rather than a record of where anybody had been —
 * and the browser's back button left the console from the third note as surely
 * as from the first. A navigation is a real `router.push` now. Which of the
 * two a write is comes from `noteAddress.ts`; what is asserted here is that
 * this hook carries it out, and the three conditions under which it declines
 * to.
 *
 * `Platform.OS` is `"web"` under jsdom, which is the platform the push is for:
 * a push on a native stack is a *screen*, and four followed links would be
 * four panes stacked on each other. `nativePush` below is the test that says
 * so.
 */
describe("useNoteUrl", () => {
  const calls: Record<string, unknown>[] = [];
  const pushed: string[] = [];
  const setParams = (params: Record<string, unknown>) => calls.push(params);

  jest.mock("expo-router", () => ({
    useNavigation: () => ({ setParams }),
    useRouter: () => ({ push: (href: string) => pushed.push(href) }),
  }));

  const roots: (() => void)[] = [];
  afterEach(() => {
    while (roots.length > 0) roots.pop()!();
    document.body.innerHTML = "";
    calls.length = 0;
    pushed.length = 0;
  });

  function mount(
    options: { slug?: string | null; pushable?: boolean } = {},
  ): (note: string | null, mode: "push" | "replace") => void {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { useNoteUrl } = require("../features/console/useNoteUrl") as typeof import("../features/console/useNoteUrl");
    let address: ((note: string | null, mode: "push" | "replace") => void) | null = null;
    function Probe() {
      address = useNoteUrl(options.slug === undefined ? "@seyi" : options.slug, options.pushable ?? true);
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

  describe("a correction, which is what every write used to be", () => {
    test("writing a note writes only the note", () => {
      const address = mount();
      act(() => address("1-projects/a.md", "replace"));
      expect(calls.at(-1)).toEqual({ note: "1-projects/a.md" });
      expect(pushed).toEqual([]);
    });

    test("clearing the note (closing) clears it", () => {
      const address = mount();
      act(() => address(null, "replace"));
      expect(calls.at(-1)).toEqual({ note: undefined });
      expect(pushed).toEqual([]);
    });
  });

  describe("a navigation, which the browser's back button walks", () => {
    test("pushes the note's own address", () => {
      const address = mount();
      act(() => address("1-projects/a.md", "push"));
      expect(pushed).toEqual(["/console/@seyi?note=1-projects%2Fa.md"]);
      // And it does NOT also write the parameter: two writes for one move is
      // two history entries, and back would need two presses to go anywhere.
      expect(calls).toEqual([]);
    });

    test("a navigation to the context's root pushes the bare context", () => {
      const address = mount();
      act(() => address(null, "push"));
      expect(pushed).toEqual(["/console/@seyi"]);
      expect(calls).toEqual([]);
    });

    test("degrades to the parameter write when the address is carrying more than a note", () => {
      /*
        `pushable` is false with the settings overlay open or a query in the
        address. A push builds a fresh address out of the context and the note
        alone, so it would drop them — closing the settings panel as a side
        effect of the open note changing underneath it, which is the defect
        that overlay exists to avoid.
      */
      const address = mount({ pushable: false });
      act(() => address("1-projects/a.md", "push"));
      expect(pushed).toEqual([]);
      expect(calls.at(-1)).toEqual({ note: "1-projects/a.md" });
    });

    test("and when the route has not resolved its context yet", () => {
      // There is no href to push without a slug. `setParams` needs none, so
      // the write still happens rather than being dropped.
      const address = mount({ slug: null });
      act(() => address("1-projects/a.md", "push"));
      expect(pushed).toEqual([]);
      expect(calls.at(-1)).toEqual({ note: "1-projects/a.md" });
    });
  });
});
