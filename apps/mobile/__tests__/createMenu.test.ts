/**
 * @jest-environment jsdom
 */

/**
 * THE CORNER `+`'S MENU, AS TRIMMED ON 2026-11-24.
 *
 * Dev asked for tables on it and for it to be less wordy. It stays the app's
 * own menu, one short row each with the tree's mark for it, and no sentence
 * under any row.
 *
 * SABOTAGE: wiring New table to `onNewNote`, or putting a detail back under
 * New note, each fails a case below.
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { CreateButton } from "../features/console/CreateButton";

const METRICS = { frame: { x: 0, y: 0, width: 1280, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
  document.body.innerHTML = "";
});

function mount(): string[] {
  const made: string[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() =>
    root.render(
      createElement(SafeAreaProvider, { initialMetrics: METRICS }, createElement(CreateButton, {
        compact: false,
        onNewMeeting: () => made.push("meeting"),
        onNewNote: () => made.push("note"),
        onNewDrawing: () => made.push("drawing"),
        onNewSheet: () => made.push("sheet"),
        onNewFolder: () => made.push("folder"),
      })),
    ),
  );
  unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
  return made;
}

function open(): void {
  act(() => {
    document.querySelector<HTMLElement>('[data-testid="console-create"]')!.click();
  });
}

const row = (label: string): HTMLElement | undefined =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((el) => (el.textContent ?? "") === label);

describe("the + menu", () => {
  test("offers a meeting and the four files, one short row each", () => {
    mount();
    open();
    const labels = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).map((el) => el.textContent)
      // jsdom has no hover, so `Menu` draws its touch sheet, whose last row is Cancel.
      .filter((label) => label !== "Cancel");
    expect(labels).toEqual(["New meeting", "New note", "New table", "New drawing", "New folder"]);
  });

  test.each([
    ["New meeting", "meeting"],
    ["New note", "note"],
    ["New table", "sheet"],
    ["New drawing", "drawing"],
    ["New folder", "folder"],
  ])("%s reaches its own handler", (label, made) => {
    const calls = mount();
    open();
    act(() => {
      row(label)!.click();
    });
    expect(calls).toEqual([made]);
  });
});
