/**
 * @jest-environment jsdom
 */

/**
 * The console's search on a phone finds folders and tags, not only notes
 * (boards 03 and 04 of the phone Home artboards, approved 2026-09-30): the
 * wiring from `ConsoleFrame` through `usePaletteSearch` and `consolePalette`
 * to `SearchLookIn`, on the real console.
 *
 * SABOTAGE (each run once, each failed the test named):
 *  - `ConsoleFrame` passing no `places` to `consolePalette`: "Look in is there on a phone's search".
 *  - the folder row opening nothing: "a folder found by search opens its page".
 *  - a tag row not going Home: "a tag found by search goes Home, filtered to it".
 */

import { describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { mountConsole, navigated } from "./fixtures";
import { placeOpeners } from "../../features/console/layout/palette";
import { useHomeTag } from "../../features/console/home/homeTag";

function openSearch(app: ReturnType<typeof mountConsole>) {
  app.press(app.find("notes-bar-search"));
  expect(app.find("palette-input")).not.toBeNull();
}

describe("a phone's search on the console", () => {
  test("Look in is there on a phone's search", () => {
    const phone = mountConsole(390);
    openSearch(phone);
    expect(phone.find("search-look-in")).not.toBeNull();
    phone.unmount();
  });

  test("a folder found by search opens its page", () => {
    const app = mountConsole(390);
    openSearch(app);
    app.press(app.find("look-in-folders"));
    const row = app.find("search-folder");
    expect(row?.getAttribute("aria-label")).toMatch(/^projects, folder in /);
    app.press(row);
    expect(navigated).toEqual(["select:1-projects"]);
    expect(app.find("palette-input")).toBeNull();
    app.unmount();
  });

  test("with no tagged notes, Tags says so rather than drawing an empty card", () => {
    const app = mountConsole(390);
    openSearch(app);
    app.press(app.find("look-in-tags"));
    expect(app.find("search-places-none")!.textContent).toContain("No notes are tagged yet");
    app.unmount();
  });

  test("a tag found by search goes Home, filtered to it", () => {
    const closed: string[] = [];
    const data = { files: { select: (path: string) => navigated.push(`select:${path}`), deselect: () => navigated.push("home") } };
    placeOpeners(data as never, () => closed.push("closed")).onOpenTag("launch");
    expect(closed).toEqual(["closed"]);
    expect(navigated).toEqual(["home"]);
    let taken: string | null = null;
    function Home() {
      taken = useHomeTag()[0];
      return null;
    }
    const root = createRoot(document.createElement("div"));
    act(() => root.render(createElement(Home)));
    expect(taken).toBe("launch");
    act(() => root.unmount());
  });
});
