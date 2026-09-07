/**
 * @jest-environment jsdom
 */

/**
 * A PHONE COULD NOT MAKE A FOLDER.
 *
 * Not in the bottom bar, not in the folder view, not behind a long press: at
 * `compact` the console draws no explorer, and the explorer's toolbar is where
 * both New note and New folder lived. The one `+` on the bar meant *note*, so
 * the operation was unreachable on the only surface that had no other route to
 * it — the owner found it by needing one.
 *
 * `CreatePrompt` is the chooser that key now raises. What is worth a test here
 * is not that a modal renders: it is that **both** rows are offered and that
 * each reaches the operation it names. A chooser whose Folder row created a
 * note would look completely correct on screen.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests in this
 * file.
 *
 *   the Folder row wired to onCreateNote                            1
 *   the chooser skipped, opening the note prompt directly           2
 */

import { afterEach, describe, expect, test } from "@jest/globals";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { SafeAreaProvider, initialWindowMetrics } from "react-native-safe-area-context";
import { CreatePrompt } from "../features/console/files/Dialogs";

/** `Shell` reaches for safe-area insets on the web build. */
const METRICS = initialWindowMetrics ?? {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
});

interface Made {
  notes: string[];
  folders: string[];
}

function mount(folder: string): Made {
  const made: Made = { notes: [], folders: [] };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(
      createElement(
        SafeAreaProvider,
        { initialMetrics: METRICS },
        createElement(CreatePrompt, {
          folder,
          onCancel: () => {},
          onCreateNote: (name: string) => made.notes.push(name),
          onCreateFolder: (name: string) => made.folders.push(name),
        }),
      ),
    );
  });
  return made;
}

/** Every labelled control currently on screen. */
function labels(): string[] {
  return [...document.body.querySelectorAll("[aria-label]")].map(
    (node) => node.getAttribute("aria-label") ?? "",
  );
}

function press(label: string): void {
  const node = [...document.body.querySelectorAll("[aria-label]")].find(
    (candidate) => candidate.getAttribute("aria-label") === label,
  );
  expect(node).toBeDefined();
  act(() => {
    for (const type of ["mousedown", "mouseup", "click"]) {
      node!.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    }
  });
}

/** Type a name into the prompt the chooser swapped itself for, and confirm. */
function name(text: string): void {
  const input = document.body.querySelector("input, textarea") as HTMLInputElement | null;
  expect(input).not.toBeNull();
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, text);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  press("Create");
}

describe("the phone's + asks which of the two it is", () => {
  test("both rows are offered", () => {
    mount("1-projects");
    // The whole point of the change: Folder is reachable. Note is asserted
    // alongside it so this cannot pass by rendering an empty dialog.
    expect(labels()).toEqual(expect.arrayContaining(["New note", "New folder"]));
  });

  test("it says where the thing is going", () => {
    mount("1-projects");
    expect(document.body.textContent).toContain("1-projects");
  });

  test("and names the root when that is the destination", () => {
    mount("");
    expect(document.body.textContent).toContain("the root of your context");
  });

  test("choosing Note creates a note and no folder", () => {
    const made = mount("1-projects");
    press("New note");
    name("plan");
    expect(made).toEqual({ notes: ["plan"], folders: [] });
  });

  test("choosing Folder creates a folder and no note", () => {
    const made = mount("1-projects");
    press("New folder");
    name("editor-polish");
    expect(made).toEqual({ notes: [], folders: ["editor-polish"] });
  });

  test("nothing is created by opening the chooser", () => {
    // A `+` that wrote a note the moment it was pressed is what this replaced:
    // the bar used to call `createNote(folder, "Untitled")` directly.
    expect(mount("1-projects")).toEqual({ notes: [], folders: [] });
  });
});
