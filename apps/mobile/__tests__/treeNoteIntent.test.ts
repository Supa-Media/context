/**
 * @jest-environment jsdom
 */

/**
 * The file tree says which note is about to be opened.
 *
 * The other half of `notePrefetch.test.ts`: the read can only start early if
 * the row tells somebody the pointer arrived. A note row does, on hover and on
 * press-in; a folder row never does, because a folder has no body to read.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { FileTree } from "../features/console/files/FileTree";
import type { TreeRow } from "../features/console/files/tree";
import { HOVER_INTENT_MS, useHoverIntent } from "../features/design/useHoverIntent";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  useSafeAreaFrame: () => ({ x: 0, y: 0, width: 1024, height: 768 }),
}));

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
});

function row(path: string, kind: "file" | "folder"): TreeRow {
  return {
    kind,
    key: path,
    path,
    name: path,
    label: path,
    depth: 0,
    expanded: false,
    selected: false,
    markerIsDefault: false,
    readOnly: false,
  };
}

function press(element: Element) {
  act(() => {
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
  });
}

function setup() {
  const intents: string[] = [];
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
        rows: [row("2-areas", "folder"), row("plan.md", "file")],
        onSelect: () => {},
        onToggle: () => {},
        onIntent: (path: string) => intents.push(path),
      }),
    ),
  );
  return { container, intents };
}

const noteRow = (container: HTMLElement) => container.querySelector("[aria-label^='plan.md']");
const folderRow = (container: HTMLElement) => container.querySelector("[aria-label^='2-areas, folder']");

describe("a note row", () => {
  test("says so when a finger or button goes down on it", () => {
    const { container, intents } = setup();
    press(noteRow(container)!);
    expect(intents).toContain("plan.md");
  });
});

describe("a folder row", () => {
  test("never does: there is nothing to read", () => {
    const { container, intents } = setup();
    press(folderRow(container)!);
    expect(intents).toEqual([]);
  });
});

describe("useHoverIntent", () => {
  function probe(onIntent: (() => void) | undefined) {
    let handlers: ReturnType<typeof useHoverIntent> | null = null;
    const container = document.createElement("div");
    const root = createRoot(container);
    roots.push(() => act(() => root.unmount()));
    function Probe() {
      handlers = useHoverIntent(onIntent);
      return null;
    }
    act(() => root.render(createElement(Probe)));
    return () => handlers!;
  }

  test("a pointer that rests counts; one passing over on its way does not", () => {
    jest.useFakeTimers();
    try {
      let fired = 0;
      const handlers = probe(() => (fired += 1));
      handlers().hoverIn();
      jest.advanceTimersByTime(HOVER_INTENT_MS / 2);
      handlers().hoverOut();
      jest.advanceTimersByTime(HOVER_INTENT_MS * 2);
      expect(fired).toBe(0);
      handlers().hoverIn();
      jest.advanceTimersByTime(HOVER_INTENT_MS + 1);
      expect(fired).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a press counts at once", () => {
    let fired = 0;
    const handlers = probe(() => (fired += 1));
    handlers().pressIn();
    expect(fired).toBe(1);
  });
});
