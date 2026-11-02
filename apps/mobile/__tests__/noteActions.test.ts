/**
 * The phone's ••• sheet: which of the note's actions each person is offered.
 *
 * Owner-approved on 2026-09-27 (the phone artboards, screen 7). The rows are
 * existing operations only — Share…, Rename, Move to…, Copy link, Move to
 * archive — and a visitor sees exactly what they are permitted: renaming and
 * moving inside their own tab, and copying the page's link. The rendered sheet
 * and its presses are `noteChrome/topRowGroup.test.ts`.
 *
 * SABOTAGE: drop the `!visitor` guard on Share in `noteActionItems`. "a
 * visitor gets rename, move and Copy link — nothing else" fails.
 */

import { describe, expect, test } from "@jest/globals";
import { noteActionItems } from "../features/console/layout/noteActions";
import type { FileEntry } from "../features/console/files/types";

const note = (over: Partial<FileEntry> = {}): FileEntry => ({
  kind: "file",
  path: "2-areas/weekly-review.md",
  name: "weekly-review.md",
  visibility: "team",
  inherited: "team",
  exception: false,
  readOnly: false,
  ...over,
});

const ids = (items: { id: string }[]) => items.map((item) => item.id);

describe("the note actions sheet", () => {
  test("an owner gets the artboard's rows, in its order", () => {
    const items = noteActionItems({ entry: note(), canEdit: true, canShare: true, visitor: false });
    expect(ids(items)).toEqual(["share", "rename", "moveTo", "addProperty", "copyLink", "archive"]);
    expect(items.map((item) => item.label)).toEqual([
      "Share…",
      "Rename",
      "Move to…",
      "Add property",
      "Copy link",
      "Move to archive",
    ]);
    // The one row that takes the note away is drawn as such, apart.
    const archive = items.find((item) => item.id === "archive")!;
    expect(archive.danger).toBe(true);
    expect(archive.separatorBefore).toBe(true);
  });

  test("a visitor gets rename, move and Copy link — nothing else", () => {
    const items = noteActionItems({ entry: note(), canEdit: true, canShare: false, visitor: true });
    expect(ids(items)).toEqual(["rename", "moveTo", "copyLink"]);
  });

  test("…even if the browser behind them reported it could share", () => {
    // A visitor has no workspace to share into, whatever `canShare` says.
    const items = noteActionItems({ entry: note(), canEdit: true, canShare: true, visitor: true });
    expect(ids(items)).not.toContain("share");
    expect(ids(items)).not.toContain("archive");
  });

  test("an editor who is not the owner is offered no Share and no team link", () => {
    const items = noteActionItems({ entry: note(), canEdit: true, canShare: false, visitor: false });
    expect(ids(items)).toEqual(["rename", "moveTo", "addProperty", "archive"]);
  });

  test("Add property is for a note somebody may change, and not a website page or privacy.md", () => {
    // The way in for a loose note, which draws no chips on a phone (owner, 2026-10-18, board A of `loose-note-chips`).
    expect(ids(noteActionItems({ entry: note(), canEdit: false, canShare: false, visitor: false }))).not.toContain("addProperty");
    expect(ids(noteActionItems({ entry: note({ path: "website/about.md", name: "about.md" }), canEdit: true, canShare: true, visitor: false }))).not.toContain("addProperty");
    expect(ids(noteActionItems({ entry: note({ path: "2-areas/privacy.md", name: "privacy.md" }), canEdit: true, canShare: true, visitor: false }))).not.toContain("addProperty");
    expect(ids(noteActionItems({ entry: note({ path: "2-areas/sketch.excalidraw.png", name: "sketch.excalidraw.png" }), canEdit: true, canShare: true, visitor: false }))).not.toContain("addProperty");
  });

  test("a reader is offered nothing to change", () => {
    const items = noteActionItems({ entry: note(), canEdit: false, canShare: false, visitor: false });
    expect(items).toEqual([]);
  });

  test("a read-only note — privacy.md — offers no Share and nothing that writes", () => {
    const items = noteActionItems({
      entry: note({ path: "privacy.md", name: "privacy.md", readOnly: true }),
      canEdit: true,
      canShare: true,
      visitor: false,
    });
    expect(ids(items)).toEqual(["copyLink"]);
  });

  test("an archived note offers Restore rather than archiving it again", () => {
    const items = noteActionItems({
      entry: note({ path: "4-archive/2-areas/weekly-review.md" }),
      canEdit: true,
      canShare: true,
      visitor: false,
    });
    expect(ids(items)).toContain("restore");
    expect(ids(items)).not.toContain("archive");
  });

  /*
    Reading mode moved here from the top bar's eye (owner, 2026-10-13). It is
    the first row whenever the caller says how the note is shown, for anybody
    who can open the note, and it never reaches the note bar, which asks
    without `reading`.
  */
  test("reading mode leads the sheet, for anybody, named as the act", () => {
    const owner = noteActionItems({ entry: note(), canEdit: true, canShare: true, visitor: false, reading: false });
    expect(ids(owner)[0]).toBe("read");
    expect(owner[0]!.label).toBe("Read this note");
    const reader = noteActionItems({ entry: note(), canEdit: false, canShare: false, visitor: false, reading: true });
    expect(ids(reader)).toEqual(["read"]);
    expect(reader[0]!.label).toBe("Edit this note");
  });

  test("...and is absent when the caller does not ask, and on a folder", () => {
    expect(ids(noteActionItems({ entry: note(), canEdit: true, canShare: true, visitor: false }))).not.toContain(
      "read",
    );
    const folder = note({ kind: "folder", path: "2-areas", name: "2-areas" });
    expect(
      ids(noteActionItems({ entry: folder, canEdit: true, canShare: true, visitor: false, reading: false })),
    ).not.toContain("read");
  });

  /*
    A page opens as nothing but the page (owner, 2026-10-27: "no properties,
    no floating buttons, nothing but the page please, maybe 1 menu"). Its
    Page | Text switch moved into this sheet; Add property has no use there.
    SABOTAGE: drop the `page` branch in `noteActionItems` and this fails.
  */
  test("a page swaps reading mode for Edit as text, and drops Add property", () => {
    const page = note({ path: "1-projects/concert/plan.page.md", name: "plan.page.md" });
    const shown = noteActionItems({ entry: page, canEdit: true, canShare: true, visitor: false, reading: false, pageAsText: false });
    expect(ids(shown)).toEqual(["pageText", "share", "rename", "moveTo", "copyLink", "archive"]);
    expect(shown[0]!.label).toBe("Edit as text");
    const asText = noteActionItems({ entry: page, canEdit: true, canShare: true, visitor: false, reading: false, pageAsText: true });
    expect(asText[0]!.label).toBe("View as page");
  });
});
