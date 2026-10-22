import { describe, expect, test } from "@jest/globals";
import {
  cleanupButtons,
  cleanupSummary,
  deleteLabel,
  diagnosisLine,
  handleLabel,
  needsLookLines,
  sharedIdsLine,
  type NoteIdsWorkspace,
} from "../features/admin/noteIds";

/**
 * The "Notes by id" card's pure helper (`features/admin/noteIds.ts`): the
 * percent and the bar, the counts line, the order of the workspace rows, and
 * the words for a status and a diagnosis. The rules worth a red test: a
 * percent never reads 100.0% while a note is left, no files reads as a dash
 * rather than a divide-by-zero, failures come first, and a failed copy says
 * why.
 */

const row = (fields: Partial<NoteIdsWorkspace> & { workspaceId: string }): NoteIdsWorkspace => ({
  handle: null,
  files: 100,
  copied: 0,
  failed: 0,
  status: "idle",
  error: null,
  diagnosis: null,
  liveFiles: 0,
  keyed: 0,
  keyedAt: null,
  keyedDoneAt: null,
  archived: false,
  ...fields,
});

describe("diagnosis line", () => {
  test("counts what was checked, missing and differing", () => {
    expect(diagnosisLine({ checkedAt: 1, checked: 120, missing: 0, differs: 1 })).toBe(
      "Checked 120 · 0 missing · 1 differs",
    );
  });

  test("is absent until the workspace has been checked", () => {
    expect(diagnosisLine(undefined)).toBeNull();
  });
});

describe("labels", () => {
  test("a handle shows with its @, and a workspace without one says so", () => {
    expect(handleLabel("maya")).toBe("@maya");
    expect(handleLabel("@maya")).toBe("@maya");
    expect(handleLabel(null)).toBe("(no handle)");
    expect(handleLabel("  ")).toBe("(no handle)");
  });

});

describe("old copies: the count and the delete", () => {
  const base = {
    running: null,
    countedAt: null,
    toDelete: 0,
    unclaimed: 0,
    readingPaths: 0,
    startedAt: null,
    finishedAt: null,
    deleted: 0,
    failed: [],
    error: null,
    countBlocked: null,
    deleteBlocked: { code: "CLEANUP_NOT_COUNTED", message: "Count the old copies first." },
  };

  test("says it was never counted, and what the count found once it was", () => {
    expect(cleanupSummary(base)).toEqual(["Not counted yet."]);
    expect(cleanupSummary({ ...base, countedAt: 1, toDelete: 1234, unclaimed: 12, readingPaths: 0 })).toEqual([
      "Counted: 1,234 old copies to delete · 12 that no note names · 0 notes still read from a path",
    ]);
  });

  test("says what is running, and what a finished delete did, failures included", () => {
    expect(cleanupSummary({ ...base, running: "count" })).toEqual(["Counting old copies…"]);
    expect(cleanupSummary({ ...base, running: "delete", deleted: 40 })).toEqual(["Deleting old copies… 40 deleted so far"]);
    expect(cleanupSummary({ ...base, finishedAt: 2, deleted: 5, failed: [{ reason: "delete_failed", count: 2 }] })).toEqual([
      "Deleted 5 old copies · 2 could not be deleted: the delete failed",
    ]);
  });

  test("shows a fixed error label as it is", () => {
    expect(cleanupSummary({ ...base, error: "Deleting old copies failed; start it again" })).toContain(
      "Deleting old copies failed; start it again",
    );
  });

  test("the delete is one-way: its words say so, and it is offered only when no gate refuses", () => {
    expect(deleteLabel()).toBe("Delete old copies — can't be undone");
    expect(cleanupButtons(base)).toEqual({
      count: { enabled: true, reason: null },
      delete: { enabled: false, reason: "Count the old copies first." },
    });
    const counted = { ...base, countedAt: 1, deleteBlocked: null };
    expect(
      cleanupButtons({ ...counted, deleteBlocked: { code: "CLEANUP_WAITING", message: "Waits until 7 days after the switch: 3 days left" } })
        .delete,
    ).toEqual({ enabled: false, reason: "Waits until 7 days after the switch: 3 days left" });
    expect(cleanupButtons(counted).delete).toEqual({ enabled: true, reason: null });
  });

  test("neither button is offered while a run is going", () => {
    const buttons = cleanupButtons({ ...base, running: "delete", countedAt: 1 });
    expect(buttons.count.enabled).toBe(false);
    expect(buttons.delete.enabled).toBe(false);
  });

  test("a count refusal shows on the count button", () => {
    expect(cleanupButtons({ ...base, countBlocked: { code: "NOTE_IDS_PAUSED", message: "The id copy is paused. Resume it first." } }).count).toEqual({
      enabled: false,
      reason: "The id copy is paused. Resume it first.",
    });
  });
});

describe("shared ids: the words for the check and the fix", () => {
  test("the count line says how many notes share an id, in plain words", () => {
    expect(sharedIdsLine(0)).toBe("No notes share an id with another note");
    expect(sharedIdsLine(2)).toBe("2 notes share an id with another note");
    expect(sharedIdsLine(1234)).toBe("1,234 notes share an id with another note");
  });

  test("a group that needs a look says it was left as it is, and lists every path in it", () => {
    const lines = needsLookLines(["notes/keep.md", "notes/keyed.md"]);
    expect(lines.heading).toMatch(/share an id/);
    expect(lines.heading).toMatch(/left as they are/);
    expect(lines.paths).toEqual(["notes/keep.md", "notes/keyed.md"]);
  });
});
