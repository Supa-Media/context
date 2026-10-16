import { describe, expect, test } from "@jest/globals";
import {
  barShare,
  cleanupButtons,
  cleanupSummary,
  deleteLabel,
  countsLine,
  diagnosisLine,
  failureLines,
  formatPercent,
  handleLabel,
  isFailing,
  keysLabel,
  keysNote,
  keysSwitch,
  keyedLine,
  modeLabel,
  nextMode,
  needsLookLines,
  pauseLabel,
  sharedIdsLine,
  percentOf,
  sortWorkspaces,
  statusLabel,
  switchLabel,
  switchNote,
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

describe("percent copied", () => {
  test("is null when there are no files, and the card shows a dash", () => {
    expect(percentOf(0, 0)).toBeNull();
    expect(formatPercent(0, 0)).toBe("—");
    expect(barShare(0, 0)).toBe(0);
  });

  test("reads one decimal, floored", () => {
    expect(formatPercent(1, 3)).toBe("33.3%");
    expect(formatPercent(2, 3)).toBe("66.6%");
    expect(formatPercent(29, 100)).toBe("29.0%");
    expect(formatPercent(7, 10)).toBe("70.0%");
  });

  test("never reads 100.0% while a note is left", () => {
    expect(formatPercent(9_999, 10_000)).toBe("99.9%");
    expect(formatPercent(12_499, 12_500)).toBe("99.9%");
    expect(formatPercent(12_500, 12_500)).toBe("100.0%");
  });

  test("clamps copied to the files, and to zero below", () => {
    expect(formatPercent(150, 100)).toBe("100.0%");
    expect(formatPercent(-4, 100)).toBe("0.0%");
    expect(percentOf(150, 100)).toBe(100);
    expect(barShare(150, 100)).toBe(1);
  });

  test("the bar's fill is the share, 0 to 1", () => {
    expect(barShare(1, 4)).toBe(0.25);
    expect(barShare(0, 4)).toBe(0);
  });
});

describe("counts line", () => {
  test("says how many of how many, with the failures only when there are some", () => {
    const totals = { liveFiles: 0, keyed: 0 };
    expect(countsLine({ files: 12_500, copied: 12_034, failed: 3, ...totals })).toBe("12,034 of 12,500 files copied · 3 failed");
    expect(countsLine({ files: 12_500, copied: 12_500, failed: 0, ...totals })).toBe("12,500 of 12,500 files copied");
  });
});

describe("row order", () => {
  test("failed first, then the lowest percent copied", () => {
    const rows = sortWorkspaces([
      row({ workspaceId: "a", handle: "alpha", copied: 90 }),
      row({ workspaceId: "b", handle: "beta", copied: 10 }),
      row({ workspaceId: "c", handle: "gamma", copied: 50, failed: 2 }),
      row({ workspaceId: "d", handle: "delta", copied: 5, status: "failed", error: "Listing failed" }),
    ]);
    expect(rows.map((entry) => entry.workspaceId)).toEqual(["d", "c", "b", "a"]);
  });

  test("a workspace with no files has no percent and sorts after the ones that do", () => {
    const rows = sortWorkspaces([
      row({ workspaceId: "empty", handle: "empty", files: 0, copied: 0 }),
      row({ workspaceId: "half", handle: "half", copied: 50 }),
    ]);
    expect(rows.map((entry) => entry.workspaceId)).toEqual(["half", "empty"]);
  });

  test("ties go by handle, then by id, so the order holds between refreshes", () => {
    const rows = sortWorkspaces([
      row({ workspaceId: "w2", handle: "maya" }),
      row({ workspaceId: "w1", handle: "maya" }),
      row({ workspaceId: "w3", handle: null }),
      row({ workspaceId: "w0", handle: "amy" }),
    ]);
    expect(rows.map((entry) => entry.workspaceId)).toEqual(["w0", "w1", "w2", "w3"]);
  });

  test("does not reorder the array it was given", () => {
    const input = [row({ workspaceId: "a", copied: 90 }), row({ workspaceId: "b", copied: 10 })];
    sortWorkspaces(input);
    expect(input.map((entry) => entry.workspaceId)).toEqual(["a", "b"]);
  });

  test("a row is failing when files failed or its copy said so", () => {
    expect(isFailing(row({ workspaceId: "a", failed: 1 }))).toBe(true);
    expect(isFailing(row({ workspaceId: "b", status: "failed" }))).toBe(true);
    expect(isFailing(row({ workspaceId: "c", status: "copying", copied: 40 }))).toBe(false);
  });
});

describe("status words", () => {
  test("each status reads in words", () => {
    expect(statusLabel(row({ workspaceId: "a", status: "idle" }))).toBe("Not started");
    expect(statusLabel(row({ workspaceId: "a", status: "copying" }))).toBe("Copying");
    expect(statusLabel(row({ workspaceId: "a", status: "done" }))).toBe("Copied");
  });

  test("a failed copy says why", () => {
    expect(statusLabel(row({ workspaceId: "a", status: "failed", error: "Bucket refused the write" }))).toBe(
      "Failed: Bucket refused the write",
    );
  });

  test("a failure with no reason still says it failed", () => {
    expect(statusLabel(row({ workspaceId: "a", status: "failed" }))).toBe("Failed");
    expect(statusLabel(row({ workspaceId: "a", status: "failed", error: "  " }))).toBe("Failed");
  });
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

describe("failure lines", () => {
  test("say which note failed and why, in words", () => {
    expect(failureLines([{ noteId: "3f2a9c1b-0000-4000-8000-000000000000", reason: "too_large" }])).toEqual([
      "Note 3f2a9c1b: too big to copy",
    ]);
  });

  test("an unknown reason is shown as it is, and none means no lines", () => {
    expect(failureLines([{ noteId: "abcdef12", reason: "new_reason" }])).toEqual(["Note abcdef12: new_reason"]);
    expect(failureLines(undefined)).toEqual([]);
  });
});

describe("labels", () => {
  test("a handle shows with its @, and a workspace without one says so", () => {
    expect(handleLabel("maya")).toBe("@maya");
    expect(handleLabel("@maya")).toBe("@maya");
    expect(handleLabel(null)).toBe("(no handle)");
    expect(handleLabel("  ")).toBe("(no handle)");
  });

  test("the toggle says what pressing it does", () => {
    expect(pauseLabel(false)).toBe("Pause");
    expect(pauseLabel(true)).toBe("Resume");
  });
});

describe("keys mode", () => {
  test("says how many live files are on notes/ only, in plain words", () => {
    expect(keyedLine(12, 40)).toBe("12 of 40 on notes/ only");
    expect(keyedLine(0, 0)).toBe("0 of 0 on notes/ only");
    expect(keyedLine(1_200, 12_500)).toBe("1,200 of 12,500 on notes/ only");
  });

  test("reads from notes/ only, and has no switch back: the mode stays keys", () => {
    expect(modeLabel("keys")).toBe("Reading from notes/ only");
    expect(nextMode("keys")).toBe("keys");
    expect(switchLabel("keys")).toBe("Reads come from notes/ only");
    expect(switchNote("keys")).toMatch(/no switch back/);
  });
});

describe("the read switch", () => {
  test("says in plain words which keys reads use now", () => {
    expect(modeLabel("paths")).toBe("Reading from paths");
    expect(modeLabel("ids")).toBe("Reading from notes/");
  });

  test("the button names the mode it switches to", () => {
    expect(switchLabel("paths")).toBe("Switch to notes/");
    expect(switchLabel("ids")).toBe("Switch back to paths");
    expect(nextMode("paths")).toBe("ids");
    expect(nextMode("ids")).toBe("paths");
  });

  test("the confirm says what reads will use, that saves go to both, and that a switch back loses nothing", () => {
    const toIds = switchNote("paths");
    expect(toIds).toMatch(/notes\//);
    expect(toIds).toMatch(/both/);
    expect(toIds).toMatch(/switch back/i);
    expect(toIds).toMatch(/until its copy catches up/);
    expect(switchNote("ids")).toMatch(/paths again/);
    expect(switchNote("ids")).toMatch(/Nothing is deleted/);
  });
});

describe("make notes/ the only copy", () => {
  const copied = (id: string, fields: Partial<NoteIdsWorkspace> = {}) =>
    row({ workspaceId: id, files: 10, copied: 10, status: "done", ...fields });

  test("is offered in ids mode only", () => {
    expect(keysSwitch("paths", [copied("a")]).shown).toBe(false);
    expect(keysSwitch("keys", [copied("a")]).shown).toBe(false);
    expect(keysSwitch("ids", [copied("a")]).shown).toBe(true);
  });

  test("is enabled once every live workspace is fully copied", () => {
    expect(keysSwitch("ids", [copied("a"), copied("b")])).toEqual({ shown: true, enabled: true, reason: null });
  });

  test("is disabled, with a plain reason, while a workspace is not fully copied", () => {
    const pending = keysSwitch("ids", [copied("a"), row({ workspaceId: "b", files: 10, copied: 4, status: "copying" })]);
    expect(pending).toEqual({ shown: true, enabled: false, reason: "1 workspace is not fully copied yet." });
    const several = keysSwitch("ids", [
      row({ workspaceId: "a", files: 3 }),
      row({ workspaceId: "b", files: 3, status: "failed", error: "x" }),
    ]);
    expect(several.enabled).toBe(false);
    expect(several.reason).toBe("2 workspaces are not fully copied yet.");
  });

  test("a failed file keeps it disabled even when every file is copied", () => {
    expect(keysSwitch("ids", [copied("a", { failed: 1 })]).enabled).toBe(false);
  });

  test("a copy that is done but short is not ready", () => {
    expect(keysSwitch("ids", [copied("a", { copied: 9 })]).enabled).toBe(false);
  });

  test("an archived workspace does not hold the switch back", () => {
    const archived = row({ workspaceId: "old", files: 10, copied: 0, archived: true });
    expect(keysSwitch("ids", [copied("a"), archived]).enabled).toBe(true);
  });

  test("the button and the confirm say what they do, in plain words", () => {
    expect(keysLabel()).toBe("Make notes/ the only copy");
    const note = keysNote();
    expect(note).toMatch(/only under notes\//);
    expect(note).toMatch(/names live only in Context/);
    expect(note).toMatch(/cannot be switched back/);
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
