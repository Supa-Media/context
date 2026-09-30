/**
 * @jest-environment jsdom
 */

/**
 * "Search in <folder>" on a phone (board 07b of the Home artboards, approved
 * by the owner on 2026-09-30).
 *
 * On a folder's page the bottom bar's field names the folder, and the search
 * it opens asks the bucket for that folder and everything under it — the
 * gateway's own `prefix`, with a trailing slash so `1-projects` never finds
 * `1-projects-old`. One chip widens it to the whole workspace; from Home, and
 * after search closes, it is the whole workspace again.
 *
 * SABOTAGE (each run once, each failed the test named):
 *  - `usePaletteSearch` passing `wholeSearch` instead of `scopedSearch` to
 *    `useContextSearch`: "a folder page's search asks the bucket for that folder only".
 *  - dropping the `useEffect` that clears the scope when search closes in
 *    `ConsoleFrame`: "search opened from Home, after a folder's, is the whole workspace".
 */

import { describe, expect, test } from "@jest/globals";
import { act } from "react";
import { mockConsoleState, mountConsole } from "./fixtures";

function type(app: ReturnType<typeof mountConsole>, query: string) {
  const input = app.find("palette-input") as HTMLInputElement | null;
  if (input === null) throw new Error("search did not open");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, query);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}

async function settle() {
  // Past `useContextSearch`'s debounce.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
}

function recordSearches() {
  const asked: { query: string; prefix: string | undefined }[] = [];
  mockConsoleState.search = (query, prefix) => {
    asked.push({ query, prefix });
    return new Promise<never>(() => {});
  };
  return asked;
}

describe("search on a phone follows the folder you are in", () => {
  test("Home's field reads Search, and opens a search of the whole workspace", () => {
    const app = mountConsole(390);
    expect(app.find("notes-bar-search")!.textContent).toBe("Search");
    app.press(app.find("notes-bar-search"));
    expect(app.find("palette-input")).not.toBeNull();
    expect(app.find("search-scope")).toBeNull();
    app.unmount();
  });

  test("a folder page's field names the folder, and search opens narrowed to it", () => {
    mockConsoleState.selectedPath = "1-projects";
    const app = mountConsole(390);
    const field = app.find("notes-bar-search")!;
    expect(field.textContent).toMatch(/^Search in projects$/i);

    app.press(field);
    const input = app.find("palette-input") as HTMLInputElement;
    expect(input.placeholder).toMatch(/^Search in projects$/i);
    expect(app.find("search-scope-folder")!.textContent).toMatch(/^In projects$/i);

    // One chip widens it, and the field says so.
    app.press(app.find("search-scope-everywhere"));
    expect(app.find("search-scope")).toBeNull();
    expect((app.find("palette-input") as HTMLInputElement).placeholder).toBe("Search");
    app.unmount();
  });

  test("a folder page's search asks the bucket for that folder only", async () => {
    const asked = recordSearches();
    mockConsoleState.selectedPath = "1-projects";
    const app = mountConsole(390);
    app.press(app.find("notes-bar-search"));
    type(app, "roadmap");
    await settle();
    expect(asked.at(-1)).toEqual({ query: "roadmap", prefix: "1-projects/" });

    // Everywhere asks again, with no prefix at all.
    app.press(app.find("search-scope-everywhere"));
    type(app, "roadmaps");
    await settle();
    expect(asked.at(-1)).toEqual({ query: "roadmaps", prefix: undefined });
    app.unmount();
  });

  test("search opened from Home, after a folder's, is the whole workspace", async () => {
    const asked = recordSearches();
    mockConsoleState.selectedPath = "1-projects";
    const app = mountConsole(390);
    app.press(app.find("notes-bar-search"));
    expect(app.find("search-scope")).not.toBeNull();

    // Closed from inside, the way a person leaves it.
    const input = app.find("palette-input")!;
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(app.find("palette-input")).toBeNull();

    // ⌘K opens search with no folder in hand; it must not inherit the last one.
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
    });
    expect(app.find("palette-input")).not.toBeNull();
    expect(app.find("search-scope")).toBeNull();
    type(app, "roadmap");
    await settle();
    expect(asked.at(-1)).toEqual({ query: "roadmap", prefix: undefined });
    app.unmount();
  });
});
