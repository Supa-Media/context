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
  noMatchHint,
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

  /**
   * Last among the things you can act on, which is what "never displaced a real
   * match" always meant. Informational rows — somebody who already reaches the
   * note — sort below it without being offers at all.
   */
  test("it is last of the offers, so a real match is never displaced by it", () => {
    const rows = recipientsFor("kolade@example.invalid", MEMBERS, GROUPS);
    expect(rows[rows.length - 1].kind).toBe("invite");

    const mixed = recipientsFor("kola@example.invalid", MEMBERS, GROUPS, {
      reachingUserIds: new Set(["u1"]),
    });
    const offers = mixed.filter((row) => row.reaches !== true);
    expect(offers.every((row) => row.kind !== "invite")).toBe(true);
  });
});

/**
 * ## The defect this block exists for
 *
 * The dialog used to hand this function **every member of the workspace** as an
 * exclusion set, so a matching colleague was filtered out of their own
 * suggestion list. On a team-visible note that is everybody, and because the
 * invite row needs a *complete* address, typing `dim` produced an empty box —
 * which read, correctly, as "there is no autocomplete here".
 *
 * Two things were wrong and they are separable.
 *
 * **What the set measures.** It excluded members of the *workspace*; what
 * matters is who reaches *this note*. On a private note those are opposite: the
 * owner reaches it and nobody else does, yet every member was filtered out, so
 * the field was blank exactly where it had the most to offer.
 *
 * **That hiding was the wrong answer anyway.** Somebody typing a name wants to
 * know where that person stands, and "no rows" cannot say "they already have
 * it" — it looks identical to "no such person" and to "this field is broken".
 * So a person who already reaches the note is *shown and marked*, never
 * dropped, and the dialog renders that row as an answer rather than an offer.
 */
describe("somebody who already reaches the note", () => {
  test("is shown rather than hidden, and marked", () => {
    const rows = recipientsFor("kola", MEMBERS, GROUPS, {
      reachingUserIds: new Set(["u1"]),
    });
    const kola = rows.find((row) => row.userId === "u1");
    expect(kola).toBeDefined();
    expect(kola!.reaches).toBe(true);
    expect(kola!.detail).toMatch(/already/i);
  });

  test("sorts below the people you can actually add", () => {
    const rows = recipientsFor("k", MEMBERS, GROUPS, {
      reachingUserIds: new Set(["u1"]),
    });
    const offered = rows.findIndex((row) => row.reaches !== true);
    const reaching = rows.findIndex((row) => row.reaches === true);
    expect(offered).toBeGreaterThanOrEqual(0);
    expect(reaching).toBeGreaterThan(offered);
  });

  test("a group already named on the note is shown the same way", () => {
    const rows = recipientsFor("leads", MEMBERS, GROUPS, {
      reachingGroups: new Set(["supa-leads"]),
    });
    const group = rows.find((row) => row.kind === "group");
    expect(group).toBeDefined();
    expect(group!.reaches).toBe(true);
  });

  /**
   * The case in the screenshot that started this: a team-visible note, every
   * member reaching it through the folder. The field must still answer.
   */
  test("a note everybody reaches still answers the query", () => {
    const rows = recipientsFor("k", MEMBERS, GROUPS, {
      reachingUserIds: new Set(["u1", "u2", "u3"]),
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.reaches === true)).toBe(true);
  });

  /**
   * The exclusion that survives, because it is the one that was right: an
   * address belonging to somebody already here is not an invitation. Offering
   * to invite them would be offering to do nothing, and the row says the
   * opposite — that it also adds them to the workspace.
   */
  test("is never offered as an invitation", () => {
    const rows = recipientsFor("kola@example.invalid", MEMBERS, GROUPS, {
      reachingUserIds: new Set(["u1"]),
    });
    expect(rows.some((row) => row.kind === "invite")).toBe(false);
  });
});

/**
 * What the dialog draws when the list comes back empty. A blank box is the
 * failure this whole change is about, so "no rows" must never be the last word
 * the interface says.
 */
describe("no match", () => {
  test("a partial name that matches nobody is distinguishable from an empty query", () => {
    expect(recipientsFor("", MEMBERS, GROUPS)).toEqual([]);
    expect(recipientsFor("zzz", MEMBERS, GROUPS)).toEqual([]);
    // The dialog tells these apart by the query, not the rows — pinned here so
    // a future "return a placeholder row" does not break that contract.
    expect(noMatchHint("zzz")).toMatch(/full email address/i);
    expect(noMatchHint("")).toBeUndefined();
  });
});

describe("finding somebody by their @name", () => {
  const PEOPLE: RecipientMember[] = [
    { userId: "u1", name: "Mari Lola", email: "mari@example.invalid", handle: "marilola" },
    { userId: "u2", name: "kola", email: "kola@example.invalid" },
  ];

  test("a typed @ does not hide a member: @mari finds Mari Lola by name, and by her handle", () => {
    expect(recipientsFor("@mari", PEOPLE, []).map((row) => row.key)).toContain("u1");
    expect(recipientsFor("@marilola", PEOPLE, [])[0]).toMatchObject({ kind: "member", userId: "u1" });
  });

  test("a member's row says their @name, so the person typing can tell two Maris apart", () => {
    expect(recipientsFor("mari", PEOPLE, [])[0].detail).toBe("@marilola · mari@example.invalid");
  });

  test("an @name outside the workspace is offered only once the server says a person holds it", () => {
    expect(recipientsFor("@seyi", PEOPLE, [], { handleFound: true })).toEqual([
      expect.objectContaining({ kind: "handle", key: "@seyi", label: "@seyi" }),
    ]);
    // Nobody holds it, the answer has not come back yet, or nobody could ask: no row to press by mistake.
    expect(recipientsFor("@se", PEOPLE, [], { handleFound: false })).toEqual([]);
    expect(recipientsFor("@seyi", PEOPLE, [], {})).toEqual([]);
  });

  test("an @name a member holds is that member, not a second row for the same person", () => {
    const rows = recipientsFor("@marilola", PEOPLE, []);
    expect(rows.filter((row) => row.kind === "handle")).toEqual([]);
  });

  test("a group's name is the group, not a person's handle", () => {
    const rows = recipientsFor("@supa-leads", [], GROUPS);
    expect(rows.map((row) => row.kind)).toEqual(["group"]);
  });

  test("only something shaped like a name: no @ at all, one letter, spaces or an address are not offered as one", () => {
    for (const query of ["seyi", "@s", "@se yi", "@-seyi", "@seyi@example.invalid", "@@seyi"]) {
      expect(recipientsFor(query, [], [], { handleFound: true }).some((row) => row.kind === "handle")).toBe(false);
    }
  });

  test("an @name already on the note's list is not offered again", () => {
    const rows = recipientsFor("@seyi", [], [], { reachingHandles: new Set(["seyi"]) });
    expect(rows).toEqual([expect.objectContaining({ kind: "handle", reaches: true })]);
  });

  test("the empty hint says an @name works too", () => {
    expect(noMatchHint("zz")).toMatch(/@name/);
  });

  test("a typed @name nobody holds says so, and says it is looking while the answer is on its way", () => {
    expect(noMatchHint("@se", false)).toBe("Nobody on Context goes by @se. Check the spelling, or type their email.");
    expect(noMatchHint("@se", undefined)).toBe("Looking for @se…");
  });
});
