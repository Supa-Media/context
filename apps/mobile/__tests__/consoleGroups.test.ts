/**
 * The Groups section's view model.
 *
 * A group is a name a folder rule points at, and the property every one of
 * these tests circles is the intersection: a person named in a group who has
 * left the workspace reaches nothing. That is the control plane's rule, and
 * this module's job is to say so without flattening it in either direction —
 * hiding the name would leave an owner believing the group is smaller than
 * their manifest says, and alarming about it would send them hunting for a
 * breach that is not there.
 */

import { describe, expect, test } from "@jest/globals";
import {
  canMakeGroup,
  previewGroupName,
  addableMembers,
  canSubmitLabel,
  danglingNote,
  groupRuleToken,
  groupSummary,
  memberLabel,
  type ConsoleGroup,
} from "../features/console/groups/groups";

function group(over: Partial<ConsoleGroup> = {}): ConsoleGroup {
  return {
    groupId: "g1",
    name: "supa-leads",
    label: "leads",
    createdAt: 0,
    members: [
      { userId: "u1", name: "seyi", live: true },
      { userId: "u2", name: "kola", live: true },
    ],
    ...over,
  };
}

describe("what a group's membership reads as", () => {
  test("the count is the people it reaches", () => {
    expect(groupSummary(group())).toBe("2 people");
    expect(groupSummary(group({ members: [{ userId: "u1", name: "seyi", live: true }] }))).toBe(
      "1 person",
    );
  });

  /**
   * The number that must not be one number. The file names three people and
   * reaches two; a single total would hide exactly the thing this section
   * exists to make visible.
   */
  test("a name that reaches nobody is counted separately, never folded into the total", () => {
    const summary = groupSummary(
      group({
        members: [
          { userId: "u1", name: "seyi", live: true },
          { userId: "u2", name: "kola", live: true },
          { userId: "u3", name: "dayo", live: false },
        ],
      }),
    );
    expect(summary).toBe("2 people · 1 no longer a member");
    expect(summary).not.toBe("3 people");
  });

  test("several dangling names read as members, not as a member", () => {
    expect(
      groupSummary(
        group({
          members: [
            { userId: "u1", name: "seyi", live: true },
            { userId: "u2", name: "kola", live: false },
            { userId: "u3", name: "dayo", live: false },
          ],
        }),
      ),
    ).toBe("1 person · 2 no longer members");
  });
});

describe("the sentence under a group with dangling names", () => {
  test("there is none when every name is live", () => {
    expect(danglingNote(group())).toBeNull();
  });

  test("it names them, says they reach nobody, and does not raise an alarm", () => {
    const note = danglingNote(
      group({ members: [{ userId: "u3", name: "dayo", live: false }] }),
    );
    expect(note).toContain("dayo");
    expect(note).toMatch(/does not reach/);
    // The intersection is working, not failing. Nothing here should read as a
    // breach, an error, or something that needs fixing urgently.
    expect(note).toMatch(/grants nothing/);
    expect(note).not.toMatch(/error|warning|breach|leak/i);
  });
});

describe("the name a folder rule would carry", () => {
  test("it is the full slug-prefixed name, with the @ the manifest uses", () => {
    expect(groupRuleToken(group())).toBe("@supa-leads");
  });
});

describe("who can still be added", () => {
  const MEMBERS = [{ userId: "u1" }, { userId: "u2" }, { userId: "u3" }];

  test("anybody not already named", () => {
    expect(addableMembers(group(), MEMBERS)).toEqual([{ userId: "u3" }]);
  });

  /**
   * Adding a dangling name again would change nothing — only re-joining the
   * workspace makes somebody live — so offering it would be a control whose
   * press does nothing visible.
   */
  test("...and not somebody whose name is already there but dangling", () => {
    const withDangling = group({
      members: [
        { userId: "u1", name: "seyi", live: true },
        { userId: "u3", name: "dayo", live: false },
      ],
    });
    expect(addableMembers(withDangling, MEMBERS)).toEqual([{ userId: "u2" }]);
  });
});

describe("what the form will let you submit", () => {
  test("a label has to be long enough to be a name at all", () => {
    expect(canSubmitLabel("")).toBe(false);
    expect(canSubmitLabel(" a ")).toBe(false);
    expect(canSubmitLabel("leads")).toBe(true);
  });

  /**
   * Deliberately thin. `buildGroupName` decides what a name may be — charset,
   * reserved words, the IDNA label form, the assembled length — and the server
   * refuses anybody who is not an owner. A second copy of those rules here is
   * a second place for them to drift, so this only stops a request that is
   * certain to fail.
   */
  test("it does not re-implement the namespace's rules", () => {
    expect(canSubmitLabel("leads_team")).toBe(true);
    expect(canSubmitLabel("workspace")).toBe(true);
  });
});

describe("how somebody is named in a chip", () => {
  test("the name, then the address, then the id — whichever exists first", () => {
    expect(memberLabel({ userId: "u1", name: "seyi", email: "s@x.invalid", live: true })).toBe("seyi");
    expect(memberLabel({ userId: "u1", email: "s@x.invalid", live: true })).toBe("s@x.invalid");
    expect(memberLabel({ userId: "u1", live: true })).toBe("u1");
  });
});

/**
 * ## Making a group where groups are actually born
 *
 * `GroupsPanel` opens by admitting "Nobody should have to come here first" —
 * and it was the only door. A group is what you get when you have handed the
 * same two people the same folder three times, so the moment one should exist
 * is the moment you are looking at a note and picking those people; going to
 * Settings, typing a label, adding them one at a time and coming back is the
 * detour that stops anybody bothering.
 *
 * The sheet can now do it. What it may not do is offer a button that is
 * certain to fail, so this is the same thin check `canSubmitLabel` is — the
 * control plane's `buildGroupName` remains the authority on what a name may
 * be, and duplicating its rules here would be a second place for them to
 * drift.
 */
describe("offering to make a group from the share sheet", () => {
  test("needs a usable label and somebody to put in it", () => {
    expect(canMakeGroup("leads", ["u1"])).toBe(true);
    expect(canMakeGroup("leads", ["u1", "u2"])).toBe(true);
  });

  test("a group of nobody is not a group", () => {
    expect(canMakeGroup("leads", [])).toBe(false);
  });

  /** The same floor `canSubmitLabel` sets, read through one function. */
  test("a label the panel would refuse is refused here too", () => {
    expect(canMakeGroup("l", ["u1"])).toBe(false);
    expect(canMakeGroup("  ", ["u1"])).toBe(false);
    expect(canMakeGroup("", ["u1"])).toBe(false);
  });

  /**
   * The prefix belongs to the workspace, never to the person typing —
   * `buildGroupName` derives it from the slug. The sheet shows it for the same
   * reason the panel does: an interface that lets you type `supa-` into a
   * field that already prepends it produces `@supa-supa-leads`.
   */
  test("the name shown while typing is the name that will exist", () => {
    expect(previewGroupName("supa", "leads")).toBe("@supa-leads");
    expect(previewGroupName("supa", "  leads  ")).toBe("@supa-leads");
    expect(previewGroupName("supa", "")).toBe("@supa-…");
  });
});
