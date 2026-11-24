/**
 * @jest-environment jsdom
 */

/**
 * THE CORNER `+`'S CARD, AS REDRAWN ON 2026-11-24.
 *
 * Dev asked for the menu to be "cleaner and intuitive and maybe more fun", and
 * for CSVs to be on it. So the card is one wide Record a meeting button and
 * four tiles of one word each, with where the files go said once underneath.
 *
 * What is worth a test: each tile reaches the handler it names (a Table tile
 * wired to `onNewNote` would look right on screen), the words stay short, the
 * card says where things land, and it closes on Escape and on a press outside.
 *
 * SABOTAGE: wiring the Table tile to `onNewNote`, dropping the Escape listener,
 * or putting a sentence back under a tile each fails a case below.
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CreateButton } from "../features/console/CreateButton";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
  document.body.innerHTML = "";
});

function mount(folder = "1-projects"): string[] {
  const made: string[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() =>
    root.render(
      createElement(CreateButton, {
        compact: false,
        folder,
        onNewMeeting: () => made.push("meeting"),
        onNewNote: () => made.push("note"),
        onNewDrawing: () => made.push("drawing"),
        onNewSheet: () => made.push("sheet"),
        onNewFolder: () => made.push("folder"),
      }),
    ),
  );
  unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
  return made;
}

const $ = (selector: string) => document.querySelector<HTMLElement>(selector);

function click(el: HTMLElement): void {
  act(() => {
    el.click();
  });
}

function open(): HTMLElement {
  click($('[data-testid="console-create"]')!);
  return $('[data-testid="console-create-menu"]')!;
}

describe("the + card", () => {
  test("a recording button and four one-word tiles", () => {
    mount();
    const card = open();
    expect(card).not.toBeNull();
    expect($('[data-testid="create-row-new-meeting"]')?.textContent).toBe("Record a meetingLands in your inbox");
    const tiles = ["new-note", "new-sheet", "new-drawing", "new-folder"].map((row) => $(`[data-testid="create-row-${row}"]`)?.textContent);
    expect(tiles).toEqual(["Note", "Table", "Drawing", "Folder"]);
  });

  test("it says once where the files go, by the folder's shown name", () => {
    mount("1-projects");
    open();
    expect($('[data-testid="create-lands-in"]')?.textContent).toBe("Goes in projects");
  });

  test("and names the top when that is where they go", () => {
    mount("");
    open();
    expect($('[data-testid="create-lands-in"]')?.textContent).toBe("Goes at the top of your workspace");
  });

  test.each([
    ["new-meeting", "meeting"],
    ["new-note", "note"],
    ["new-sheet", "sheet"],
    ["new-drawing", "drawing"],
    ["new-folder", "folder"],
  ])("%s reaches its own handler and closes the card", (row, made) => {
    const calls = mount();
    open();
    click($(`[data-testid="create-row-${row}"]`)!);
    expect(calls).toEqual([made]);
    expect($('[data-testid="console-create-menu"]')).toBeNull();
  });

  test("Escape closes it", () => {
    mount();
    open();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect($('[data-testid="console-create-menu"]')).toBeNull();
  });

  test("a press outside closes it, and a press inside does not", () => {
    mount();
    const card = open();
    act(() => {
      card.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect($('[data-testid="console-create-menu"]')).not.toBeNull();
    act(() => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect($('[data-testid="console-create-menu"]')).toBeNull();
  });

  test("the + toggles it shut", () => {
    mount();
    open();
    click($('[data-testid="console-create"]')!);
    expect($('[data-testid="console-create-menu"]')).toBeNull();
  });
});
