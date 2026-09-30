/**
 * @jest-environment jsdom
 */

/**
 * A folder page on a phone (board 07 of the Home artboards, 2026-09-30),
 * wired to the real console: under the title, what the folder holds, and its
 * ••• opening this folder's own actions with Pin to Home among them.
 * `phoneFolderHead.test.ts` holds the model; this holds the wire.
 *
 * SABOTAGE: drop `phoneHead` from BrowseDocument's `FolderView`. The head is
 * not drawn and every test here fails. Drop `pinned` from `openFolderTarget`'s
 * `itemsFor` and the Pin test fails alone.
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

describe("a phone's folder page", () => {
  test("says what the folder holds in place of the audience sentence", () => {
    const app = mountConsole(dataWith(IN_FOLDER as never, { kind: "folder", path: "notes", name: "notes" }));
    expect(app.find("phone-folder-counts")!.textContent).toBe("2 notes");
    expect(app.find("folder-audience")).toBeNull();
  });

  test("its ••• offers this folder's own actions, Pin to Home among them", () => {
    const app = mountConsole(dataWith(IN_FOLDER as never, { kind: "folder", path: "notes", name: "notes" }));
    app.press(app.find("phone-folder-actions"));
    expect(inBody("menu-sheet")).not.toBeNull();
    const labels = [...document.body.querySelectorAll('[data-testid^="menu-label-"]')].map((node) => node.textContent);
    expect(labels).toEqual(expect.arrayContaining(["Rename…", "Move to…", "Pin to Home", "Archive"]));
  });

  test("New folder inside asks for a name in this folder", () => {
    const app = mountConsole(dataWith(IN_FOLDER as never, { kind: "folder", path: "notes", name: "notes" }));
    app.press(app.find("phone-folder-new-folder"));
    expect(document.body.textContent).toContain("New folder");
  });
});
