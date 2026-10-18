/**
 * The governing row is the row whose setting decides a path: the same walk
 * `canSee` makes (exact note row first, else the longest folder prefix), but
 * returning the row, so the edit name can be read off it.
 *
 * Sabotage: make `governingRowOf` match folders by plain string prefix
 * (`path.startsWith(row.path)`) and the "sibling named like a folder" case
 * fails; make it ignore note rows and "a note's own list governs" fails.
 */

import { describe, expect, test } from "vitest";
import type { AccessRow, Caller } from "../../functions/lib/nodes/rowAccess";
import { canEditPath, governingRowOf } from "../../functions/lib/nodes/governingRow";

const ROOT_FOLDER = "00000000-0000-7000-8000-000000000011";
const SUB_FOLDER = "00000000-0000-7000-8000-000000000012";
const PRIVATE_FOLDER = "00000000-0000-7000-8000-000000000013";
const NOTE_OWN_LIST = "00000000-0000-7000-8000-000000000014";
const NOTE_PRIVATE = "00000000-0000-7000-8000-000000000015";
const LOOKALIKE = "00000000-0000-7000-8000-000000000016";

const ANA: Caller = { userId: "user-ana" };
const KOLA: Caller = { userId: "user-kola" };

function folder(path: string, noteId: string, extra: Partial<AccessRow> = {}): AccessRow {
  return { path, noteId, kind: "folder", grantees: [], ...extra };
}
function note(path: string, noteId: string, extra: Partial<AccessRow> = {}): AccessRow {
  return { path, noteId, kind: "file", grantees: [], ...extra };
}

describe("the governing row is the nearest one that sets access", () => {
  test("a note's own list governs over the folder it sits in", () => {
    const rows = [
      folder("hr", ROOT_FOLDER, { base: "private", grantees: [{ kind: "user", id: "user-ana", role: "edit" }] }),
      note("hr/pay.md", NOTE_OWN_LIST, { grantees: [{ kind: "user", id: "user-kola", role: "view" }] }),
    ];
    expect(governingRowOf(rows, "hr/pay.md")?.noteId).toBe(NOTE_OWN_LIST);
    expect(canEditPath(rows, ANA, "hr/pay.md")).toBe(false);
  });

  test("a folder's edit grant governs a note inside it that has no row", () => {
    const rows = [folder("hr", ROOT_FOLDER, { base: "private", grantees: [{ kind: "user", id: "user-ana", role: "edit" }] })];
    expect(governingRowOf(rows, "hr/new.md")?.noteId).toBe(ROOT_FOLDER);
    expect(canEditPath(rows, ANA, "hr/new.md")).toBe(true);
  });

  test("an absent subfolder inherits from the folder above it", () => {
    const rows = [folder("hr", ROOT_FOLDER, { base: "private", grantees: [{ kind: "user", id: "user-ana", role: "edit" }] })];
    expect(canEditPath(rows, ANA, "hr/deep/er/x.md")).toBe(true);
  });

  test("a row with neither base nor list is absent and is skipped", () => {
    const rows = [
      folder("hr", ROOT_FOLDER, { base: "private", grantees: [{ kind: "user", id: "user-ana", role: "edit" }] }),
      folder("hr/empty", SUB_FOLDER),
    ];
    expect(governingRowOf(rows, "hr/empty/x.md")?.noteId).toBe(ROOT_FOLDER);
    expect(canEditPath(rows, ANA, "hr/empty/x.md")).toBe(true);
  });

  test("a private subfolder with no list is the governing row and refuses the edit", () => {
    const rows = [
      folder("hr", ROOT_FOLDER, { base: "private", grantees: [{ kind: "user", id: "user-ana", role: "edit" }] }),
      folder("hr/private", PRIVATE_FOLDER, { base: "private" }),
    ];
    expect(governingRowOf(rows, "hr/private/x.md")?.noteId).toBe(PRIVATE_FOLDER);
    expect(canEditPath(rows, ANA, "hr/private/x.md")).toBe(false);
  });

  test("the nearest folder wins over an ancestor that also lists the caller", () => {
    const rows = [
      folder("hr", ROOT_FOLDER, { base: "private", grantees: [{ kind: "user", id: "user-ana", role: "edit" }] }),
      folder("hr/clients", SUB_FOLDER, { base: "private", grantees: [{ kind: "user", id: "user-kola", role: "edit" }] }),
    ];
    expect(governingRowOf(rows, "hr/clients/x.md")?.noteId).toBe(SUB_FOLDER);
    expect(canEditPath(rows, ANA, "hr/clients/x.md")).toBe(false);
    expect(canEditPath(rows, KOLA, "hr/clients/x.md")).toBe(true);
  });

  test("a folder governs only paths under it, never a sibling that shares its leading characters", () => {
    const rows = [folder("ab", ROOT_FOLDER, { base: "private", grantees: [{ kind: "user", id: "user-ana", role: "edit" }] })];
    expect(governingRowOf(rows, "abc.md")).toBeNull();
    expect(canEditPath(rows, ANA, "abc.md")).toBe(false);
    expect(canEditPath(rows, ANA, "ab/x.md")).toBe(true);
  });

  test("a team base with an edit list still grants the edit: the row is found by row, not by rule visibility", () => {
    const rows = [folder("hr", ROOT_FOLDER, { base: "team", grantees: [{ kind: "user", id: "user-ana", role: "edit" }] })];
    expect(canEditPath(rows, ANA, "hr/x.md")).toBe(true);
    expect(canEditPath(rows, KOLA, "hr/x.md")).toBe(false);
  });

  test("a team base with no list grants no edit to a member who is not named", () => {
    const rows = [folder("hr", ROOT_FOLDER, { base: "team" })];
    expect(canEditPath(rows, ANA, "hr/x.md")).toBe(false);
  });

  test("a private note named with edit can be edited by that person", () => {
    const rows = [note("hr/private.md", NOTE_PRIVATE, { base: "private", grantees: [{ kind: "user", id: "user-ana", role: "edit" }] })];
    expect(canEditPath(rows, ANA, "hr/private.md")).toBe(true);
    expect(canEditPath(rows, KOLA, "hr/private.md")).toBe(false);
  });
});

describe("only the edit name is a write right", () => {
  test("a view grant on the governing row is not an edit", () => {
    const rows = [note("hr/pay.md", NOTE_OWN_LIST, { grantees: [{ kind: "user", id: "user-ana", role: "view" }] })];
    expect(canEditPath(rows, ANA, "hr/pay.md")).toBe(false);
  });

  test("no rows, or a caller who holds nothing, is not an edit", () => {
    expect(governingRowOf([], "hr/x.md")).toBeNull();
    expect(canEditPath([], ANA, "hr/x.md")).toBe(false);
    const rows = [folder("hr", ROOT_FOLDER, { base: "private", grantees: [{ kind: "user", id: "user-kola", role: "edit" }] })];
    expect(canEditPath(rows, {}, "hr/x.md")).toBe(false);
  });
});

describe("isolation: another workspace's edit name never applies", () => {
  test("a name issued for a row in another workspace does not match this workspace's governing row", () => {
    // Workspace A: the note's governing row is A's own row, granted to Kola.
    const rowsA = [note("hr/pay.md", NOTE_OWN_LIST, { grantees: [{ kind: "user", id: "user-kola", role: "edit" }] })];
    // Workspace B: a row at the same path, granted to Ana, with its own id.
    const rowsB = [note("hr/pay.md", LOOKALIKE, { grantees: [{ kind: "user", id: "user-ana", role: "edit" }] })];
    expect(canEditPath(rowsB, ANA, "hr/pay.md")).toBe(true);
    // Ana holds an edit name, but it is B's. It must not open A's note.
    expect(canEditPath(rowsA, ANA, "hr/pay.md")).toBe(false);
  });

  test("a folder edit name from another workspace does not reach this workspace's notes under the same folder", () => {
    const rowsA = [folder("hr", ROOT_FOLDER, { base: "private", grantees: [{ kind: "user", id: "user-kola", role: "edit" }] })];
    const rowsB = [folder("hr", LOOKALIKE, { base: "private", grantees: [{ kind: "user", id: "user-ana", role: "edit" }] })];
    expect(canEditPath(rowsB, ANA, "hr/x.md")).toBe(true);
    expect(canEditPath(rowsA, ANA, "hr/x.md")).toBe(false);
  });
});
