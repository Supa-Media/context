/**
 * @jest-environment jsdom
 */

import { describe, expect, jest, test } from "@jest/globals";
import { act } from "react";
import { dataWith, emptyEditor, FILE, mountConsole, NOTE } from "./fixtures";

/**
 * **"We should be able to rename a note from the note header itself. Very
 * frustrating to have to go through multiple steps to rename a note"**
 * (owner, 2026-10-14).
 *
 * The note's name is a field in two places on the note: the end of the header's
 * path line, and — for a note with no title of its own — above the body, the
 * way Obsidian's inline title is. Both rename through `rename`, the dialog's
 * own path; `noteName.test.ts` holds the arithmetic.
 */

/** A note named by nothing but its file: no front matter title, no `# H1`. */
const BARE = "Just a first paragraph, no heading.\n";
const HEADED = "# plan\n\nThe body.\n";

function withText(text: string, over: Parameters<typeof dataWith>[0] = {}) {
  return dataWith({
    editor: { ...emptyEditor, status: "clean", path: NOTE, baseline: text, draft: text },
    ...over,
  });
}

const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;

function type(input: HTMLInputElement, value: string) {
  act(() => {
    input.focus();
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function key(input: HTMLInputElement, name: string) {
  act(() => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
  });
}

function leave(input: HTMLInputElement) {
  act(() => input.blur());
}

describe("the header's path line ends in the note's name, and it is a field", () => {
  test("on a pointer layout the name is drawn, and typing a new one renames the file", () => {
    const rename = jest.fn();
    const app = mountConsole(withText(FILE, { rename }), 1440);
    const field = app.find("breadcrumb-leaf-name") as HTMLInputElement | null;
    expect(field).not.toBeNull();
    expect(field!.value).toBe("plan");
    // The folders before it are still the way up.
    expect(app.container.querySelector('[aria-label="Open 1-projects"]')).not.toBeNull();

    type(field!, "Roadmap");
    key(field!, "Enter");
    leave(field!);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenCalledWith(NOTE, "Roadmap.md");
  });

  test("Escape puts the name back and renames nothing", () => {
    const rename = jest.fn();
    const app = mountConsole(withText(FILE, { rename }), 1440);
    const field = app.find("breadcrumb-leaf-name") as HTMLInputElement;
    type(field, "Roadmap");
    key(field, "Escape");
    leave(field);
    expect(rename).not.toHaveBeenCalled();
    expect(field.value).toBe("plan");
  });

  test("leaving it unchanged, or empty, renames nothing", () => {
    const rename = jest.fn();
    const app = mountConsole(withText(FILE, { rename }), 1440);
    const field = app.find("breadcrumb-leaf-name") as HTMLInputElement;
    type(field, "plan");
    leave(field);
    type(field, "   ");
    leave(field);
    expect(rename).not.toHaveBeenCalled();
    expect(field.value).toBe("plan");
  });

  test("somebody who may not edit gets the path line as it was, with no field", () => {
    const app = mountConsole(withText(FILE, { canEdit: false }), 1440);
    expect(app.find("breadcrumb-leaf-name")).toBeNull();
    expect(app.find("note-inline-title")).toBeNull();
  });
});

describe("a note with no title of its own shows its name above the body", () => {
  test("on a pointer layout, as a field that renames the note", () => {
    const rename = jest.fn();
    const app = mountConsole(withText(BARE, { rename }), 1440);
    const title = app.find("note-inline-title") as HTMLInputElement | null;
    expect(title).not.toBeNull();
    expect(title!.value).toBe("plan");
    type(title!, "Thinking about community");
    leave(title!);
    expect(rename).toHaveBeenCalledWith(NOTE, "Thinking about community.md");
  });

  test("on a phone too", () => {
    const rename = jest.fn();
    const app = mountConsole(withText(BARE, { rename }), 390);
    const title = app.find("note-inline-title") as HTMLInputElement | null;
    expect(title).not.toBeNull();
    expect(title!.tagName).toBe("INPUT");
    type(title!, "Weekly sync");
    leave(title!);
    expect(rename).toHaveBeenCalledWith(NOTE, "Weekly sync.md");
  });

  test("a note whose heading names it keeps the heading as its title, with no second one", () => {
    const app = mountConsole(withText(HEADED), 1440);
    expect(app.find("note-inline-title")).toBeNull();
  });

  test("a note titled in its front matter keeps that title as text on a phone", () => {
    const app = mountConsole(withText(FILE), 390);
    const title = app.find("note-inline-title");
    expect(title).not.toBeNull();
    expect(title!.tagName).not.toBe("INPUT");
    expect(title!.textContent).toBe("The storage binding");
  });
});
