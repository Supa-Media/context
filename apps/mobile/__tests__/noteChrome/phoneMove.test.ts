/**
 * @jest-environment jsdom
 */

/**
 * Move on a phone (board 12 of the Home artboards, approved 2026-09-30): a
 * bottom sheet with the same place picker New folder uses — the workspace by
 * name, its folders as a tree, "Find a folder", the folder it is in now marked
 * "Here now" — confirmed by a button that names where it goes. It was the
 * pointer layout's centred popup of raw paths, `/ (root)` included, until the
 * owner's retest on 2026-10-01.
 *
 * SABOTAGE: drop `sheet` from `MovePicker`'s compact branch and the sheet test
 * fails; send the compact branch back to the path list and every test fails.
 */

import { describe, expect, test } from "@jest/globals";
import { act } from "react";
import { dataWith, ENTRY, mountConsole } from "./fixtures";

const folder = (path: string) => ({ ...ENTRY, path, name: path.split("/").pop()!, kind: "folder" as const });

const listings = {
  "": {
    path: "",
    folderDefault: "private" as const,
    truncated: false,
    manifestUsable: true,
    entries: [folder("clients"), folder("projects")],
  },
  clients: {
    path: "clients",
    folderDefault: "private" as const,
    truncated: false,
    manifestUsable: true,
    entries: [{ ...ENTRY, path: "clients/acme.md", name: "acme.md" }],
  },
  projects: { path: "projects", folderDefault: "private" as const, truncated: false, manifestUsable: true, entries: [] },
};

const inBody = (testID: string) => document.body.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
const byLabel = (label: string) => document.body.querySelector<HTMLElement>(`[aria-label="${label}"]`);

function openMove(moved: string[]) {
  const app = mountConsole(
    dataWith({ selectedPath: "clients", listings, move: (from: string, to: string) => moved.push(`${from} -> ${to}`) } as never, {
      kind: "folder",
      path: "clients",
      name: "clients",
    }),
  );
  app.press(app.find("phone-folder-actions"));
  app.press(inBody("menu-item-moveTo"));
  return app;
}

describe("Move on a phone", () => {
  test("is a bottom sheet with the place picker, not a list of paths", () => {
    openMove([]);
    expect(inBody("dialog-sheet")).not.toBeNull();
    expect(document.body.textContent).toContain("Move clients");
    expect(byLabel("Find a folder")).not.toBeNull();
    expect(document.body.textContent).not.toContain("/ (root)");
    // The folder being moved is not somewhere it can go.
    const rows = [...document.body.querySelectorAll('[data-testid="place-row"]')].map((row) => row.getAttribute("aria-label"));
    expect(rows.some((row) => row?.startsWith("clients"))).toBe(false);
    expect(rows.some((row) => row?.startsWith("projects"))).toBe(true);
  });

  test("marks where it is now, and will not move it there", () => {
    openMove([]);
    expect(document.body.textContent).toContain("Here now");
    const confirm = inBody("place-confirm")!;
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
  });

  test("names the place on its button and moves it there", () => {
    const moved: string[] = [];
    openMove(moved);
    act(() => {
      byLabel("projects")!.click();
    });
    const confirm = inBody("place-confirm")!;
    expect(confirm.textContent).toBe("Move to projects");
    act(() => {
      confirm.click();
    });
    expect(moved).toEqual(["clients -> projects"]);
  });
});
