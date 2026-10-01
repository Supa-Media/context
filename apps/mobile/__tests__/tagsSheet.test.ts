/**
 * @jest-environment jsdom
 */

/**
 * The Tags sheet (board 14 of the phone Home artboards, approved by the owner
 * on 2026-09-30): the folder's tags as chips, suggestions from the workspace
 * as you type with the best one taken by return, a new tag always offered
 * last, and nothing written until Done.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. Return taking the new tag over the best suggestion. → "return takes the best suggestion"
 *  2. A chip's press not removing it.                     → "a chip's × takes it off, and Done writes them all at once"
 *  3. Done writing when nothing changed.                  → "Done with nothing changed writes nothing"
 *  4. The sheet closing on a refusal.                     → "a refusal is said in the sheet, which stays open"
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { SafeAreaProvider, initialWindowMetrics } from "react-native-safe-area-context";
import { TagsSheet } from "../features/console/files/TagsSheet";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const METRICS = initialWindowMetrics ?? {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const KNOWN = [
  { tag: "client", count: 9 },
  { tag: "retainer", count: 4 },
  { tag: "lead", count: 2 },
];

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
});

function mount(initial: string[], answer: string | null = null) {
  const saved: (readonly string[])[] = [];
  const closed: number[] = [];
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
        createElement(TagsSheet, {
          name: "Acme",
          initial,
          known: KNOWN,
          workspaceLabel: "Northwind",
          onCancel: () => closed.push(1),
          onSave: async (tags: readonly string[]) => {
            saved.push(tags);
            return answer;
          },
        }),
      ),
    ),
  );
  return { saved, closed };
}

const all = (testID: string) => [...document.body.querySelectorAll(`[data-testid="${testID}"]`)];
const byLabel = (label: string) =>
  [...document.body.querySelectorAll("[aria-label]")].find((node) => node.getAttribute("aria-label") === label) as
    | HTMLElement
    | undefined;
const input = () => document.body.querySelector('input[aria-label="Add a tag"]') as HTMLInputElement;

function press(label: string) {
  const node = byLabel(label);
  expect(node).toBeDefined();
  act(() => {
    for (const type of ["mousedown", "mouseup", "click"]) node!.dispatchEvent(new MouseEvent(type, { bubbles: true }));
  });
}

function type(text: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input(), text);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function enter() {
  act(() => {
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    input().dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", bubbles: true }));
  });
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("the Tags sheet", () => {
  test("shows the folder's tags and offers the workspace's others", () => {
    mount(["client"]);
    expect(document.body.textContent).toContain("Tag Acme");
    expect(all("tag-chip").map((chip) => chip.textContent)).toEqual(["client"]);
    expect(all("tag-suggestion").map((row) => row.textContent)).toEqual(["retainer4 notes", "lead2 notes"]);
    expect(document.body.textContent).toContain("Tags already in Northwind");
  });

  test("return takes the best suggestion", () => {
    mount([]);
    type("ret");
    expect(all("tag-suggestion").map((row) => row.textContent)).toEqual(["retainer4 notes"]);
    expect(byLabel("Add “ret” as a new tag")).toBeDefined();
    enter();
    expect(all("tag-chip").map((chip) => chip.textContent)).toEqual(["retainer"]);
    expect(input().value).toBe("");
  });

  test("a new tag is always there to add", () => {
    mount([]);
    type("launch week");
    expect(all("tag-suggestion")).toEqual([]);
    enter();
    expect(all("tag-chip").map((chip) => chip.textContent)).toEqual(["launch-week"]);
  });

  test("a chip's × takes it off, and Done writes them all at once", async () => {
    const { saved, closed } = mount(["client", "lead"]);
    press("Remove client");
    type("ret");
    press("retainer, 4 notes");
    expect(saved).toEqual([]);
    press("Done");
    await settle();
    expect(saved).toEqual([["lead", "retainer"]]);
    expect(closed).toEqual([1]);
  });

  test("Done with nothing changed writes nothing", () => {
    const { saved, closed } = mount(["client"]);
    press("Done");
    expect(saved).toEqual([]);
    expect(closed).toEqual([1]);
  });

  test("a refusal is said in the sheet, which stays open", async () => {
    const { closed } = mount([], "Someone changed Acme just now.");
    press("lead, 2 notes");
    press("Done");
    await settle();
    expect(document.body.textContent).toContain("Someone changed Acme just now.");
    expect(closed).toEqual([]);
  });
});
