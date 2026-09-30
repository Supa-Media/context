/**
 * @jest-environment jsdom
 */

/**
 * A folder's Tags (board 14 of the phone Home artboards, approved by the
 * owner on 2026-09-30), wired to the real console: the folder's ••• has
 * Tags, the sheet writes the folder's front note through this device's copy
 * — making `overview.md` when there is none — and says so with an Undo. The
 * picked rows' Tags (board 16) writes each note it covers.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. No `tagsOf` in `openFolderTarget`.              → "the folder's ••• has Tags, and Done writes its front note"
 *  2. `saveTags` never asking to create.               → "the folder's ••• has Tags, and Done writes its front note"
 *  3. No `saveTags` passed to `ExplorerDialogs`.       → both
 *  4. The bulk Tags opening the single-folder sheet.   → "the picked rows' Tags writes each note"
 *  5. `tagsOf` ignoring what the folder lists.         → "no Tags while a listed front note is still unread"
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act } from "react";
import { dataWith, ENTRY, mountConsole } from "./fixtures";

type Change = readonly (readonly [string, string | readonly string[] | null])[];
const mockWrites: [string, Change, { create?: boolean } | undefined][] = [];

// The device's real copy, with its property writes recorded instead of sent.
jest.mock("../../features/offline/useFolderLists", () => {
  const actual = jest.requireActual("../../features/offline/useFolderLists") as {
    useFolderLists: (...args: unknown[]) => object | undefined;
  };
  const { useMemo } = jest.requireActual("react") as typeof import("react");
  return {
    useFolderLists: (...args: unknown[]) => {
      const real = actual.useFolderLists(...args);
      return useMemo(
        () =>
          real === undefined
            ? undefined
            : {
                ...real,
                setProperties: async (path: string, changes: Change, options?: { create?: boolean }) => {
                  mockWrites.push([path, changes, options]);
                  return null;
                },
              },
        [real],
      );
    },
  };
});

// This device's copy of the workspace: both notes read, neither tagged, and no front note in the folder.
jest.mock("../../features/console/home/useHomeSource", () => {
  const source = {
    notes: [
      { path: "notes/alpha.md", title: "alpha", lede: null, tags: [] },
      { path: "notes/beta.md", title: "beta", lede: null, tags: [] },
    ],
    folders: ["", "notes"],
    shared: new Set<string>(),
  };
  return { useHomeSource: () => source };
});

afterEach(() => {
  mockWrites.length = 0;
});

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
const byLabel = (label: string) =>
  [...document.body.querySelectorAll<HTMLElement>("[aria-label]")].find((node) => node.getAttribute("aria-label") === label) ??
  null;

function type(text: string) {
  const input = document.body.querySelector('input[aria-label="Add a tag"]') as HTMLInputElement;
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("tags from a phone's folder page", () => {
  test("the folder's ••• has Tags, and Done writes its front note", async () => {
    const said: [string, boolean][] = [];
    const app = mountConsole(
      dataWith(
        { ...IN_FOLDER, say: (message: string, undo?: () => void) => said.push([message, undo !== undefined]) } as never,
        { kind: "folder", path: "notes", name: "notes" },
      ),
    );
    app.press(app.find("phone-folder-actions"));
    app.press(inBody("menu-item-tags"));
    expect(document.body.textContent).toContain("Tag notes");
    type("client");
    app.press(byLabel("Add “client” as a new tag"));
    app.press(byLabel("Done"));
    await settle();
    // No front note yet: overview.md, made by this write.
    expect(mockWrites).toEqual([["notes/overview.md", [["tags", ["client"]]], { create: true }]]);
    expect(said).toEqual([["Changed the tags on notes.", true]]);
  });

  test("the picked rows' Tags writes each note", async () => {
    const app = mountConsole(
      dataWith({ ...IN_FOLDER, say: () => {} } as never, { kind: "folder", path: "notes", name: "notes" }),
    );
    app.press(app.find("phone-folder-actions"));
    app.press(inBody("menu-item-selectNotes"));
    app.press(app.find("folder-select-all"));
    app.press(app.find("select-tags"));
    expect(document.body.textContent).toContain("Tag 2 items");
    type("lead");
    app.press(byLabel("Add “lead” as a new tag"));
    app.press(byLabel("Done"));
    await settle();
    expect(mockWrites).toEqual([
      ["notes/alpha.md", [["tags", ["lead"]]], undefined],
      ["notes/beta.md", [["tags", ["lead"]]], undefined],
    ]);
  });
});

describe("tags this phone has not read yet", () => {
  test("no Tags while a listed front note is still unread", () => {
    const listings = {
      ...IN_FOLDER.listings,
      notes: {
        ...IN_FOLDER.listings.notes,
        entries: [...IN_FOLDER.listings.notes.entries, { ...ENTRY, path: "notes/README.md", name: "README.md" }],
      },
    };
    const app = mountConsole(
      dataWith({ ...IN_FOLDER, listings } as never, { kind: "folder", path: "notes", name: "notes" }),
    );
    app.press(app.find("phone-folder-actions"));
    expect(inBody("menu-item-tags")).toBeNull();
    expect(inBody("menu-item-rename")).not.toBeNull();
  });
});
