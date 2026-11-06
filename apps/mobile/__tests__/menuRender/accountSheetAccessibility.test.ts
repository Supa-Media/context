/** @jest-environment jsdom */
import { afterEach, expect, jest, test } from "@jest/globals";

/*
  The phone's account sheet is its own sheet since 2026-11-06 (`AccountSheet`),
  so the iOS grouping fix of 2026-10-28 (`native-app-shell.md`) has to hold for
  it too: that defect was reported on exactly this menu, where VoiceOver saw
  only "Close menu". Same harness as `nativeAccessibility.test.ts`: iOS treats
  a Pressable as one element unless `accessible={false}`, which RNW does not
  model, so the harness marks it.

  SABOTAGE: drop `accessible={false}` from either of `AccountSheet`'s two
  Pressables and every row below fails.
*/
jest.mock("react-native", () => {
  const actual = jest.requireActual("react-native-web") as typeof import("react-native");
  const React = require("react") as typeof import("react");
  return {
    ...actual,
    Pressable: React.forwardRef((props: Record<string, unknown>, ref: unknown) =>
      React.createElement(actual.Pressable, {
        ...props,
        ref,
        dataSet: {
          ...(props.dataSet as Record<string, string> | undefined),
          nativeAccessibilityGroup: String(props.accessible !== false),
        },
      } as never),
    ),
  };
});

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 34, left: 0, right: 0 }),
}));

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "../../features/design/theme";
import { AccountSheet } from "../../features/console/AccountSheet";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const live: (() => void)[] = [];
afterEach(() => {
  while (live.length > 0) live.pop()!();
});

test("every row, button and the sun stay separate accessibility targets, and dispatch", () => {
  const selected: string[] = [];
  let dismissals = 0;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  live.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  const row = (id: string, label: string) => ({ id, label, testID: `switcher-${id}` });
  act(() => {
    root.render(
      createElement(ThemeProvider, {
        scheme: "dark",
        children: createElement(AccountSheet, {
          title: "@seyi",
          detail: "seyi@context.lc",
          appearance: { id: "appearance", label: "Light mode", testID: "switcher-appearance" },
          places: [row("settings", "Settings"), row("meetings", "Meetings")],
          workspaces: [{ ...row("context-seyi", "@seyi"), checked: true, detail: "yours" }],
          rest: [row("signout", "Sign out")],
          onSelect: (id: string) => selected.push(id),
          onDismiss: () => {
            dismissals += 1;
          },
        }),
      }),
    );
  });
  const ids = ["switcher-appearance", "switcher-settings", "switcher-meetings", "switcher-context-seyi", "switcher-signout"];
  for (const id of ids) {
    const node = document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    expect(node).not.toBeNull();
    expect(node!.parentElement?.closest('[data-native-accessibility-group="true"]')).toBeNull();
  }
  act(() => {
    document.body
      .querySelector<HTMLElement>('[data-testid="switcher-settings"]')!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(selected).toEqual(["settings"]);
  expect(dismissals).toBe(1);
});
