import { describe, expect, test } from "@jest/globals";
import {
  barShare,
  countsLine,
  diagnosisLine,
  formatPercent,
  handleLabel,
  isFailing,
  modeLabel,
  nextMode,
  pauseLabel,
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
    expect(countsLine({ files: 12_500, copied: 12_034, failed: 3 })).toBe("12,034 of 12,500 files copied · 3 failed");
    expect(countsLine({ files: 12_500, copied: 12_500, failed: 0 })).toBe("12,500 of 12,500 files copied");
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
