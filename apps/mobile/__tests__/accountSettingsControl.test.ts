/**
 * @jest-environment jsdom
 */

/**
 * **There has to be a settings button somebody can see.**
 *
 * Settings shipped as an overlay with no visible way in. The entry points
 * were: the storage chip in the top bar, which is pointer-only and reads as a
 * status rather than a control; a long press or right-click on a context row,
 * which nobody discovers; and a "Connect a bucket" button in Browse that
 * exists only while there is no bucket — so once storage was connected, on a
 * phone, there was no control at all. Every test passed.
 *
 * That is the shape of failure this file exists for: the routing was right,
 * the sections were right, and the feature was unreachable. A person looks for
 * settings near their own name, so it lives beside the sign-out it has always
 * sat next to, and this asserts it is drawn at both densities.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { AccountBlock } from "../features/console/ConsoleRail";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

function mount(props: Parameters<typeof AccountBlock>[0]): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(createElement(AccountBlock, props));
  });
  return container;
}

const BASE = {
  name: "@seyi",
  detail: "seyi@example.invalid",
  initial: "S",
  onSignOut: () => {},
};

describe("the way into settings is on screen", () => {
  test("the rail draws it beside sign-out", () => {
    const host = mount({ ...BASE, onOpenSettings: () => {} });
    expect(host.querySelector('[data-testid="rail-settings"]')).not.toBeNull();
    // Both, not one instead of the other: signing out and opening settings are
    // different intentions and must not share a control.
    expect(host.querySelector('[data-testid="rail-sign-out"]')).not.toBeNull();
  });

  test("the pinned phone form draws it too", () => {
    // The density with no gear, no storage chip and no right-click. Before
    // this, a phone with a bucket connected could not reach settings at all.
    const host = mount({ ...BASE, compact: true, onOpenSettings: () => {} });
    expect(host.querySelector('[data-testid="account-settings"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="account-sign-out"]')).not.toBeNull();
  });

  test("pressing it asks for settings, not for sign-out", () => {
    let opened = 0;
    let signedOut = 0;
    const host = mount({
      ...BASE,
      onSignOut: () => {
        signedOut += 1;
      },
      onOpenSettings: () => {
        opened += 1;
      },
    });
    act(() => {
      (host.querySelector('[data-testid="rail-settings"]') as HTMLElement).click();
    });
    expect(opened).toBe(1);
    expect(signedOut).toBe(0);
  });

  test("absent where there is no context to have settings", () => {
    // On the landing page's picture of a console, and before a context is
    // selected, there is nothing for it to open — so it is not drawn rather
    // than drawn and inert.
    const host = mount(BASE);
    expect(host.querySelector('[data-testid="rail-settings"]')).toBeNull();
    expect(host.querySelector('[data-testid="rail-sign-out"]')).not.toBeNull();
  });
});
