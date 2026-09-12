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
 *
 * ## The compact form stopped being two controls
 *
 * "the setting button should be merged with the person icon, right now all it
 * does is sign you out." It drew a gear and the avatar side by side, each its
 * own 44×44 pressable, and the avatar's `onPress` was `onSignOut` directly —
 * on a clean queue `useSignOutFlow` asks nothing first, so that corner was a
 * silent one-tap sign-out.
 *
 * **The paragraph this file used to make here read "Both, not one instead of
 * the other: signing out and opening settings are different intentions and
 * must not share a control."** That reasoning survives; what shares the
 * control changed. The harm it named was a control that ambiguously does one
 * thing *or* the other — the same 44×44 square meaning "settings" on one side
 * and "goodbye" on the other, told apart only by which half of a 4pt gap a
 * thumb landed in. A disclosure menu with two labelled rows is strictly more
 * explicit than that: pressing the avatar does one thing (open a menu naming
 * both), and choosing between them is a second, deliberate press on a row
 * that says the word. Two intentions still cannot be reached by one press —
 * they are reached by one press *and then a choice*, which is more distinct
 * than two adjacent circles ever were.
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

  test("the compact form is one control that opens a menu containing both", () => {
    // The density with no gear, no storage chip and no right-click. Before
    // this file existed, a phone with a bucket connected could not reach
    // settings at all; before this session, the avatar beside the gear signed
    // out on one press with nothing asked first.
    const host = mount({ ...BASE, compact: true, onOpenSettings: () => {} });

    // One trigger, not two adjacent pressables — and it says what pressing it
    // does before anybody does it.
    const trigger = host.querySelector('[data-testid="account-menu"]');
    expect(trigger).not.toBeNull();
    expect(trigger!.getAttribute("aria-label")).toBe("@seyi — account menu");
    expect(trigger!.getAttribute("role")).toBe("button");
    expect(trigger!.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger!.getAttribute("aria-expanded")).toBe("false");

    // Neither row exists yet — the menu is closed, and `Menu`'s sheet is a
    // `Modal` that portals to `document.body` once it is open, not before.
    expect(document.body.querySelector('[data-testid="account-settings"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="account-sign-out"]')).toBeNull();

    act(() => {
      (trigger as HTMLElement).click();
    });

    expect(trigger!.getAttribute("aria-expanded")).toBe("true");
    // Both rows, in the one menu the avatar opened.
    expect(document.body.querySelector('[data-testid="account-settings"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="account-sign-out"]')).not.toBeNull();
  });

  test("pressing the avatar does not sign out", () => {
    // The bug this file exists to close: the avatar was the sign-out button.
    // Opening the menu it now opens must not be that in disguise.
    let signedOut = 0;
    const host = mount({
      ...BASE,
      compact: true,
      onSignOut: () => {
        signedOut += 1;
      },
      onOpenSettings: () => {},
    });

    act(() => {
      (host.querySelector('[data-testid="account-menu"]') as HTMLElement).click();
    });

    expect(signedOut).toBe(0);
    // It opened something, at least — a press that did nothing at all would
    // pass this assertion for the wrong reason.
    expect(document.body.querySelector('[data-testid="account-sign-out"]')).not.toBeNull();
  });

  test("the Settings row exists and fires", () => {
    // Load-bearing: settings has been unreachable on a phone before
    // (this file's own opening paragraph), and this is what stops the menu
    // becoming a second way for that to happen — a row that opens but whose
    // press goes nowhere is exactly as unreachable as no row at all.
    let opened = 0;
    let signedOut = 0;
    const host = mount({
      ...BASE,
      compact: true,
      onSignOut: () => {
        signedOut += 1;
      },
      onOpenSettings: () => {
        opened += 1;
      },
    });

    act(() => {
      (host.querySelector('[data-testid="account-menu"]') as HTMLElement).click();
    });
    const settingsRow = document.body.querySelector('[data-testid="account-settings"]');
    expect(settingsRow).not.toBeNull();

    act(() => {
      (settingsRow as HTMLElement).click();
    });

    expect(opened).toBe(1);
    expect(signedOut).toBe(0);
    // The menu closes behind a real choice, same as any other row.
    expect(document.body.querySelector('[data-testid="menu-sheet"]')).toBeNull();
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
