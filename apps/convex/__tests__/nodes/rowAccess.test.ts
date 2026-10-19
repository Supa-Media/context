/**
 * The row renderer drives the REAL `canSee` from `lib/privacy.ts`, so these
 * assert what the engine lets through, not what the renderer says it will.
 *
 * Sabotage: make `accessNamesFor` merge an ancestor folder's list into a
 * note's names (the "lists add instead of replace" failure) and the
 * "note list replaces folder list" case fails.
 */

import { describe, expect, test } from "vitest";
import { canSee, type Scope } from "../../functions/lib/privacy";
import { clearanceOf } from "../../functions/lib/clearance";
import {
  accessNamesFor,
  editNameFor,
  renderAccess,
  viewNameFor,
  type AccessRow,
  type Audience,
  type Caller,
} from "../../functions/lib/nodes/rowAccess";

const FOLDER_HR = "00000000-0000-7000-8000-000000000001";
const NOTE_PAY = "00000000-0000-7000-8000-000000000002";
const NOTE_TEAM = "00000000-0000-7000-8000-000000000003";
const FOLDER_CLIENTS = "00000000-0000-7000-8000-000000000004";
const NOTE_BOB = "00000000-0000-7000-8000-000000000005";

/** A reader: renders the rows for an audience and answers `canSee` for a caller. */
function reader(rows: AccessRow[], audience: Audience, caller: Caller, scope: Scope = "team") {
  const { rules, overrides } = renderAccess(rows, audience);
  const clearance = clearanceOf(scope, accessNamesFor(caller, rows));
  return (key: string) => canSee(key, clearance.scope, rules, overrides, clearance.names);
}

const NOBODY: Caller = {};
const ANA: Caller = { userId: "user-ana" };
const KOLA: Caller = { userId: "user-kola" };

describe("nearest setting wins, and a note's list replaces its folder's", () => {
  test("a team note inside a private folder is visible to a member", () => {
    const rows: AccessRow[] = [
      { path: "2-areas/hr", noteId: FOLDER_HR, kind: "folder", base: "private", grantees: [] },
      { path: "2-areas/hr/policy.md", noteId: NOTE_TEAM, kind: "file", base: "team", grantees: [] },
    ];
    const see = reader(rows, "member", NOBODY);
    expect(see("2-areas/hr/policy.md")).toBe(true);
    expect(see("2-areas/hr/other.md")).toBe(false);
  });

  test("a private note inside a team folder is hidden from a member", () => {
    const rows: AccessRow[] = [
      { path: "1-projects", noteId: FOLDER_CLIENTS, kind: "folder", base: "team", grantees: [] },
      { path: "1-projects/salary.md", noteId: NOTE_PAY, kind: "file", base: "private", grantees: [] },
    ];
    const see = reader(rows, "member", NOBODY);
    expect(see("1-projects/salary.md")).toBe(false);
    expect(see("1-projects/roadmap.md")).toBe(true);
  });

  test("a person on the folder list but not on the note's own list is denied the note", () => {
    const rows: AccessRow[] = [
      {
        path: "2-areas/hr",
        noteId: FOLDER_HR,
        kind: "folder",
        base: "private",
        grantees: [{ kind: "user", id: "user-kola", role: "view" }],
      },
      {
        path: "2-areas/hr/pay.md",
        noteId: NOTE_PAY,
        kind: "file",
        base: "private",
        grantees: [{ kind: "user", id: "user-ana", role: "view" }],
      },
    ];
    expect(reader(rows, "guest", KOLA)("2-areas/hr/notes.md")).toBe(true);
    expect(reader(rows, "guest", KOLA)("2-areas/hr/pay.md")).toBe(false);
    expect(reader(rows, "guest", ANA)("2-areas/hr/pay.md")).toBe(true);
  });
});

describe("guests see only the listed subtree", () => {
  const rows: AccessRow[] = [
    {
      path: "2-areas/clients",
      noteId: FOLDER_CLIENTS,
      kind: "folder",
      base: "private",
      grantees: [{ kind: "user", id: "user-kola", role: "view" }],
    },
    // Unlisted sibling inside the folder: a team note with nobody added.
    { path: "2-areas/clients/bob.md", noteId: NOTE_BOB, kind: "file", base: "team", grantees: [] },
    // A sibling folder whose name only starts with the listed one.
    { path: "2-areas/clients-old", noteId: NOTE_TEAM, kind: "folder", base: "team", grantees: [] },
  ];
  const see = reader(rows, "guest", KOLA);

  test("a listed folder's descendants without their own row are visible", () => {
    expect(see("2-areas/clients/acme/plan.md")).toBe(true);
  });

  test("an unlisted sibling note is denied, even though it is team elsewhere", () => {
    expect(see("2-areas/clients/bob.md")).toBe(false);
  });

  test("everything outside the listed subtree is denied, including a prefix-twin folder", () => {
    expect(see("2-areas/clients-old/x.md")).toBe(false);
    expect(see("2-areas/other/x.md")).toBe(false);
    expect(see("1-projects/x.md")).toBe(false);
  });
});

describe("grants resolve through names, and only through them", () => {
  const rows: AccessRow[] = [
    {
      path: "2-areas/deal.md",
      noteId: NOTE_PAY,
      kind: "file",
      base: "private",
      grantees: [
        { kind: "group", id: "supa-leads", role: "view" },
        { kind: "email", id: "Partner@Example.test", role: "view" },
      ],
    },
  ];

  test("a group grant reaches a caller holding the group, and not one who does not", () => {
    expect(reader(rows, "member", { groupIds: ["supa-leads"] })("2-areas/deal.md")).toBe(true);
    expect(reader(rows, "member", { groupIds: ["supa-other"] })("2-areas/deal.md")).toBe(false);
    expect(reader(rows, "member", NOBODY)("2-areas/deal.md")).toBe(false);
  });

  test("a members grant reaches a real member, never a guest or someone outside", () => {
    const open: AccessRow[] = [
      { path: "2-areas/bug.md", noteId: NOTE_PAY, kind: "file", base: "private", grantees: [{ kind: "members", id: "members", role: "view" }] },
    ];
    expect(reader(open, "member", { userId: "user-ana", member: true })("2-areas/bug.md")).toBe(true);
    expect(reader(open, "member", ANA)("2-areas/bug.md")).toBe(false);
    expect(reader(open, "guest", ANA)("2-areas/bug.md")).toBe(false);
    expect(reader(open, "member", NOBODY)("2-areas/bug.md")).toBe(false);
  });

  test("an email grant matches case-insensitively", () => {
    expect(reader(rows, "guest", { emails: ["partner@example.test"] })("2-areas/deal.md")).toBe(true);
    expect(reader(rows, "guest", { emails: ["stranger@example.test"] })("2-areas/deal.md")).toBe(false);
  });

  test("a private note with no list is visible to no member but the owner", () => {
    const bare: AccessRow[] = [{ path: "2-areas/x.md", noteId: NOTE_TEAM, kind: "file", base: "private", grantees: [] }];
    expect(reader(bare, "member", ANA)("2-areas/x.md")).toBe(false);
    expect(reader(bare, "member", ANA, "private")("2-areas/x.md")).toBe(true);
  });

  test("the edit name is held only by an edit grant, and the view name by either", () => {
    const viewOnly = accessNamesFor({ userId: "user-ana" }, [
      { ...rows[0], grantees: [{ kind: "user", id: "user-ana", role: "view" }] },
    ]);
    const edit = accessNamesFor({ userId: "user-ana" }, [
      { ...rows[0], grantees: [{ kind: "user", id: "user-ana", role: "edit" }] },
    ]);
    expect(viewOnly).toEqual([viewNameFor(NOTE_PAY)]);
    expect(edit).toEqual([viewNameFor(NOTE_PAY), editNameFor(NOTE_PAY)].sort());
    // Visibility is decided by the view name alone: an edit-only holder sees the note.
    const editRows: AccessRow[] = [
      { ...rows[0], grantees: [{ kind: "user", id: "user-ana", role: "edit" }] },
    ];
    expect(reader(editRows, "guest", ANA)("2-areas/deal.md")).toBe(true);
  });
});
