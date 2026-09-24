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

    // The band says where you are, including the last segment...
    expect(app.find("breadcrumb-leaf")).not.toBeNull();
    // ...and it is not pressable: pressing it would re-select what is open.
    expect(app.container.querySelector(`[aria-label="Open ${NOTE}"]`)).toBeNull();
    // …and the visibility chip stayed gone: a note carries it as a Properties
    // row, which is fuller than the crumb's brief version.
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
});

describe("visibility survives into Properties", () => {
  /**
   * The chip the breadcrumb carried was a **claim about who can read this
   * note**. Moving the row it lived in must not lose it.
   */
  test("the access map's answer is a property of the note", () => {
    const app = mountConsole(dataWith());
    app.press(app.find("note-properties"));

    const open = app.find("note-properties-open");
    expect(open).not.toBeNull();
    expect(open!.textContent).toContain("visibility");
    // The same three-case wording the breadcrumb printed, from the same
    // function: a note that merely follows a `team` folder and one deliberately
    // shared as an exception have to stay distinguishable.
    expect(open!.textContent).toContain("team · inherited");
  });

  test("a note that sets its own says so, rather than saying it inherits", () => {
    const app = mountConsole(
      dataWith({}, { visibility: "team", inherited: "private", exception: true }),
    );
    app.press(app.find("note-properties"));
    expect(app.find("note-properties-open")!.textContent).toContain("team · set here");
  });

  /**
   * A `visibility:` line inside a note decides nothing — `privacy.md` decides
   * access, which is what `ManifestNotice` says in so many words. The fixture
   * carries `visibility: private` in its frontmatter while the access map says
   * `team`, and the panel must state one answer, not two.
   */
  test("the file's own visibility line is replaced, not shown beside it", () => {
    const app = mountConsole(dataWith());
    app.press(app.find("note-properties"));

    const text = app.find("note-properties-open")!.textContent ?? "";
    expect(text).toContain("team · inherited");
    expect(text).not.toContain("private");
    // Every other frontmatter field is still there, untouched.
    expect(text).toContain("subject");
    expect(text).toContain("The storage binding");
  });

  test("`+ Add property` is still drawn, and still inert", () => {
    const app = mountConsole(dataWith());
    app.press(app.find("note-properties"));
    const add = app.find("note-properties-add");
    expect(add).not.toBeNull();
    expect(add!.getAttribute("aria-disabled")).toBe("true");
  });
});
