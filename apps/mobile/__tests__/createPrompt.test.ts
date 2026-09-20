/**
 * @jest-environment jsdom
 */

/**
 * THE PHONE'S `+`, AND THE FIVE THINGS IT STARTS.
 *
 * A phone has no explorer — at `compact` the console draws none — so the one `+`
 * on the bottom row is the whole of "make something" on that surface. It used to
 * mean *note*, which left no way to make a folder on a phone at all; it then
 * offered three files; and it now offers everything the pointer layout's
 * `CreateButton` menu does, because the microphone beside it went: *"we no
 * longer need a dedicated mic button on the bottom row, just a plus button that
 * opens different options"*.
 *
 * What is worth a test here is not that a modal renders. It is that
 *
 *  - every row is offered, and each reaches the operation it *names* — a Folder
 *    row wired to `onCreateNote` would look completely correct on screen;
 *  - **the note and the drawing are made on the press**, with nothing asking for
 *    a name. That is the behaviour the owner asked for and the one a refactor
 *    would most plausibly undo, because re-adding a `NamePrompt` looks like
 *    restoring a safety check;
 *  - the folder still asks, which is the deliberate exception;
 *  - the two rows with nothing behind them are absent rather than inert.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests in this
 * file.
 *
 *   the Folder row wired to onCreateNote                            1
 *   the Note row routed through a NamePrompt again                  1
 *   the meeting row drawn with `onNewMeeting` null                  1
 *   `canEdit` ignored, so a reader is offered the three files       1
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
  /** Counts, not names: nothing names a note here any more. */
  notes: number;
  drawings: number;
  folders: string[];
  meetings: number;
  chats: number;
}

function mount(
  folder: string,
  options: { canEdit?: boolean; meeting?: boolean; chat?: boolean } = {},
): Made {
  const made: Made = { notes: 0, drawings: 0, folders: [], meetings: 0, chats: 0 };
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
          canEdit: options.canEdit ?? true,
          onCancel: () => {},
          onCreateNote: () => {
            made.notes += 1;
          },
          onCreateDrawing: () => {
            made.drawings += 1;
          },
          onCreateFolder: (name: string) => made.folders.push(name),
          onNewMeeting:
            options.meeting === false
              ? null
              : () => {
                  made.meetings += 1;
                },
          onNewChat:
            options.chat === true
              ? () => {
                  made.chats += 1;
                }
              : null,
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

describe("the phone's +", () => {
  test("every row is offered", () => {
    mount("1-projects", { chat: true });
    expect(labels()).toEqual(
      expect.arrayContaining([
        "New note",
        "New drawing",
        "New folder",
        "New chat",
        "New meeting",
      ]),
    );
  });

  test("it says where the thing is going", () => {
    mount("1-projects");
    expect(document.body.textContent).toContain("1-projects");
  });

  test("and names the root when that is the destination", () => {
    mount("");
    expect(document.body.textContent).toContain("the root of your context");
  });

  /**
   * THE ONE THAT MATTERS MOST.
   *
   * One press, one note, and **no field in between** — *"for new note, new
   * drawing etc should not ask you to title it"*. The `input` assertion is what
   * makes it a test of that rather than of the handler: a version that raised
   * `NamePrompt` and confirmed it would still end with `notes: 1`.
   */
  test("Note makes the note on the press, asking for no name", () => {
    const made = mount("1-projects");
    press("New note");
    expect(made).toEqual({ notes: 1, drawings: 0, folders: [], meetings: 0, chats: 0 });
    expect(document.body.querySelector("input, textarea")).toBeNull();
  });

  test("Drawing makes the drawing on the press, and nothing else", () => {
    /*
      Its own row rather than a name somebody has to know to type: a drawing is
      `<name>.excalidraw.md`, two extensions, and until this existed the only
      way to start one was to install Obsidian. Wired to its own handler for the
      reason the Folder row is — a Drawing row that called `onCreateNote` would
      look completely correct on screen and would write a note the gateway then
      refuses.
    */
    const made = mount("1-projects");
    press("New drawing");
    expect(made).toEqual({ notes: 0, drawings: 1, folders: [], meetings: 0, chats: 0 });
    expect(document.body.querySelector("input, textarea")).toBeNull();
  });

  /**
   * The exception, and it is deliberate. A note needs no prompt because it has a
   * title field inside it — its first line. A folder has no inside, so the only
   * way to name it is to ask, and `untitled-2026-09-19/` sitting in somebody's
   * bucket costs more than one text field.
   */
  test("Folder still asks for a name, and creates one folder", () => {
    const made = mount("1-projects");
    press("New folder");
    expect(document.body.querySelector("input, textarea")).not.toBeNull();
    name("editor-polish");
    expect(made).toEqual({
      notes: 0,
      drawings: 0,
      folders: ["editor-polish"],
      meetings: 0,
      chats: 0,
    });
  });

  test("Meeting reaches the meeting flow and creates no file", () => {
    const made = mount("1-projects");
    press("New meeting");
    expect(made).toEqual({ notes: 0, drawings: 0, folders: [], meetings: 1, chats: 0 });
  });

  test("Chat reaches the panel", () => {
    const made = mount("1-projects", { chat: true });
    press("New chat");
    expect(made).toEqual({ notes: 0, drawings: 0, folders: [], meetings: 0, chats: 1 });
  });

  /**
   * Absent, not inert. A phone has no panel for a conversation to open in, and a
   * surface with no meeting flow behind it (the fixtures, the demo console) has
   * nothing to record with — so neither row is drawn there rather than drawn and
   * doing nothing. The same rule `CreateButton` keeps for both.
   */
  test("no chat panel and no meeting flow means no row for either", () => {
    mount("1-projects", { chat: false, meeting: false });
    expect(labels()).not.toContain("New chat");
    expect(labels()).not.toContain("New meeting");
  });

  /**
   * A read-only context keeps the `+` and loses the three rows that write a
   * file. `menu.ts`'s rule — read-only means the control is *gone*, not present
   * and refusing — applied a row lower than it used to be: the bottom bar's key
   * is unconditional now, because a reader can still start a meeting.
   */
  test("a reader is offered no note, drawing or folder — and still a meeting", () => {
    mount("1-projects", { canEdit: false });
    expect(labels()).not.toContain("New note");
    expect(labels()).not.toContain("New drawing");
    expect(labels()).not.toContain("New folder");
    expect(labels()).toContain("New meeting");
  });

  test("nothing is created by opening the sheet", () => {
    // A `+` that wrote a note the moment it was pressed is what this replaced:
    // the bar used to call `createNote(folder, "Untitled")` directly.
    expect(mount("1-projects", { chat: true })).toEqual({
      notes: 0,
      drawings: 0,
      folders: [],
      meetings: 0,
      chats: 0,
    });
  });
});
