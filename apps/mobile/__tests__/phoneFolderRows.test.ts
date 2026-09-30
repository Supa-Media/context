import { describe, expect, test } from "@jest/globals";
import { phoneRows, phoneSections } from "../features/console/home/folderRows";
import type { HomeNote } from "../features/console/home/homeModel";
import type { FileEntry } from "../features/console/files/types";

/**
 * A phone's folder page reads the way Home does (board 07 of the approved
 * Home artboards, 2026-09-30): subfolders with what they hold, notes with when
 * they changed and their first line, folders before notes, pinned on top.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. Folder counts taken from the folder's own level only.    → "a subfolder says what it holds, all the way down"
 *  2. Pinned rows left in listing order.                        → "pinned rows go on top of their section"
 *  3. A note's date read only from the listing, not the copy.   → "a note says when it changed and its first line"
 */

const NOW = new Date(2026, 8, 30, 15, 0).getTime();

function file(path: string, updatedAt?: number): FileEntry {
  return {
    kind: "file",
    path,
    name: path.split("/").pop()!,
    visibility: "private",
    inherited: "private",
    exception: false,
    readOnly: false,
    ...(updatedAt === undefined ? {} : { updatedAt }),
  };
}

function folder(path: string): FileEntry {
  return { ...file(path), kind: "folder" };
}

function note(path: string, overrides: Partial<HomeNote> = {}): HomeNote {
  return { path, title: path, lede: null, tags: [], ...overrides };
}

const notes = [
  note("clients/acme/brief.md", { updatedAt: new Date(2026, 8, 30, 10, 12).getTime(), lede: "Agreed rate for the pilot" }),
  note("clients/acme/calls/kickoff.md"),
  note("clients/rate-card.md", { updatedAt: new Date(2026, 8, 28, 9).getTime(), lede: "Day rate goes up in January" }),
  note("clients-old/x.md"),
];
const folders = ["clients", "clients/acme", "clients/acme/calls", "clients/bloom", "clients-old"];

describe("phoneRows", () => {
  test("a subfolder says what it holds, all the way down", () => {
    const meta = phoneRows({ notes, folders, pins: [], now: NOW });
    expect(meta(folder("clients/acme"))).toEqual({ meta: "2 notes · 1 folder", sub: null, pinned: false });
    expect(meta(folder("clients/bloom")).meta).toBe("Empty");
  });

  test("a note says when it changed and its first line", () => {
    const meta = phoneRows({ notes, folders, pins: [], now: NOW });
    expect(meta(file("clients/acme/brief.md"))).toEqual({
      meta: "10:12",
      sub: "Agreed rate for the pilot",
      pinned: false,
    });
    // The device's copy knows the date where the listing does not.
    expect(meta(file("clients/rate-card.md")).meta).toBe("Mon");
  });

  test("a note the copy does not know yet falls back to the listing, and says nothing when neither knows", () => {
    const meta = phoneRows({ notes: [], folders: [], pins: [], now: NOW });
    expect(meta(file("clients/new.md", new Date(2026, 8, 30, 9, 5).getTime())).meta).toBe("9:05");
    expect(meta(file("clients/new.md"))).toEqual({ meta: null, sub: null, pinned: false });
  });
});

describe("phoneSections", () => {
  test("folders come before notes, whatever the listing's order", () => {
    const meta = phoneRows({ notes, folders, pins: [], now: NOW });
    const rows = [file("clients/rate-card.md"), folder("clients/acme"), file("clients/b.md"), folder("clients/bloom")];
    const sections = phoneSections(rows, meta);
    expect(sections.folders.map((row) => row.path)).toEqual(["clients/acme", "clients/bloom"]);
    expect(sections.notes.map((row) => row.path)).toEqual(["clients/rate-card.md", "clients/b.md"]);
  });

  test("pinned rows go on top of their section, and the rest keep the listing's order", () => {
    const meta = phoneRows({
      notes,
      folders,
      pins: [
        { path: "clients/b.md", kind: "note" },
        { path: "clients/bloom", kind: "folder" },
      ],
      now: NOW,
    });
    const rows = [folder("clients/acme"), folder("clients/bloom"), file("clients/a.md"), file("clients/b.md"), file("clients/c.md")];
    const sections = phoneSections(rows, meta);
    expect(sections.folders.map((row) => row.path)).toEqual(["clients/bloom", "clients/acme"]);
    expect(sections.notes.map((row) => row.path)).toEqual(["clients/b.md", "clients/a.md", "clients/c.md"]);
    expect(meta(file("clients/b.md")).pinned).toBe(true);
  });
});
