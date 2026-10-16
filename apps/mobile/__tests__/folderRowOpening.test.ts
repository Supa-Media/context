/**
 * @jest-environment jsdom
 */

/**
 * The tapped row while its note loads (board A of "Opening a note on the
 * phone", picked by Dev2 on 2026-10-16): the folder stays, the row says it is
 * opening with a line along its foot, and after `STILL_OPENING_MS` its date
 * reads "Still opening…". Only the row being opened shows any of it.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { FolderRow } from "../features/console/files/FolderRow";
import { STILL_OPENING_MS } from "../features/console/files/RowOpening";
import type { FileEntry } from "../features/console/files/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  useSafeAreaFrame: () => ({ x: 0, y: 0, width: 390, height: 844 }),
}));

const roots: (() => void)[] = [];

function mount(element: ReactElement): { container: HTMLElement; render: (next: ReactElement) => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => root.render(element));
  return { container, render: (next) => act(() => root.render(next)) };
}

afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  jest.useRealTimers();
});

const note: FileEntry = {
  kind: "file",
  path: "2-areas/kings/kings-18.md",
  name: "kings-18.md",
  visibility: "private",
  inherited: "private",
  exception: false,
  readOnly: false,
};
const phone = { meta: "Oct 14", sub: "Sennacherib comes against Jerusalem", pinned: false } as never;

const row = (opening: boolean) => createElement(FolderRow, { row: note, onSelect: () => {}, card: true, phone, opening });

describe("a folder row whose note is opening", () => {
  test("a row not being opened draws no line and keeps its date", () => {
    const { container } = mount(row(false));
    expect(container.querySelector("[data-testid='folder-row-opening']")).toBeNull();
    expect(container.querySelector("[data-testid='folder-row-meta']")?.textContent).toBe("Oct 14");
    expect(container.querySelector("[aria-label$=', opening']")).toBeNull();
  });

  test("the row being opened draws the line and says so to a screen reader", () => {
    const { container } = mount(row(true));
    expect(container.querySelector("[data-testid='folder-row-opening']")).not.toBeNull();
    expect(container.querySelector("[aria-label$=', opening']")).not.toBeNull();
  });

  test("after a couple of seconds the date reads Still opening…, and goes back when it opens", () => {
    jest.useFakeTimers();
    const { container, render } = mount(row(true));
    expect(container.querySelector("[data-testid='folder-row-still-opening']")).toBeNull();
    act(() => jest.advanceTimersByTime(STILL_OPENING_MS - 1));
    expect(container.querySelector("[data-testid='folder-row-still-opening']")).toBeNull();
    act(() => jest.advanceTimersByTime(1));
    expect(container.querySelector("[data-testid='folder-row-still-opening']")?.textContent).toBe("Still opening…");

    render(row(false));
    expect(container.querySelector("[data-testid='folder-row-still-opening']")).toBeNull();
    expect(container.querySelector("[data-testid='folder-row-opening']")).toBeNull();
    expect(container.querySelector("[data-testid='folder-row-meta']")?.textContent).toBe("Oct 14");
  });
});
