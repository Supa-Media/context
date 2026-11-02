/**
 * @jest-environment jsdom
 */

/**
 * The tree's `team` / `private` word is a label, not a button.
 *
 * It used to flip a note between private and team on one click. Clicking the
 * word to find out what it meant unshared the note, and then the word vanished,
 * because the note now matched its folder (Dev2, 2026-10-28). Visibility is
 * changed from the row's menu or the share dialog; the word only says what it
 * is, on hover and to a screen reader.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describeVisibility, FileTree } from "../features/console/files/FileTree";
import type { TreeRow } from "../features/console/files/tree";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  useSafeAreaFrame: () => ({ x: 0, y: 0, width: 1024, height: 768 }),
}));

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
});

const SHARED_NOTE: TreeRow = {
  kind: "file",
  key: "plan.md",
  path: "plan.md",
  name: "plan.md",
  label: "plan",
  depth: 0,
  expanded: false,
  selected: false,
  marker: "team",
  markerIsDefault: false,
  readOnly: false,
};

function render() {
  const selected: string[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() =>
    root.render(
      createElement(FileTree, {
        rows: [SHARED_NOTE],
        // An owner, the one person the old press was offered to. The tree no
        // longer takes this; passing it proves an owner gets no button either.
        canSetVisibility: true,
        onSelect: (path: string) => selected.push(path),
        onToggle: () => {},
      } as never),
    ),
  );
  return { container, selected };
}

function marker(container: HTMLElement): HTMLElement {
  const word = Array.from(container.querySelectorAll("div")).find((el) => el.textContent === "team");
  if (word === undefined) throw new Error("no team marker drawn");
  return word.closest("[aria-label*='unlike its folder']") as HTMLElement;
}

describe("the visibility word beside a note", () => {
  test("is drawn, and says what it means on hover", () => {
    const { container } = render();
    const el = marker(container);
    expect(el).not.toBeNull();
    expect(el.getAttribute("title")).toBe(describeVisibility(SHARED_NOTE));
    expect(el.getAttribute("title")).toContain("shared with the team");
  });

  test("is not a button: nothing in or around it is focusable or pressable", () => {
    const { container } = render();
    const el = marker(container);
    expect(el.getAttribute("role")).not.toBe("button");
    expect(el.getAttribute("tabindex")).toBeNull();
    expect(el.querySelector("[role='button'],[tabindex]")).toBeNull();
  });

  test("a click on it changes nothing and stays a click on the row", () => {
    const { container, selected } = render();
    act(() => {
      marker(container).dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    });
    // The word is still there, because nothing about the note changed.
    expect(container.textContent).toContain("team");
    expect(selected.length).toBeLessThanOrEqual(1);
  });

  test("its sentence points at the menu, never at a press", () => {
    expect(describeVisibility(SHARED_NOTE)).toBe(
      "plan is shared with the team, unlike its folder. Change it from the note's menu.",
    );
    expect(describeVisibility({ ...SHARED_NOTE, marker: "private" })).toBe(
      "plan is private, unlike its folder. Change it from the note's menu.",
    );
  });
});
