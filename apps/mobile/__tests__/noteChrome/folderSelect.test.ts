/**
 * @jest-environment jsdom
 */

/**
 * The phone folder page's select mode (board 16 of the phone Home artboards,
 * approved by the owner on 2026-09-30), wired to the real console: the
 * folder's ••• has Select notes, the line over the listing becomes Cancel,
 * the count and Select all, and the bottom bar gives up search for Move,
 * Tags, Pin, Archive and More over the picked rows. More is the tree's own
 * multi-selection menu (`menu.ts`, a `selection` target), and Move reaches
 * the same batch dialog it does. `folderSelect.test.ts` holds the component;
 * this holds the wire, which a component test cannot see.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. No `selectable` in `openFolderTarget`.          → "Select notes, from the folder's •••, …"
 *  2. `FolderView` ignoring `askSelect`.              → "Select notes, from the folder's •••, …"
 *  3. `FolderView` not publishing `showSelectBar`.    → "…gives the bottom bar to the picked rows"
 *  4. `FolderView` not clearing it on Cancel.         → "Cancel gives the bottom bar back to search"
 *  5. `onSelection` dropped from `folderMenuFor`.     → "More is the tree's selection menu, …"
 */

import { describe, expect, test } from "@jest/globals";
import { dataWith, ENTRY, mountConsole } from "./fixtures";

const IN_FOLDER = {
  selectedPath: "notes",
  listings: {
    "": {
      path: "",
      folderDefault: "private" as const,
      truncated: false,
      manifestUsable: true,
      entries: [{ ...ENTRY, path: "notes", name: "notes", kind: "folder" as const }],
    },
    notes: {
      path: "notes",
      folderDefault: "private" as const,
      truncated: false,
      manifestUsable: true,
      entries: [
        { ...ENTRY, path: "notes/alpha.md", name: "alpha.md" },
        { ...ENTRY, path: "notes/beta.md", name: "beta.md" },
      ],
    },
  },
};

const inBody = (testID: string) => document.body.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
const off = (node: HTMLElement | null) => node?.getAttribute("aria-disabled") === "true";

function selecting(over: Record<string, unknown> = {}) {
  const app = mountConsole(dataWith({ ...IN_FOLDER, ...over } as never, { kind: "folder", path: "notes", name: "notes" }));
  app.press(app.find("phone-folder-actions"));
  app.press(inBody("menu-item-selectNotes"));
  return app;
}

function pickBoth(app: ReturnType<typeof mountConsole>) {
  for (const row of app.container.querySelectorAll<HTMLElement>('[data-testid="folder-row"]')) app.press(row);
}

describe("a phone's folder page acts on several notes at once", () => {
  test("Select notes, from the folder's •••, enters select mode, with no Select button of its own", () => {
    const plain = mountConsole(dataWith(IN_FOLDER as never, { kind: "folder", path: "notes", name: "notes" }));
    expect(plain.find("folder-select")).toBeNull();
    plain.press(plain.find("phone-folder-actions"));
    const labels = [...document.body.querySelectorAll('[data-testid^="menu-label-"]')].map((node) => node.textContent);
    expect(labels).toContain("Select notes");
    plain.press(inBody("menu-item-selectNotes"));
    expect(plain.find("folder-select-count")!.textContent).toBe("0 selected");
    expect(plain.find("folder-select-done")!.textContent).toBe("Cancel");
  });

  test("…gives the bottom bar to the picked rows, dimmed until one is picked", () => {
    const app = selecting();
    expect(app.find("notes-bar")).toBeNull();
    expect(app.find("select-actions")).not.toBeNull();
    for (const key of ["select-move", "select-pin", "select-archive", "select-more"]) expect(off(app.find(key))).toBe(true);
    pickBoth(app);
    expect(app.find("folder-select-count")!.textContent).toBe("2 selected");
    for (const key of ["select-move", "select-archive", "select-more"]) expect(off(app.find(key))).toBe(false);
  });

  test("Select all picks every row, and again picks none", () => {
    const app = selecting();
    app.press(app.find("folder-select-all"));
    expect(app.find("folder-select-count")!.textContent).toBe("2 selected");
    expect(app.find("folder-select-all")!.textContent).toBe("Deselect all");
    app.press(app.find("folder-select-all"));
    expect(app.find("folder-select-count")!.textContent).toBe("0 selected");
  });

  test("Move reaches the batch move dialog", () => {
    const app = selecting();
    pickBoth(app);
    app.press(app.find("select-move"));
    expect(document.body.textContent).toContain("Move 2 items");
  });

  test("…and Archive asks before putting them away", () => {
    const app = selecting();
    pickBoth(app);
    app.press(app.find("select-archive"));
    expect(document.body.textContent).toContain("Archive 2 items");
  });

  test("Pin puts them on Home and says so, with an Undo", () => {
    const said: [string, boolean][] = [];
    const app = selecting({ say: (message: string, undo?: () => void) => said.push([message, undo !== undefined]) });
    pickBoth(app);
    expect(app.find("select-pin")!.textContent).toBe("Pin");
    app.press(app.find("select-pin"));
    expect(said).toEqual([["Pinned 2 items to Home.", true]]);
    // Both are on Home now, so the same button takes them off.
    expect(app.find("select-pin")!.textContent).toBe("Unpin");
  });

  test("More is the tree's selection menu, as a sheet", () => {
    const app = selecting();
    pickBoth(app);
    app.press(app.find("select-more"));
    expect(inBody("menu-sheet")).not.toBeNull();
    const labels = [...document.body.querySelectorAll('[data-testid^="menu-label-"]')].map((node) => node.textContent);
    expect(labels).toContain("Move 2 items to…");
    expect(labels).not.toContain("Rename…");
  });

  test("Cancel gives the bottom bar back to search", () => {
    const app = selecting();
    app.press(app.find("folder-select-done"));
    expect(app.find("folder-select-count")).toBeNull();
    expect(app.find("select-actions")).toBeNull();
    expect(app.find("notes-bar")).not.toBeNull();
  });
});
