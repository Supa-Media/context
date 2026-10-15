/**
 * @jest-environment jsdom
 *
 * Settings on a phone opens on its list (Dev2, 2026-10-15: "why does it open
 * up in the general page first"). jsdom's viewport is 0 wide, so every mount
 * here is the phone branch of `SettingsOverlay`.
 *
 * Proved red: with `useState(false)` back in place of `startOnList`, the first
 * test fails on the missing list; with `selected={entry.key === active}` back,
 * it fails on the lit row.
 */
import { afterEach, describe, expect, jest, test } from "@jest/globals";

/*
  The whole of `convex/react` that any settings panel reaches for, not just
  `useAction`.

  Two screens could not be mounted at all until this grew: the machines card
  at the foot of Profile calls `useConvexAuth` and `PremiumPanel` calls
  `useConvex`, and a narrower mock meant the sweep below could not even
  *render* the two screens whose headings it was written to check. Each stub answers the way an unauthorised,
  clientless console does, which is the state these panels already handle.
*/
jest.mock("convex/react", () => ({
  useAction: () => async () => {
    throw new Error("not used in this test");
  },
  useMutation: () => async () => {
    throw new Error("not used in this test");
  },
  useConvexAuth: () => ({ isAuthenticated: false, isLoading: false }),
  useConvex: () => undefined,
  useQuery: () => undefined,
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useDemoConsoleData } from "../features/console/useDemoConsoleData";
import { SettingsOverlay } from "../features/console/settings/SettingsOverlay";
import type { ConsoleData } from "../features/console/types";
import {
  DEFAULT_ACCOUNT_SETTINGS_SECTION,
  DEFAULT_SETTINGS_SECTION,
  opensOnSettingsList,
  type SettingsSectionKey,
} from "../features/console/settings/sections";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

function mount(render: () => ReturnType<typeof createElement>): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(render());
  });
  return container;
}

/** The demo console, resolved before mounting — an `act` inside an `act` never flushes. */
function demoData(): ConsoleData {
  let data: ConsoleData | null = null;
  function Probe() {
    data = useDemoConsoleData();
    return null;
  }
  mount(() => createElement(Probe));
  if (data === null) throw new Error("the demo console did not resolve");
  return data;
}

function overlay(
  section: SettingsSectionKey,
  extra: Partial<Parameters<typeof SettingsOverlay>[0]> = {},
): HTMLElement {
  const data = demoData();
  mount(() =>
    createElement(SettingsOverlay, {
      data,
      section,
      onSelect: () => {},
      onDismiss: () => {},
      ...extra,
    }),
  );
  // `Modal` portals to the body, so the mount container itself stays empty.
  return document.body;
}

describe("a phone opens Settings on its list", () => {
  test("opened plainly, it is the list, with nothing lit", () => {
    const host = overlay("workspace", { startOnList: true });
    expect(host.querySelector('[data-testid="settings-sections"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="overview-identity"]')).toBeNull();
    expect(host.querySelectorAll('[aria-current="true"]')).toHaveLength(0);
  });

  test("sent to one page, it is that page, with the list one press back", () => {
    const host = overlay("storage");
    expect(host.textContent ?? "").toContain("Plain files in storage you own");
    expect(host.querySelector('[data-testid="settings-sections"]')).toBeNull();
    act(() => {
      (host.querySelector('[data-testid="settings-overlay-back"]') as HTMLElement).click();
    });
    expect(host.querySelector('[data-testid="settings-sections"]')).not.toBeNull();
  });

  test("the gear and the account menu are the plain way in; a named page is not", () => {
    expect(opensOnSettingsList(DEFAULT_SETTINGS_SECTION)).toBe(true);
    expect(opensOnSettingsList(DEFAULT_ACCOUNT_SETTINGS_SECTION)).toBe(true);
    expect(opensOnSettingsList("storage")).toBe(false);
    expect(opensOnSettingsList("premium")).toBe(false);
    expect(opensOnSettingsList("feedback")).toBe(false);
  });
});

