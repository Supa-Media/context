/**
 * @jest-environment jsdom
 */

/**
 * A DISABLED ROW DRAWS NO FOCUS RING.
 *
 * The note's `‹` is disabled at the start of history, and it becomes disabled
 * while it holds focus: the press that took you back is the press that left
 * nothing behind. A control disabled while focused never fires blur, so a
 * ring drawn from `onFocus`/`onBlur` alone stayed around a dead button
 * (owner, 2026-09-28).
 */

import { afterEach, expect, test } from "@jest/globals";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Text } from "react-native";
import { PressRow } from "../features/design/components/Button";

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

/** The ring is the only absolutely positioned aria-hidden child. */
function ringDrawn(container: HTMLElement): boolean {
  return [...container.querySelectorAll('[aria-hidden="true"]')].some(
    (node) => (node as HTMLElement).style.position === "absolute" || getComputedStyle(node).position === "absolute",
  );
}

test("a row disabled while it holds focus stops drawing the ring", () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const render = (disabled: boolean) =>
    act(() => {
      root!.render(
        createElement(PressRow, {
          accessibilityLabel: "Go back",
          onPress: () => {},
          disabled,
          testID: "row",
          children: createElement(Text, null, "‹"),
        }),
      );
    });

  render(false);
  const row = container.querySelector('[data-testid="row"]') as HTMLElement;
  act(() => row.focus());
  expect(ringDrawn(container)).toBe(true);

  render(true);
  expect(ringDrawn(container)).toBe(false);
});
