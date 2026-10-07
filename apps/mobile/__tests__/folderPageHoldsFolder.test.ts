/**
 * Whether a project page has every note it draws.
 *
 * Reported 2026-10-07: the @supa Projects List said "This device is still
 * fetching some notes" for good, because the page reads the whole workspace
 * (a root folder's parent is the root) and saved sessions in `0-inbox/` were
 * never all downloaded. Judging by the read's own `complete` fails "a sibling
 * folder's missing notes are not this page's".
 */
import { describe, expect, test } from "@jest/globals";
import { holdsFolder } from "../features/console/files/folderPage/useFolderPage";

const read = (missing: readonly string[] | undefined) => ({ notes: [], complete: false, ...(missing ? { missing } : {}) });

describe("whether a folder page holds its notes", () => {
  test("a sibling folder's missing notes are not this page's", () => {
    expect(holdsFolder(read(["0-inbox/sessions/s1.md", "2-products/x/y.md"]), "1-projects")).toBe(true);
  });

  test("a missing note under the folder is", () => {
    expect(holdsFolder(read(["1-projects/context-agent/overview.md"]), "1-projects")).toBe(false);
  });

  test("a missing front note above it is, since a status list is inherited from there", () => {
    expect(holdsFolder(read(["1-projects/README.md"]), "1-projects/context-agent")).toBe(false);
    expect(holdsFolder(read(["index.md"]), "1-projects")).toBe(false);
  });

  test("a partial listing is never whole, and a whole read always is", () => {
    expect(holdsFolder(read(undefined), "1-projects")).toBe(false);
    expect(holdsFolder({ notes: [], complete: true }, "1-projects")).toBe(true);
  });

  test("a folder whose name merely starts the same is a sibling", () => {
    expect(holdsFolder(read(["1-projects-old/a.md"]), "1-projects")).toBe(true);
  });
});
