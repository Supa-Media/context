/**
 * @jest-environment jsdom
 */

/**
 * Choosing where a new folder goes (boards 05 and 05b of the phone Home
 * artboards, approved by the owner on 2026-09-30).
 *
 * The form starts at the place the button was pressed in, "Put it in" swaps
 * it for the place picker in the same sheet, and confirming there comes back
 * with the name still typed and the new place on the row. The picker is the
 * workspace at the top and a tree you open a level at a time, or a flat list
 * of matches once something is typed into "Find a folder".
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. `pickerRows` walking every folder, open or not.   → "lists the top level, and opens a level at a time"
 *  2. `openTo` not opening the ancestors.                → "opens onto the place it starts at"
 *  3. Found folders without where they are.             → "Find a folder lists matches flat, each saying where it is"
 *  4. The picker's confirm not handing back the pick.    → "picking a place comes back to the form with the name kept"
 *  5. `onCreate` given the starting folder, not the pick. → "picking a place comes back to the form with the name kept"
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { SafeAreaProvider, initialWindowMetrics } from "react-native-safe-area-context";
import { NewFolderForm } from "../features/console/files/NewFolderForm";
import { openTo, pickerRows } from "../features/console/files/folderPickerModel";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FOLDERS = ["", "1-projects", "1-projects/launch-week", "1-projects/website", "clients", "clients/acme", "team"];

const labelsOf = (rows: ReturnType<typeof pickerRows>) => rows.map((row) => `${"  ".repeat(row.depth)}${row.label}`);

describe("the place picker's rows", () => {
  test("lists the top level, and opens a level at a time", () => {
    const closed = pickerRows({ folders: FOLDERS, open: new Set([""]), query: "", rootLabel: "Northwind" });
    expect(labelsOf(closed)).toEqual(["Northwind", "  clients", "  projects", "  team"]);
    expect(closed[0]).toMatchObject({ path: "", sub: "Top level" });
    expect(closed.find((row) => row.path === "1-projects")).toMatchObject({ opens: true, open: false });
    expect(closed.find((row) => row.path === "team")).toMatchObject({ opens: false });

    const opened = pickerRows({ folders: FOLDERS, open: new Set(["", "1-projects"]), query: "", rootLabel: "Northwind" });
    expect(labelsOf(opened)).toEqual(["Northwind", "  clients", "  projects", "    launch-week", "    website", "  team"]);
  });

  test("opens onto the place it starts at", () => {
    expect([...openTo("clients/acme")].sort()).toEqual(["", "clients"]);
    const rows = pickerRows({ folders: FOLDERS, open: openTo("clients/acme"), query: "", rootLabel: "Northwind" });
    expect(rows.map((row) => row.path)).toContain("clients/acme");
  });

  test("Find a folder lists matches flat, each saying where it is", () => {
    const found = pickerRows({ folders: FOLDERS, open: new Set([""]), query: "WEB", rootLabel: "Northwind" });
    expect(found).toEqual([
      { path: "1-projects/website", label: "website", depth: 0, sub: "Northwind › projects", opens: false, open: false },
    ]);
    expect(pickerRows({ folders: FOLDERS, open: new Set([""]), query: "zzz", rootLabel: "Northwind" })).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */

const METRICS = initialWindowMetrics ?? {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
});

function mount(folder: string) {
  const made: [string, string][] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() =>
    root.render(
      createElement(
        SafeAreaProvider,
        { initialMetrics: METRICS },
        createElement(NewFolderForm, {
          folder,
          folders: FOLDERS,
          rootLabel: "Northwind",
          onCancel: () => {},
          onCreate: (place: string, name: string) => made.push([place, name]),
        }),
      ),
    ),
  );
  return made;
}

const labels = () => [...document.body.querySelectorAll("[aria-label]")].map((node) => node.getAttribute("aria-label"));

function press(label: string) {
  const node = [...document.body.querySelectorAll("[aria-label]")].find((one) => one.getAttribute("aria-label") === label);
  expect(node).toBeDefined();
  act(() => {
    for (const type of ["mousedown", "mouseup", "click"]) node!.dispatchEvent(new MouseEvent(type, { bubbles: true }));
  });
}

function type(label: string, text: string) {
  const input = document.body.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const disabled = (label: string) =>
  [...document.body.querySelectorAll("[aria-label]")]
    .find((one) => one.getAttribute("aria-label") === label)
    ?.getAttribute("aria-disabled") === "true";

describe("New folder's form", () => {
  test("starts where it was opened, and Create waits for a name", () => {
    mount("clients");
    expect(labels()).toContain("Put it in clients. Change");
    expect(document.body.textContent).toContain("Northwind › clients");
    expect(document.body.textContent).toContain("Who can see it: the same people who can see clients.");
    expect(disabled("Create")).toBe(true);
    type("Folder name", "hiring");
    expect(disabled("Create")).toBe(false);
  });

  test("picking a place comes back to the form with the name kept", () => {
    const made = mount("clients");
    type("Folder name", "hiring");
    press("Put it in clients. Change");
    expect(document.body.textContent).toContain("Put hiring in");
    // Opened onto where it was: clients is picked, still closed, with its arrow to look inside.
    expect(labels()).toContain("clients, picked");
    expect(labels()).toContain("Open clients");
    press("team");
    press("Put it in team");
    expect(labels()).toContain("Put it in team. Change");
    expect((document.body.querySelector('input[aria-label="Folder name"]') as HTMLInputElement).value).toBe("hiring");
    press("Create");
    expect(made).toEqual([["team", "hiring"]]);
  });

  test("Back leaves the place as it was", () => {
    mount("");
    press("Put it in Northwind. Change");
    press("team");
    press("Back");
    expect(labels()).toContain("Put it in Northwind. Change");
  });

  test("a folder's arrow opens it without picking it", () => {
    mount("");
    press("Put it in Northwind. Change");
    expect(labels()).not.toContain("website");
    press("Open projects");
    expect(labels()).toContain("website");
    expect(labels()).toContain("Northwind, picked");
  });
});
