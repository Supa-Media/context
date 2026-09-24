import { describe, expect, test } from "@jest/globals";
import {
  dir,
  find,
  ids,
  labels,
  menu,
  type MenuActionId,
  type MenuContext,
  type MenuItem,
  note,
  put,
} from "./fixtures";


/**
 * SHARE.
 *
 * The control that hands a note to somebody who is not in this context, so the
 * rules about when it is *absent* matter more than the one about when it shows.
 * Every case below is a case where offering it would either be a permission the
 * server refuses or an action that has no server form at all.
 */
describe("share", () => {
  test("a note offers it", () => {
    expect(ids(menu({ kind: "row", row: note("1-projects/plan.md") }))).toContain(
      "share",
    );
  });

  /**
   * Owner-only, and absent rather than disabled — the same rule as the
   * visibility submenu. An editor may write a note and may not decide who
   * outside the context reads it; `createShare` refuses them with
   * `minimum: "owner"` whatever this menu says.
   */
  test("an editor is not offered it", () => {
    const list = menu({ kind: "row", row: note("1-projects/plan.md") }, {
      canShare: false,
    });
    expect(ids(list)).not.toContain("share");
  });

  test("a read-only console is not offered it", () => {
    const list = menu({ kind: "row", row: note("1-projects/plan.md") }, {
      canEdit: false,
      canShare: false,
    });
    expect(ids(list)).not.toContain("share");
  });

  /**
   * `createShare` has no folder form: a share starts at one note and reaches
   * the notes that note links to. Offering it on a folder would be a control
   * whose only outcome is a refusal.
   */
  test("a folder is not offered it", () => {
    expect(ids(menu({ kind: "row", row: dir("1-projects") }))).not.toContain("share");
  });

  /**
   * A share is addressed to one person over one path. "Share 3 items" is three
   * separate grants with three separate links — a batch job with no dialog
   * behind it, and the same reasoning that keeps Rename and Duplicate off a
   * multi-selection.
   */
  test("a multi-selection is not offered it", () => {
    const list = menu({
      kind: "selection",
      rows: [note("1-projects/a.md"), note("1-projects/b.md")],
    });
    expect(ids(list)).not.toContain("share");
  });

  /**
   * `privacy.md` is the access map. Handing it to somebody enumerates every
   * private folder by name, and the server refuses it with
   * `PATH_NOT_SHAREABLE` — but the menu must not offer it in the first place.
   */
  test("a read-only row like privacy.md is not offered it", () => {
    const list = menu({
      kind: "row",
      row: note("privacy.md", { readOnly: true }),
    });
    expect(ids(list)).not.toContain("share");
  });

  test("it asks first — the label carries an ellipsis", () => {
    const item = menu({ kind: "row", row: note("1-projects/plan.md") }).find(
      (entry) => entry.id === "share",
    );
    expect(item?.label).toBe("Share…");
  });

  test("the background menu has nothing to share", () => {
    expect(ids(menu({ kind: "background", folder: "1-projects" }))).not.toContain(
      "share",
    );
  });
});

/* -------------------------------------------------------------------------- */
/*                     the visibility submenu says what is                    */
/* -------------------------------------------------------------------------- */

describe("the visibility submenu marks the setting that is in force", () => {
  /**
   * Two unlabelled verbs and no state was an experiment you had to run on
   * somebody's access to get the answer to.
   *
   * `team` here means named people the owner granted access to — never the
   * internet — and this submenu is where most people will actually build that
   * model, so it has to state what is true before it offers to change it. The
   * mark is `checked`, which is the state a radio group already has a
   * convention for; the *value* behind "use the folder's setting" is the one
   * fact the row cannot carry in a verb, so it goes in `detail`.
   *
   * `marker` is the whole input, and it means what `markerFor` made it mean: on
   * a file it is set exactly when the note carries an exception, and absent
   * when the note follows its folder.
   */
  test("a note following its folder has the follow item checked and neither other", () => {
    const submenu = find(menu({ kind: "row", row: note("1-projects/plan.md") }), "visibility");
    const items = submenu?.items ?? [];
    expect(find(items, "visibilityFollow")?.checked).toBe(true);
    expect(find(items, "visibilityPrivate")?.checked).toBe(false);
    expect(find(items, "visibilityTeam")?.checked).toBe(false);
  });

  test("a note held back has private checked", () => {
    const row = note("1-projects/plan.md", { marker: "private" });
    const items = find(menu({ kind: "row", row }), "visibility")?.items ?? [];
    expect(find(items, "visibilityPrivate")?.checked).toBe(true);
    expect(find(items, "visibilityFollow")?.checked).toBe(false);
  });

  test("a note shared as an exception has team checked", () => {
    const row = note("1-projects/plan.md", { marker: "team" });
    const items = find(menu({ kind: "row", row }), "visibility")?.items ?? [];
    expect(find(items, "visibilityTeam")?.checked).toBe(true);
    expect(find(items, "visibilityFollow")?.checked).toBe(false);
  });

  /**
   * A group rule is none of the three, and saying so by checking nothing is the
   * honest answer. Checking "private" because it is not `team` would be the
   * overstatement the privacy copy rules forbid — `@design` is not "yours
   * alone".
   */
  test("a note held by a group checks none of the three", () => {
    const row = note("1-projects/plan.md", { marker: "@design" });
    const items = find(menu({ kind: "row", row }), "visibility")?.items ?? [];
    for (const item of items) expect(item.checked).toBe(false);
  });

  /**
   * A folder's two items are a bulk write over its contents, not a setting the
   * folder is currently in, so there is nothing for a check to be true of.
   */
  test("a folder's bulk items are an action, not a state, so none is checked", () => {
    const items = find(menu({ kind: "row", row: dir("1-projects") }), "visibility")?.items ?? [];
    expect(items.length).toBe(2);
    for (const item of items) expect(item.checked).toBeUndefined();
  });

});

describe("what a note follows is named, because a verb cannot carry it", () => {
  /**
   * "Use the folder's setting" is the only item in this menu whose outcome is
   * invisible from the row: the other two name the value they write, and this
   * one names a value that lives somewhere else. Knowing the note follows its
   * folder without knowing what the folder *says* is not knowing who can read
   * it.
   *
   * It is supplied rather than derived. `menu.ts` cannot see the listings, so
   * a caller that does not know passes nothing and gets the check alone — the
   * menu never invents a visibility it was not told.
   */
  test("the follow item names the value and the folder it comes from", () => {
    const submenu = find(
      menu({ kind: "row", row: note("1-projects/plan.md") }, { inherited: "team" }),
      "visibility",
    );
    // The folder is named the way its own row and crumb name it, sort number
    // dropped — see `followDetail`.
    expect(find(submenu?.items ?? [], "visibilityFollow")?.detail).toBe(
      "Currently team — from projects.",
    );
  });

  test("a note at the root follows the context rather than a folder", () => {
    const submenu = find(
      menu({ kind: "row", row: note("index.md") }, { inherited: "private" }),
      "visibility",
    );
    expect(find(submenu?.items ?? [], "visibilityFollow")?.detail).toBe(
      "Currently private — from this context.",
    );
  });

  test("a group rule is named as itself", () => {
    const submenu = find(
      menu({ kind: "row", row: note("1-projects/plan.md") }, { inherited: "@design" }),
      "visibility",
    );
    expect(find(submenu?.items ?? [], "visibilityFollow")?.detail).toBe(
      "Currently @design — from projects.",
    );
  });

  /** Only the row that is true now earns the line. */
  test("a note with its own setting gets no line on the follow item", () => {
    const submenu = find(
      menu({ kind: "row", row: note("1-projects/plan.md", { marker: "private" }) }, {
        inherited: "team",
      }),
      "visibility",
    );
    for (const item of submenu?.items ?? []) expect(item.detail).toBeUndefined();
  });

  test("and a caller that supplies nothing gets no line either", () => {
    const submenu = find(menu({ kind: "row", row: note("1-projects/plan.md") }), "visibility");
    for (const item of submenu?.items ?? []) expect(item.detail).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/*                            a breadcrumb segment                            */
/* -------------------------------------------------------------------------- */

describe("a breadcrumb segment is the folder you are standing in", () => {
  /**
   * The fastest route to a parent folder's actions, and it offered none.
   *
   * What it deliberately does **not** offer is renaming, moving, archiving or
   * trashing that folder. You are inside it; a control that deletes the ground
   * under the view you are looking at is a footgun, and the tree is one click
   * away for anybody who means it.
   */
  const crumb = (folder: string, over: Partial<Omit<MenuContext, "target">> = {}) =>
    menu({ kind: "crumb", folder }, over);

  test("open it, create in it, address it, set what it shares", () => {
    expect(ids(crumb("1-projects"))).toEqual([
      "open",
      "revealInTree",
      "newNote",
      "newDrawing",
      "newFolder",
      "copyPath",
      "copyAtPath",
      "download",
      "visibility",
    ]);
  });

  test("the create items say they mean inside this folder", () => {
    expect(labels(crumb("1-projects")).slice(2, 5)).toEqual([
      "New note here",
      "New drawing here",
      "New folder here",
    ]);
  });

  test("it never offers to destroy the folder you are inside", () => {
    const list = ids(crumb("1-projects"));
    for (const id of ["rename", "moveTo", "archive", "delete", "duplicate"] as MenuActionId[]) {
      expect(list).not.toContain(id);
    }
  });

  /**
   * The root is the context itself. It has no path worth copying — `""` is not
   * an address anybody can paste — so the two address items are absent rather
   * than copying an empty string.
   */
  test("the context root creates and sets visibility but has no path to copy", () => {
    /*
      Download is the one thing the root has that is not about a path. The
      root crumb *is* the context, so this is "download everything" — which
      non-negotiable #1 names out loud, and which had nowhere to be asked for
      until this item existed.
    */
    expect(ids(crumb(""))).toEqual([
      "open",
      "revealInTree",
      "newNote",
      "newDrawing",
      "newFolder",
      "download",
      "visibility",
    ]);
  });

  test("a read-only console gets the three that change nothing", () => {
    expect(ids(crumb("1-projects", { canEdit: false }))).toEqual([
      "open",
      "revealInTree",
      "copyPath",
      "copyAtPath",
      "download",
    ]);
  });

  test("visibility is the owner's, here as everywhere", () => {
    expect(ids(crumb("1-projects", { canSetVisibility: false }))).not.toContain("visibility");
  });

  test("it gets the folder pair, not a note's three", () => {
    expect(labels(find(crumb("1-projects"), "visibility")?.items ?? [])).toEqual([
      "Make everything here private",
      "Share everything here with the team",
    ]);
  });

  test("something on the clipboard can land in it", () => {
    const list = ids(crumb("1-projects", { clipboard: put("copy", "2-areas/health.md") }));
    expect(list).toContain("paste");
  });

  test("but not the folder itself, which cannot be pasted into itself", () => {
    const list = ids(crumb("1-projects", { clipboard: put("copy", "1-projects") }));
    expect(list).not.toContain("paste");
  });
});

/**
 * DOWNLOAD IS THE ONE ITEM A READ-ONLY CONSOLE STILL GETS.
 *
 * Every other rule in `menu.ts` is "read-only means absent", and it is about
 * writes: a menu of greyed-out verbs somebody cannot perform tells them their
 * context is broken. Downloading is a read, and non-negotiable #1 says the
 * exit is "never gated, never degraded, and never behind a paywall" — so a
 * `member` in somebody else's context, and a viewer of the pinned one, get it.
 *
 * Which makes this the item most likely to be lost to a future tidy-up that
 * folds it in with the rest, so it is asserted from the read-only side first.
 */
describe("download", () => {
  const ids = (items: MenuItem[]): string[] =>
    items.flatMap((item) => [item.id, ...(item.items ?? []).map((child) => child.id)]);

  test("a read-only console can still download a note", () => {
    const items = menu(
      { kind: "row", row: note("1-projects/plan.md") },
      { canEdit: false, canSetVisibility: false, canShare: false },
    );
    expect(ids(items)).toContain("download");
    // ...and still gets none of the verbs that write.
    expect(ids(items)).not.toContain("rename");
    expect(ids(items)).not.toContain("delete");
  });

  test("a folder says it comes as an archive, because that is a different file", () => {
    const items = menu({ kind: "row", row: dir("1-projects") });
    const label = items
      .find((item) => item.id === "download")?.label;
    expect(label).toBe("Download folder (.zip)");
  });

  test("a note says nothing extra", () => {
    const items = menu({ kind: "row", row: note("1-projects/plan.md") });
    expect(items.find((item) => item.id === "download")?.label).toBe("Download");
  });

  test("a surface with no bucket behind it does not offer it", () => {
    // The landing page's demo console, whose browser methods are no-ops. A
    // Download there is a row that silently does nothing, which this menu's
    // own header names as the harder failure to notice.
    const items = menu({ kind: "row", row: note("1-projects/plan.md") }, { canDownload: false });
    expect(ids(items)).not.toContain("download");
  });

  test("a multi-row selection is not offered it", () => {
    /*
      Three downloads is three files landing in somebody's folder with no
      ordering and no way to tell which press produced which. One archive of a
      selection is a real feature and a different one, so this is omitted
      rather than offered as a loop — the same rule Rename and Duplicate follow.
    */
    const items = menu({
      kind: "selection",
      rows: [note("1-projects/a.md"), note("1-projects/b.md")],
    });
    expect(ids(items)).not.toContain("download");
  });

  test("the background is not a row, so there is nothing to download", () => {
    const items = menu({ kind: "background", folder: "1-projects" });
    expect(ids(items)).not.toContain("download");
  });
});
