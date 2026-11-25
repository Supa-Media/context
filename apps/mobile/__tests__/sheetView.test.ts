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

function mount(options: { text?: string; readOnly?: boolean; say?: (m: string) => void } = {}): { changes: string[] } {
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
      ...(options.say ? { say: options.say } : {}),
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

  test("the heading names the file and says it is a sheet, and the row gutter is headed #", () => {
    mount();
    expect($('[data-testid="sheet-title"]')?.textContent).toBe("subs.csv");
    expect($('[data-testid="sheet-subtitle"]')?.textContent).toBe("Sheet");
    expect($('[data-testid="sheet-grid"]')?.textContent?.startsWith("#")).toBe(true);
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

  test("deleting a column takes a second press, and only then drops its values", async () => {
    const { changes } = mount();
    press($$('[data-testid="sheet-header"]')[1]);
    await settle();
    const menu = $('[data-testid="sheet-column-menu"]') as HTMLElement;
    press(buttonWithText(menu, "Delete column") as HTMLElement);
    expect(changes).toHaveLength(0);
    press(buttonWithText(menu, "and its values") as HTMLElement);
    expect(changes).toEqual(["name,amount:usd,paid:checkbox\nNetflix,$15,true\nGym,40,false\n"]);
  });

  test("a filter narrows the rows and the footer says how many of how many", async () => {
    mount();
    expect($('[data-testid="sheet-row-count"]')?.textContent).toBe("2");
    expect($('[data-testid="sheet-shown-count"]')).toBeNull();
    press($('[data-testid="sheet-add-filter"]') as HTMLElement);
    await settle();
    const menu = $('[data-testid="sheet-filter-menu"]') as HTMLElement;
    press(buttonWithText(menu, "name") as HTMLElement);
    typeInto(menu.querySelector('[data-testid="sheet-filter-value"]') as HTMLElement, "Gy");
    press(buttonWithText(document.body, "Add filter") as HTMLElement);
    expect($$('[data-testid="sheet-row"]')).toHaveLength(1);
    expect($('[data-testid="sheet-row-count"]')?.textContent).toBe("1");
    expect($('[data-testid="sheet-shown-count"]')?.textContent).toBe("1 of 2 rows");
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

describe("the gaps found on 2026-11-24", () => {
  const PEOPLE = "name,owner:person,stage:select\nA,,lead\nB,,won\n";

  test("a person cell offers the workspace's people, outside the grid so no row covers them, and arrows pick one", () => {
    const { changes } = mount({ text: PEOPLE });
    press(cell(0, 1));
    key(cell(0, 1), "Enter");
    const menu = $('[data-testid="sheet-cell-suggestions"]') as HTMLElement;
    expect(menu).not.toBeNull();
    // Drawn into the body, not inside the grid's rows, which clip and cover it.
    expect($('[data-testid="sheet-grid"]')?.contains(menu)).toBe(false);
    expect(menu.textContent).toBe("SeyiAda");
    const field = fieldIn($('[data-testid="sheet-cell-editor"]') as HTMLElement);
    key(field, "ArrowDown");
    key(field, "ArrowDown");
    key(field, "Enter");
    expect(changes).toEqual(["name,owner:person,stage:select\nA,Ada,lead\nB,,won\n"]);
  });

  test("Enter with nothing highlighted keeps what is typed: a new option", () => {
    const { changes } = mount({ text: PEOPLE });
    press(cell(0, 2));
    key(cell(0, 2), "Enter");
    const field = $('[data-testid="sheet-cell-editor"]') as HTMLElement;
    typeInto(field, "w");
    key(fieldIn(field), "Enter");
    expect(changes).toEqual(["name,owner:person,stage:select\nA,,w\nB,,won\n"]);
  });

  test("after Enter the keyboard is back on the grid, so arrows keep moving", () => {
    mount();
    press(cell(0, 0));
    key(cell(0, 0), "Enter");
    key(fieldIn($('[data-testid="sheet-cell-editor"]') as HTMLElement), "Enter");
    expect(document.activeElement).toBe($('[data-testid="sheet-grid-box"]'));
  });

  test("Delete clears the selected cell, Cmd+Z puts it back, and Shift+Cmd+Z clears it again", () => {
    const { changes } = mount();
    press(cell(0, 0));
    key(cell(0, 0), "Delete");
    expect(changes.at(-1)).toContain("\n,2026-12-01,$15,true\n");
    key(cell(0, 0), "z", { metaKey: true });
    expect(changes.at(-1)).toBe(SHEET);
    key(cell(0, 0), "z", { metaKey: true, shiftKey: true });
    expect(changes.at(-1)).toContain("\n,2026-12-01,$15,true\n");
  });

  test("a pasted block fills cells right and down from the selection", () => {
    const { changes } = mount();
    press(cell(0, 0));
    act(() => {
      const event = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
      event.clipboardData = { getData: () => "Hulu\t2027-01-01\nPool\t2027-02-02\n" };
      cell(0, 0).dispatchEvent(event);
    });
    expect(changes).toEqual(["name,renews:date,amount:usd,paid:checkbox\nHulu,2027-01-01,$15,true\nPool,2027-02-02,40,false\n"]);
  });

  test("Tab on the last column leaves the grid rather than being swallowed", () => {
    mount();
    press(cell(0, 3));
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    act(() => {
      cell(0, 3).dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
  });

  test("a typed character on a date cell opens its picker on the date that is there", () => {
    mount();
    press(cell(0, 1));
    key(cell(0, 1), "2");
    expect(fieldIn($('[data-testid="sheet-cell-editor"]') as HTMLElement).value).toBe("2026-12-01");
  });

  test("a row longer than the header opens read-only, since saving would drop its extra cell", () => {
    const { changes } = mount({ text: "a,b\n1,2,3\n" });
    expect($('[data-testid="sheet-new-row"]')).toBeNull();
    expect($('[data-testid="sheet-problems"]')?.textContent).toContain("read-only");
    press(cell(0, 0));
    key(cell(0, 0), "Delete");
    expect(changes).toEqual([]);
  });

  test("two columns of one name open read-only too", () => {
    mount({ text: "a,A\n1,2\n" });
    expect($('[data-testid="sheet-new-row"]')).toBeNull();
  });

  test("renaming onto a name that is taken changes nothing and says so", async () => {
    const said: string[] = [];
    const { changes } = mount({ say: (m) => said.push(m) });
    press($$('[data-testid="sheet-header"]')[0]);
    await settle();
    const menu = $('[data-testid="sheet-column-menu"]') as HTMLElement;
    const name = menu.querySelector("input") as HTMLInputElement;
    typeInto(name, "paid");
    key(name, "Enter");
    expect(changes).toEqual([]);
    expect(said).toEqual(["There is already a column called paid."]);
  });
});

describe("the new sheet UI of 2026-11-24", () => {
  const handle = (row: number): HTMLElement => $$('[data-testid="sheet-row-handle"]')[row];

  test("a row's menu inserts above, and deleting takes a second press", async () => {
    const { changes } = mount();
    press(handle(1));
    await settle();
    const menu = $('[data-testid="sheet-row-menu"]') as HTMLElement;
    expect(menu.textContent).toContain("Row 2");
    press(buttonWithText(menu, "Insert row above") as HTMLElement);
    expect(changes).toEqual(["name,renews:date,amount:usd,paid:checkbox\nNetflix,2026-12-01,$15,true\n,,,\nGym,2026-12-09,40,false\n"]);
    press(handle(2));
    await settle();
    const del = $('[data-testid="sheet-row-delete"]') as HTMLElement;
    press(del);
    expect(changes).toHaveLength(1);
    expect(del.textContent).toBe("Delete row 3 and its values");
    press(del);
    expect(changes.at(-1)).toBe("name,renews:date,amount:usd,paid:checkbox\nNetflix,2026-12-01,$15,true\n,,,\n");
  });

  test("Cmd+Backspace arms the selected row and says so, Escape keeps it, and a second press deletes it", () => {
    const { changes } = mount();
    press(cell(0, 0));
    key(cell(0, 0), "Backspace", { metaKey: true });
    expect(changes).toEqual([]);
    expect($('[data-testid="sheet-hint"]')?.textContent).toContain("again deletes row 1");
    key(cell(0, 0), "Escape");
    expect($('[data-testid="sheet-hint"]')?.textContent ?? "").not.toContain("deletes");
    key(cell(0, 0), "Backspace", { metaKey: true });
    key(cell(0, 0), "Backspace", { metaKey: true });
    expect(changes).toEqual(["name,renews:date,amount:usd,paid:checkbox\nGym,2026-12-09,40,false\n"]);
  });

  test("a read-only sheet has no row menu", () => {
    mount({ readOnly: true });
    press(handle(0));
    expect($('[data-testid="sheet-row-menu"]')).toBeNull();
  });

  test("a sort shows as a chip that flips on a press and clears on its ✕", async () => {
    mount();
    press($$('[data-testid="sheet-header"]')[2]);
    await settle();
    press(buttonWithText($('[data-testid="sheet-column-menu"]') as HTMLElement, "Sort descending") as HTMLElement);
    expect($('[data-testid="sheet-sort-chip"]')?.textContent).toBe("Sorted byamount▼✕");
    expect(cell(0, 0).textContent).toBe("Gym");
    press($('[data-testid="sheet-sort-flip"]') as HTMLElement);
    expect(cell(0, 0).textContent).toBe("Netflix");
    expect($('[data-testid="sheet-sort-chip"]')?.textContent).toContain("▲");
    press($('[data-testid="sheet-sort-clear"]') as HTMLElement);
    expect($('[data-testid="sheet-sort-chip"]')).toBeNull();
  });

  test("a filter's chip reopens it filled in, to update or remove it", async () => {
    mount();
    press($('[data-testid="sheet-add-filter"]') as HTMLElement);
    await settle();
    press(buttonWithText($('[data-testid="sheet-filter-menu"]') as HTMLElement, "amount") as HTMLElement);
    typeInto($('[data-testid="sheet-filter-value"]') as HTMLElement, "20");
    press($('[data-testid="sheet-filter-submit"]') as HTMLElement);
    expect($$('[data-testid="sheet-row"]')).toHaveLength(1);
    press($('[data-testid="sheet-filter-chip"] [role="button"]') as HTMLElement);
    await settle();
    expect(fieldIn($('[data-testid="sheet-filter-value"]') as HTMLElement).value).toBe("20");
    expect($('[data-testid="sheet-filter-submit"]')?.textContent).toBe("Update filter");
    typeInto($('[data-testid="sheet-filter-value"]') as HTMLElement, "10");
    press($('[data-testid="sheet-filter-submit"]') as HTMLElement);
    expect($$('[data-testid="sheet-filter-chip"]')).toHaveLength(1);
    expect($$('[data-testid="sheet-row"]')).toHaveLength(2);
    press($('[data-testid="sheet-filter-chip"] [role="button"]') as HTMLElement);
    await settle();
    press($('[data-testid="sheet-filter-remove"]') as HTMLElement);
    expect($$('[data-testid="sheet-filter-chip"]')).toHaveLength(0);
  });

  test("is empty applies in one press and its chip has no value", async () => {
    mount({ text: "name,notes\nA,\nB,x\n" });
    press($('[data-testid="sheet-add-filter"]') as HTMLElement);
    await settle();
    press(buttonWithText($('[data-testid="sheet-filter-menu"]') as HTMLElement, "notes") as HTMLElement);
    press($$('[data-testid="sheet-filter-op"]').find((el) => el.textContent === "is empty") as HTMLElement);
    expect($('[data-testid="sheet-filter-chip"]')?.textContent).toBe("notes is empty✕");
    expect($$('[data-testid="sheet-row"]')).toHaveLength(1);
    expect(cell(0, 0).textContent).toBe("A");
  });

  test("the calc menu offers what fits the type and shows each figure", async () => {
    mount();
    press($$('[data-testid="sheet-calc"]')[0]);
    await settle();
    const menu = $('[data-testid="sheet-calc-menu"]') as HTMLElement;
    expect(Array.from(menu.querySelectorAll('[role="button"]')).map((b) => b.textContent)).toEqual(["None", "Count2", "Empty0", "Filled2"]);
  });

  test("on a phone a tap on the selected cell edits it, and a line says so until then", () => {
    function Phone() {
      const [text, setText] = useState(SHEET);
      return createElement(SheetView, { path: "subs.csv", text, readOnly: false, compact: true, onChangeText: setText });
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(createElement(Phone)));
    unmount = () => act(() => root.unmount());
    expect($('[data-testid="sheet-touch-hint"]')?.textContent).toBe("Tap a cell twice to edit");
    press(cell(0, 0));
    expect($('[data-testid="sheet-cell-editor"]')).toBeNull();
    // Later than a double press, so only being selected counts.
    const later = Date.now() + 1000;
    const now = Date.now;
    Date.now = () => later;
    try {
      press(cell(0, 0));
    } finally {
      Date.now = now;
    }
    expect($('[data-testid="sheet-cell-editor"]')).not.toBeNull();
    expect($('[data-testid="sheet-touch-hint"]')).toBeNull();
  });
});
