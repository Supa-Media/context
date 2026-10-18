/**
 * @jest-environment jsdom
 */

/**
 * A hold on phone Home never pins by itself (owner, 2026-10-15: *"Ive never
 * pinned a note before why do i have notes in my pins?"*). Home's tiles and
 * rows used to toggle a pin on a long press, with nothing on screen to say so,
 * so a thumb resting on a row while scrolling pinned it. Now a hold asks for
 * the row's own menu, where Pin is one verb among the rest, as a hold on a
 * folder page's row already did.
 *
 * SABOTAGE: wiring a tile's `onLongPress` straight to a pin again (there is no
 * `onTogglePin` prop to pass any more) or dropping `held()` in `homeRows.tsx`
 * fails the first test.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PhoneHome } from "../features/console/home/PhoneHome";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  useSafeAreaFrame: () => ({ x: 0, y: 0, width: 390, height: 844 }),
}));

const roots: (() => void)[] = [];

function mount(element: ReactElement): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => root.render(element));
  return container;
}

afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  jest.useRealTimers();
});

const source = {
  notes: [{ path: "2-areas/activity.md", title: "Activity", updatedAt: 1 }],
  folders: ["2-areas"],
  shared: new Set<string>(),
};

function home(onHold?: (path: string, at: { x: number; y: number }) => void) {
  return createElement(PhoneHome, {
    title: "shyoh",
    source,
    pins: [{ path: "2-areas/activity.md", kind: "note" as const }],
    opened: [],
    recents: [],
    onOpen: () => {},
    ...(onHold === undefined ? {} : { onHold }),
  } as never);
}

/** A press held past React Native Web's long-press delay. */
function holdDown(node: Element) {
  act(() => {
    node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  });
  act(() => {
    jest.advanceTimersByTime(800);
  });
  act(() => {
    node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
  });
}

describe("holding a row on phone Home", () => {
  test("asks for that row's menu, with where it was held, and pins nothing", () => {
    jest.useFakeTimers();
    const held: string[] = [];
    const container = mount(home((path) => held.push(path)));
    const folder = container.querySelector('[data-testid="phone-home-folder"]');
    expect(folder).not.toBeNull();
    holdDown(folder!);
    expect(held).toEqual(["2-areas"]);
  });

  test("a visitor's Home has no hold at all", () => {
    jest.useFakeTimers();
    const container = mount(home(undefined));
    const folder = container.querySelector('[data-testid="phone-home-folder"]');
    expect(() => holdDown(folder!)).not.toThrow();
  });
});
