/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import { dataWith, mountConsole, NOTE } from "./fixtures";

describe("the note names itself, inside itself", () => {
  /**
   * THE assertion for this branch, and it is **narrower than it was**.
   *
   * It used to end by asserting that no breadcrumb segment existed on a phone
   * at all, because the whole row had been deleted here. The path half is back
   * (see `the path bar` below) and the naming half is not, which is the line
   * this test now holds: the note is named *inside itself*, once.
   *
   * So "put the breadcrumb back and this fails" is no longer the rule, and
   * neither is "put its leaf back" — **that reversed too**, and this test is
   * where the two halves are now separated properly.
   *
   * The leaf came back because the argument for deleting it was about the
   * wrong element: the inline title is *inside the scroller* and is gone the
   * moment somebody reads past the first screen, so a band that stopped at the
   * folder above named nothing on screen from the second screen onward — and
   * for `index.md`, which has no folder above it, named nothing at all. What
   * still holds, and is what this asserts, is that the leaf is not a **second
   * control**: it is a position, and the note is named once as a thing you can
   * act on.
   */
  test("an inline title, and the crumb's leaf is a position rather than a control", () => {
    const app = mountConsole(dataWith());

    const title = app.find("note-inline-title");
    expect(title).not.toBeNull();
    // What the note calls itself, not what it is filed as: a captured note's
    // filename is a content hash, which is why `noteHeading` exists at all.
    expect(title!.textContent).toBe("The storage binding");

    // No path row names it a second time any more (owner, 2026-10-01: "I dont
    // think we need to show the file path at the top of notes anymore"); the
    // way up is the back button, which names the folder above.
    expect(app.find("breadcrumb-leaf")).toBeNull();
    expect(app.container.querySelector(`[aria-label="Open ${NOTE}"]`)).toBeNull();
    expect(app.find("phone-back")).not.toBeNull();
    // …and the visibility chip stayed gone.
    expect(app.container.textContent).not.toContain("follows its folder");
  });

  test("the title scrolls with the note rather than sitting above it", () => {
    /*
      An inline title that is not inside the scroller is a breadcrumb wearing a
      larger font. The reference's own giveaway is mid-scroll: the title and the
      Properties panel pass *under* the floating chrome.
    */
    const app = mountConsole(dataWith());
    const scroll = app.find("note-scroll");
    expect(scroll).not.toBeNull();
    expect(scroll!.contains(app.find("note-inline-title"))).toBe(true);
    expect(scroll!.contains(app.find("note-properties"))).toBe(true);
  });

  test("a pointer layout keeps the breadcrumb and does not draw a title", () => {
    // The desktop is not Obsidian's desktop and is not in scope: there the
    // breadcrumb is a region header that also carries folder navigation, and
    // two names above one note is worse than either.
    const app = mountConsole(dataWith(), 1440);
    expect(app.find("note-inline-title")).toBeNull();
    expect(app.container.querySelector('[aria-label="Open 1-projects"]')).not.toBeNull();
  });

  /*
    The path line used to end "· team · inherited". Over every note that is the
    ordinary state of a note, and the owner removed it as clutter (2026-09-27).
    The Properties row that kept the words went the same way; see below.
  */
  test.each([390, 1440])("the line above the note says nothing about visibility (%i)", (width) => {
    const app = mountConsole(dataWith(), width);
    const properties = app.find("note-properties-open");
    expect(properties).toBeNull();
    expect(app.container.textContent).not.toContain("inherited");
    expect(app.container.textContent).not.toContain("set here");
  });
});

describe("Properties says nothing about visibility", () => {
  /**
   * The panel used to open with a `visibility` row drawn from `privacy.md`
   * ("team · inherited"). It controlled nothing and read like a setting, and
   * the owner removed it (2026-09-27): who can read a note is the Share
   * dialog's answer. A `visibility:` line inside a note decides nothing either
   * — the fixture carries `visibility: private` while the access map says
   * `team` — so the panel shows neither.
   */
  test("neither the access map's answer nor the file's own line is a row", () => {
    const app = mountConsole(dataWith());
    app.press(app.find("note-properties"));

    const text = app.find("note-properties-open")!.textContent ?? "";
    expect(text).not.toContain("visibility");
    expect(text).not.toContain("inherited");
    expect(text).not.toContain("private");
    // Every other frontmatter field is still there, untouched.
    expect(text).toContain("subject");
    expect(text).toContain("The storage binding");
  });

  test("a note with no frontmatter has no Properties row at all", () => {
    const plain = "The first paragraph of the note itself.\n";
    const editor = { ...dataWith().files.editor, baseline: plain, draft: plain };
    const app = mountConsole(dataWith({ editor }));
    expect(app.find("note-properties")).toBeNull();
  });

  test("`+ Add property` is a live control, and visibility is not a row", () => {
    const app = mountConsole(dataWith());
    app.press(app.find("note-properties"));
    const add = app.find("note-properties-add");
    expect(add).not.toBeNull();
    expect(add!.getAttribute("aria-disabled")).not.toBe("true");
    expect(app.find("note-property-visibility-value")).toBeNull();
  });
});
