/**
 * @jest-environment jsdom
 */

/**
 * The phone folder page's select mode, wired to the real console: the rows
 * picked there reach the tree's own multi-selection menu (`menu.ts`, a
 * `selection` target) and its choice reaches the real dialogs, through
 * `useFolderListing`'s `onSelection`. `folderSelect.test.ts` holds the
 * component; this holds the wire, which a component test cannot see.
 *
 * SABOTAGE: drop `onSelection` from `folderMenuFor` in `useFolderListing`.
 * The Select button is not drawn and both tests fail.
 */

import { describe, expect, test } from "@jest/globals";
import { dataWith, ENTRY, mountConsole } from "./fixtures";

/*
  A folder rather than the workspace's own page: on a phone that is Home since
  2026-09-30 (`home/PhoneHome.tsx`), not a listing with a select mode.
*/
const IN_FOLDER = {
  selectedPath: "notes",
  listings: {
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

const inBody = (testID: string) =>
  document.body.querySelector<HTMLElement>(`[data-testid="${testID}"]`);

describe("a phone's folder page acts on several notes at once", () => {
  test("two picked rows open the tree's selection menu, as a sheet", () => {
    const app = mountConsole(dataWith(IN_FOLDER as never, { kind: "folder", path: "notes", name: "notes" }));
    app.press(app.find("folder-select"));
    for (const row of app.container.querySelectorAll<HTMLElement>('[data-testid="folder-row"]')) {
      app.press(row);
    }
    app.press(app.find("folder-select-actions"));

    expect(inBody("menu-sheet")).not.toBeNull();
    // The plural items `menu.ts` offers a selection, and not a single row's.
    const labels = [...document.body.querySelectorAll('[data-testid^="menu-label-"]')].map(
      (node) => node.textContent,
    );
    expect(labels).toContain("Move 2 items to…");
    expect(labels).not.toContain("Rename…");
  });

  test("…and Move reaches the batch move dialog", () => {
    const app = mountConsole(dataWith(IN_FOLDER as never, { kind: "folder", path: "notes", name: "notes" }));
    app.press(app.find("folder-select"));
    for (const row of app.container.querySelectorAll<HTMLElement>('[data-testid="folder-row"]')) {
      app.press(row);
    }
    app.press(app.find("folder-select-actions"));
    app.press(inBody("menu-item-moveTo"));
    expect(document.body.textContent).toContain("Move 2 items");
  });
});
