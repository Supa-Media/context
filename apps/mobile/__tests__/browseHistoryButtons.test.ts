/**
 * @jest-environment jsdom
 */

/**
 * `‹ ›` IN THE TITLE ROW OVER THE FILE TREE, ON A POINTER.
 *
 * The console has held a history of where somebody has been since the phone's
 * toolbar was built — `features/console/files/history.ts`, a browser-shaped
 * cursor into a list of places, with its own suite. On a desktop it was once
 * complete, correct, tested, and unreachable: a route with no way in, which a
 * reducer test cannot catch because the reducer was never wrong.
 *
 * The pair then lived at the head of the note's breadcrumb, which only a note
 * or folder page drew. Since the owner chose the fuller left column
 * (2026-09-26) they are in the title row above the file tree — `AppFrame`'s
 * `history` — on every console page. This mounts the real frame at a pointer
 * width and asserts the controls are **on the screen** and wired to what they
 * were handed, and that the breadcrumb no longer draws a second pair.
 *
 * `noteChrome.test.ts` is the compact half: the bottom bar carries the pair
 * under the thumb, so the frame draws neither at a phone width.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("convex/react", () => ({
  useConvex: () => ({ query: async () => undefined }),
  useAction: () => async () => {
    throw new Error("not used in this test");
  },
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from "react";
import type { FrameHistory } from "../features/app/AppFrame";
import { mountFrame } from "./appFrameRender/fixtures";

const unmounts: (() => void)[] = [];
afterEach(() => {
  while (unmounts.length > 0) unmounts.pop()!();
});

function historyWith(over: Partial<FrameHistory> = {}): FrameHistory & { went: string[] } {
  const went: string[] = [];
  return {
    went,
    onBack: () => went.push("back"),
    onForward: () => went.push("forward"),
    canBack: true,
    canForward: true,
    ...over,
  };
}

function mount(history: FrameHistory | undefined, width = 1440, explorer = true) {
  const frame = mountFrame(width, "the note", {
    explorer,
    ...(history === undefined ? {} : { history }),
  });
  unmounts.push(frame.unmount);
  return frame;
}

function click(node: HTMLElement | null) {
  act(() => {
    node?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("the pointer layout has a back button at all", () => {
  test("both are drawn in the title row over the file tree", () => {
    const frame = mount(historyWith());
    const head = frame.find("frame-column-head");
    expect(head).not.toBeNull();
    expect(head!.querySelector('[data-testid="frame-back"]')).not.toBeNull();
    expect(head!.querySelector('[data-testid="frame-forward"]')).not.toBeNull();
    // With the tree's own toggle at the far end of the same row.
    expect(head!.querySelector('[data-testid="frame-toggle-explorer"]')).not.toBeNull();
  });

  test("an available step is not announced as disabled", () => {
    const frame = mount(historyWith());
    expect(frame.find("frame-back")?.getAttribute("aria-disabled")).toBeNull();
  });

  test("pressing back walks the console's own history", () => {
    const history = historyWith();
    const frame = mount(history);
    click(frame.find("frame-back"));
    expect(history.went).toEqual(["back"]);
  });

  test("pressing forward does too", () => {
    const history = historyWith();
    const frame = mount(history);
    click(frame.find("frame-forward"));
    expect(history.went).toEqual(["forward"]);
  });

  test("at the ends of the history they are dimmed IN PLACE, not removed", () => {
    /*
      These two spend most of a session with at least one of them unavailable,
      and a row whose first two positions come and go moves the toggle beside
      them each time somebody navigates.
    */
    const history = historyWith({ canBack: false, canForward: false });
    const frame = mount(history);
    const back = frame.find("frame-back");
    expect(back).not.toBeNull();
    click(back);
    expect(history.went).toEqual([]);
    expect(back?.getAttribute("aria-disabled")).toBe("true");
    expect(frame.find("frame-forward")?.getAttribute("aria-disabled")).toBe("true");
  });

  test("a frame handed no history draws neither", () => {
    // The landing page's picture of the console has nowhere to go. A control
    // that is present and does nothing is worse than none.
    const frame = mount(undefined);
    expect(frame.find("frame-back")).toBeNull();
    expect(frame.find("frame-forward")).toBeNull();
  });

  test("with no tree on the route, they lead the bar instead", () => {
    const frame = mount(historyWith(), 1440, false);
    expect(frame.find("frame-column-head")).toBeNull();
    expect(frame.find("frame-back")).not.toBeNull();
  });
});

describe("the phone is not given a second copy", () => {
  test("at compact width the frame draws neither, because the bottom bar has them", () => {
    const frame = mount(historyWith(), 390);
    expect(frame.find("frame-back")).toBeNull();
    expect(frame.find("frame-forward")).toBeNull();
  });
});
