/**
 * @jest-environment jsdom
 */

/**
 * The sheet grid, actually rendered. The pure model and the text edits are
 * covered in `sheetModel.test.ts`; this file proves the grid turns a press or
 * a key into the right change to the file, and that the file is the only truth.
 *
 * A harness holds the text the way the console does: every `onChangeText`
 * sets it, so each assertion is about a real round trip (parse, edit,
 * serialize, render again) and not about a stub.
 *
 * SABOTAGE: making `editCell` ignore its row index, or dropping the `+ New row`
 * guard under `readOnly`, fails the cases below.
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SheetView } from "../features/console/files/sheet/SheetView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SHEET = ["name,renews:date,amount:usd,paid:checkbox", "Netflix,2026-12-01,$15,true", "Gym,2026-12-09,40,false", ""].join("\n");

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
  document.body.innerHTML = "";
});

function mount(options: { text?: string; readOnly?: boolean } = {}): { changes: string[] } {
  const changes: string[] = [];
  const initial = options.text ?? SHEET;
  const readOnly = options.readOnly ?? false;
  function Harness() {
    const [text, setText] = useState(initial);
    return createElement(SheetView, {
      path: "subs.csv",
      text,
      readOnly,
      people: ["Seyi", "Ada"],
      onChangeText: (next: string) => {
        changes.push(next);
        setText(next);
      },
    });
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(createElement(Harness)));
  unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
  return { changes };
}

const $ = (selector: string) => document.querySelector<HTMLElement>(selector);
const $$ = (selector: string) => Array.from(document.querySelectorAll<HTMLElement>(selector));
const cell = (row: number, col: number): HTMLElement => $$('[data-testid="sheet-row"]')[row].querySelectorAll<HTMLElement>('[data-testid="sheet-cell"]')[col];
/** A button whose words end in `text`: a column row reads its type glyph before its name. */
const buttonWithText = (root: ParentNode, text: string): HTMLElement | undefined =>
  Array.from(root.querySelectorAll<HTMLElement>('[role="button"]')).find((el) => (el.textContent ?? "").endsWith(text));
/** The input a TextInput renders (its testID sits on the wrapper). */
const fieldIn = (el: HTMLElement): HTMLInputElement => (el.matches("input") ? (el as HTMLInputElement) : (el.querySelector("input") as HTMLInputElement));

function press(el: HTMLElement): void {
  act(() => {
    el.click();
  });
}

/** Menus measure their anchor after a tick, as they do in a browser. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

function typeInto(el: HTMLElement, value: string): void {
  const input = fieldIn(el);
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setValue?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function key(el: HTMLElement, name: string, init: KeyboardEventInit = {}): void {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }));
  });
}

describe("the sheet grid", () => {
  test("renders the rows and a typed header for each column", () => {
    mount();
    const headers = $$('[data-testid="sheet-header"]').map((h) => h.textContent);
    expect(headers).toEqual(["Aaname", "▦renews", "$amount", "☑paid"]);
    expect($$('[data-testid="sheet-row"]')).toHaveLength(2);
    expect(cell(0, 0).textContent).toBe("Netflix");
    expect(cell(1, 2).textContent).toBe("$40");
  });

  test("editing a cell writes the whole new file through onChangeText", () => {
    const { changes } = mount();
    press(cell(0, 0));
    key(cell(0, 0), "Enter");
    const field = $('[data-testid="sheet-cell-editor"]') as HTMLElement;
    typeInto(field, "Hulu");
    key(fieldIn(field), "Enter");
    expect(changes).toEqual(["name,renews:date,amount:usd,paid:checkbox\nHulu,2026-12-01,$15,true\nGym,2026-12-09,40,false\n"]);
    expect(cell(0, 0).textContent).toBe("Hulu");
  });

  test("New row opens its first cell for typing, so the keys land in the sheet", () => {
    const { changes } = mount();
    press($('[data-testid="sheet-new-row"]') as HTMLElement);
    const field = $('[data-testid="sheet-cell-editor"]') as HTMLElement;
    expect(field).not.toBeNull();
    typeInto(field, "Phone");
    key(fieldIn(field), "Enter");
    expect(changes.at(-1)).toBe("name,renews:date,amount:usd,paid:checkbox\nNetflix,2026-12-01,$15,true\nGym,2026-12-09,40,false\nPhone,,,\n");
  });

  test("arrows move the selection, and a typed character starts an edit with that character", () => {
    const { changes } = mount();
    press(cell(0, 0));
    key(cell(0, 0), "ArrowDown");
    key(cell(1, 0), "Z");
    const field = $('[data-testid="sheet-cell-editor"]') as HTMLElement;
    expect(fieldIn(field).value).toBe("Z");
    key(fieldIn(field), "Enter");
    expect(changes[0]).toContain("\nZ,2026-12-09,40,false\n");
  });

  test("the + header adds a column, and the header row shows it", () => {
    const { changes } = mount();
    press($('[data-testid="sheet-add-column"]') as HTMLElement);
    expect(changes[0].split("\n")[0]).toBe("name,renews:date,amount:usd,paid:checkbox,new column");
    expect($$('[data-testid="sheet-header"]').map((h) => h.textContent)).toContain("Aanew column");
  });

  test("changing a type keeps every value and marks the ones that no longer fit", async () => {
    const { changes } = mount();
    press($$('[data-testid="sheet-header"]')[2]);
    await settle();
    press($('[data-testid="sheet-type-date"]') as HTMLElement);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toBe("name,renews:date,amount:date,paid:checkbox\nNetflix,2026-12-01,$15,true\nGym,2026-12-09,40,false\n");
    expect($('[data-testid="sheet-notice"]')?.textContent).toContain("2 values in amount don't fit Date");
    expect($$('[data-testid="sheet-misfit"]')).toHaveLength(2);
  });

  test("a filter narrows the rows and the footer says how many of how many", async () => {
    mount();
    expect($('[data-testid="sheet-row-count"]')?.textContent).toBe("2 rows");
    press($('[data-testid="sheet-add-filter"]') as HTMLElement);
    await settle();
    const menu = $('[data-testid="sheet-filter-menu"]') as HTMLElement;
    press(buttonWithText(menu, "name") as HTMLElement);
    typeInto(menu.querySelector('[data-testid="sheet-filter-value"]') as HTMLElement, "Gy");
    press(buttonWithText(document.body, "Add filter") as HTMLElement);
    expect($$('[data-testid="sheet-row"]')).toHaveLength(1);
    expect($('[data-testid="sheet-row-count"]')?.textContent).toBe("1 of 2 rows");
    expect(cell(0, 0).textContent).toBe("Gym");
  });

  test("a checkbox toggles on one press and writes at once", () => {
    const { changes } = mount();
    press(cell(1, 3));
    expect(changes).toEqual(["name,renews:date,amount:usd,paid:checkbox\nNetflix,2026-12-01,$15,true\nGym,2026-12-09,40,true\n"]);
  });

  test("a read-only sheet offers no New row and no + column", () => {
    mount({ readOnly: true });
    expect($('[data-testid="sheet-new-row"]')).toBeNull();
    expect($('[data-testid="sheet-add-column"]')).toBeNull();
    expect($$('[data-testid="sheet-row"]')).toHaveLength(2);
  });

  test("a file with problems lists the first three with their line numbers and still shows its rows", () => {
    mount({ text: "a,b\n1\n2,3,4\n5,6\n7,8,9,10\n11\n" });
    const problems = $('[data-testid="sheet-problems"]')?.textContent ?? "";
    expect(problems).toContain("4 problems in this file");
    expect(problems).toContain("Line 2: has 1 cells, the header has 2");
    expect(problems).toContain("Line 3: has 3 cells, the header has 2");
    expect(problems).toContain("Line 5: has 4 cells, the header has 2");
    expect(problems).not.toContain("Line 6");
    expect($$('[data-testid="sheet-row"]')).toHaveLength(5);
  });

  test("a sheet past the limit shows only a notice naming it", () => {
    const text = `a\n${"x\n".repeat(50_001)}`;
    mount({ text });
    expect($('[data-testid="sheet-too-large"]')?.textContent).toContain("50000 rows");
    expect($('[data-testid="sheet-grid"]')).toBeNull();
  });
});
