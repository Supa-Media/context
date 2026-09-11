/**
 * What the share field offers as you type.
 *
 * One field, one list, because a person and a group are the same kind of token
 * in `privacy.md`. The properties worth pinning are the ones a type-ahead gets
 * wrong in ways that are annoying rather than obviously broken — and the one
 * it can get wrong dangerously, which is offering to invite somebody when the
 * person typing thinks they are only sharing a note.
 */

import { describe, expect, test } from "@jest/globals";
import {
  recipientsFor,
  type RecipientGroup,
  type RecipientMember,
} from "../features/console/files/recipients";

const MEMBERS: RecipientMember[] = [
  { userId: "u1", name: "kola", email: "kola@example.invalid" },
  { userId: "u2", name: "nikko", email: "nikko@example.invalid" },
  { userId: "u3", name: "rae", email: "rae@example.invalid" },
];

const GROUPS: RecipientGroup[] = [
  { name: "supa-leads", label: "leads", liveCount: 2 },
  { name: "supa-owners", label: "owners", liveCount: 1 },
];

describe("what comes back for a query", () => {
  test("nothing at all before you type", () => {
    expect(recipientsFor("", MEMBERS, GROUPS)).toEqual([]);
    expect(recipientsFor("   ", MEMBERS, GROUPS)).toEqual([]);
  });

  test("a person and a group are the same kind of answer, in one list", () => {
    const rows = recipientsFor("o", MEMBERS, GROUPS);
    expect(rows.some((row) => row.kind === "member")).toBe(true);
    expect(rows.some((row) => row.kind === "group")).toBe(true);
  });

  /**
   * Somebody typing `ko` means `kola` far more often than `nikko`. A
   * type-ahead that puts the substring match first is the kind of wrong that
   * makes people stop trusting the field.
   */
  test("a prefix match outranks a substring one", () => {
    const rows = recipientsFor("ko", MEMBERS, GROUPS);
    expect(rows[0].label).toBe("kola");
    expect(rows.map((row) => row.label)).toContain("nikko");
  });

  test("members come before groups", () => {
    const rows = recipientsFor("o", MEMBERS, GROUPS);
    const firstGroup = rows.findIndex((row) => row.kind === "group");
    const lastMember = rows.map((row) => row.kind).lastIndexOf("member");
    expect(lastMember).toBeLessThan(firstGroup);
  });

  test("a group carries the count of people it actually reaches", () => {
    const rows = recipientsFor("leads", MEMBERS, GROUPS);
    expect(rows[0].detail).toBe("group · 2 people");
    expect(recipientsFor("owners", MEMBERS, GROUPS)[0].detail).toBe("group · 1 person");
  });

  test("an address matches as well as a name", () => {
    expect(recipientsFor("rae@example", MEMBERS, GROUPS)[0].userId).toBe("u3");
  });
});

describe("the invite row", () => {
  /**
   * The one this list can get wrong dangerously. Choosing it is TWO things —
   * an invitation to the workspace, then the rule — so it is a distinct kind,
   * which is what lets the dialog say so before it happens. Folding it into
   * the member rows would make "share with Kolade" quietly also mean "add
   * Kolade to this workspace".
   */
  test("it is its own kind, and says that inviting comes with it", () => {
    const rows = recipientsFor("kolade@example.invalid", MEMBERS, GROUPS);
    const invite = rows.find((row) => row.kind === "invite");
    expect(invite).toBeDefined();
    expect(invite!.detail).toMatch(/inviting them also gives them this note/i);
  });

  test("it is never offered for something that is not an address", () => {
    expect(recipientsFor("kolade", MEMBERS, GROUPS).some((row) => row.kind === "invite")).toBe(
      false,
    );
    expect(recipientsFor("ko", MEMBERS, GROUPS).some((row) => row.kind === "invite")).toBe(false);
  });

  test("...nor for an address that already belongs to somebody here", () => {
    const rows = recipientsFor("kola@example.invalid", MEMBERS, GROUPS);
    expect(rows.some((row) => row.kind === "invite")).toBe(false);
    expect(rows[0].userId).toBe("u1");
  });

  test("it is always last, so a real match is never displaced by it", () => {
    const rows = recipientsFor("kolade@example.invalid", MEMBERS, GROUPS);
    expect(rows[rows.length - 1].kind).toBe("invite");
  });
});

describe("what is already on the note is not offered again", () => {
  test("a member who already has it", () => {
    const rows = recipientsFor("kola", MEMBERS, GROUPS, {
      excludeUserIds: new Set(["u1"]),
    });
    expect(rows.some((row) => row.userId === "u1")).toBe(false);
  });

  test("a group that is already the note's rule", () => {
    const rows = recipientsFor("leads", MEMBERS, GROUPS, {
      excludeGroups: new Set(["supa-leads"]),
    });
    expect(rows.some((row) => row.kind === "group")).toBe(false);
  });
});
