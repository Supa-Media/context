/**
 * @jest-environment jsdom
 */

/**
 * Holding ‹ goes straight Home (owner, 2026-10-16: "sometimes i'm stuck in a
 * note deeply nested and it's like 5 taps to get home"); a press still goes
 * up one level.
 *
 * SABOTAGE: dropping `onLongPress` from `PhoneBack` fails the first test.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PhoneBack } from "../features/console/home/PhoneBack";
import { phoneBackLevels, type PhoneBackTarget } from "../features/console/home/phoneBack";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.();
  unmount = null;
  jest.useRealTimers();
});

function mount(levels: PhoneBackTarget[], gone: (string | null)[]): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(createElement(PhoneBack, { levels, onGo: (target) => gone.push(target.folder) })));
  unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
  return container.querySelector<HTMLElement>('[data-testid="phone-back"]')!;
}

function pressFor(node: Element, ms: number) {
  act(() => {
    node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  });
  act(() => {
    jest.advanceTimersByTime(ms);
  });
  act(() => {
    node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    node.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
  });
}

describe("holding the phone's back button", () => {
  test("from a deep note goes straight Home", () => {
    jest.useFakeTimers();
    const gone: (string | null)[] = [];
    const back = mount(phoneBackLevels("2-areas/health/runs/october.md"), gone);
    pressFor(back, 800);
    expect(gone).toEqual([null]);
  });

  test("a quick press still goes up one level", () => {
    jest.useFakeTimers();
    const gone: (string | null)[] = [];
    const back = mount(phoneBackLevels("2-areas/health/runs/october.md"), gone);
    pressFor(back, 50);
    expect(gone).toEqual(["2-areas/health/runs"]);
  });
});
