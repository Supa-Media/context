/** @jest-environment jsdom */
import { expect, jest, test } from "@jest/globals";

// iOS treats a Pressable as one accessibility element unless explicitly
// disabled. RNW does not model that pruning, so expose grouping in this harness.
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

import { mountSheet, sheetItems } from "./fixtures";

test("native sheet actions remain separate accessibility targets and still dispatch", () => {
  const items = sheetItems();
  const sheet = mountSheet(items);
  for (const item of items) {
    const row = sheet.find(item.testID ?? `menu-item-${item.id}`);
    expect(row).not.toBeNull();
    // A grouped ancestor hides every descendant action from VoiceOver.
    expect(row!.parentElement?.closest('[data-native-accessibility-group="true"]')).toBeNull();
  }
  const action = items.find((item) => !item.items && !item.disabled)!;
  sheet.press(action.testID ?? `menu-item-${action.id}`);
  expect(sheet.selected).toEqual([action.id]);
  expect(sheet.dismissals).toBe(1);
});
