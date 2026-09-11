/**
 * The share dialog's people list, as a pure join.
 *
 * `accessRows` answers "who reaches this note" from two things somebody else
 * decided: the visibility the server computed, and the membership the control
 * plane returned. The properties worth pinning are the ones a list like this
 * gets wrong in the direction that matters — showing somebody as having access
 * when they do not.
 */

import { describe, expect, test } from "@jest/globals";
import { accessRows, accessSummary, type AccessMember } from "../features/console/files/access";

const MEMBERS: AccessMember[] = [
  { userId: "u1", role: "owner", name: "seyi", isMe: true },
  { userId: "u2", role: "editor", name: "kola", isMe: false },
  { userId: "u3", role: "member", name: "rae", isMe: false },
];

describe("who reaches a note", () => {
  test("a team note reaches everybody, and says the folder is why", () => {
    const rows = accessRows("team", false, MEMBERS);
    expect(rows.map((row) => row.label)).toEqual(["seyi (you)", "kola", "rae"]);
    expect(rows[1].reason).toMatch(/folder/i);
  });

  test("...and says the note is why when the note itself carries the rule", () => {
    expect(accessRows("team", true, MEMBERS)[1].reason).toMatch(/this note/i);
  });

  /**
   * The direction that matters. A private note reaches owners; a list that
   * showed the editor greyed out would read as "shared with three people" at
   * the glance this screen exists for.
   */
  test("a private note lists owners only, and the others are absent rather than dimmed", () => {
    const rows = accessRows("private", true, MEMBERS);
    expect(rows.map((row) => row.label)).toEqual(["seyi (you)"]);
  });

  test("a group rule is named rather than resolved to people it cannot see", () => {
    const rows = accessRows("@supa-leads", true, MEMBERS);
    expect(rows.map((row) => row.label)).toEqual(["seyi (you)", "@supa-leads"]);
    // Not "kola" — this console does not know who is in the group, and
    // guessing is the overstatement the whole privacy vocabulary forbids.
    expect(rows.map((row) => row.label)).not.toContain("kola");
    expect(rows[1].role).toBe("group");
  });

  test("every row is keyed uniquely, including the group row", () => {
    const rows = accessRows("@supa-leads", true, MEMBERS);
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });
});

describe("the summary line", () => {
  test("names the group instead of calling it private", () => {
    expect(accessSummary("@supa-leads", true)).toContain("@supa-leads");
    expect(accessSummary("@supa-leads", true)).not.toMatch(/\bprivate\b/i);
  });

  test("says where the rule came from, which is the half a list cannot show", () => {
    expect(accessSummary("team", false)).toMatch(/inherited from its folder/);
    expect(accessSummary("team", true)).toMatch(/set on this note/);
  });

  test("the two tiers read as themselves", () => {
    expect(accessSummary("team", false)).toMatch(/Everyone in this workspace/);
    expect(accessSummary("private", false)).toMatch(/Only owners/);
  });
});

describe("not loaded is not empty", () => {
  /**
   * The rule `privacy/map.ts` states for its own rows. An empty list under
   * "PEOPLE WITH ACCESS" is a claim — "nobody can read this" — and it is the
   * wrong one to make about a team-readable note whose membership has not
   * landed yet. No rows, and the summary line carries the truth meanwhile.
   */
  test("a membership still in flight draws no rows rather than an empty context", () => {
    expect(accessRows("team", false, undefined)).toEqual([]);
    expect(accessRows("private", false, undefined)).toEqual([]);
    // The summary is unaffected, because it does not depend on the list.
    expect(accessSummary("team", false)).toMatch(/Everyone in this workspace/);
  });

  test("an actually-empty membership is still empty, so the two are not conflated", () => {
    expect(accessRows("team", false, [])).toEqual([]);
  });
});
