/**
 * THE WORDS THE SHARE SURFACE USES.
 *
 * `privacy/words.ts` states the rule this file enforces: **copy is a guard
 * here.** This is the surface whose whole job is telling somebody who can read
 * their notes, and a sentence that overstates is the same defect as a control
 * that publishes something, only quieter and read by more people.
 *
 * So these are not spelling tests. Each one is a claim the words may not make:
 *
 *  - nothing may suggest a tier between or beyond the two;
 *  - nothing may suggest `team` reaches past this context's members;
 *  - a `@name` rule may never be called "Restricted", which would tell an owner
 *    that nobody but them can read a note two colleagues can;
 *  - and `private` in a shared context may never be flattened to "mine".
 */

import { describe, expect, test } from "@jest/globals";
import {
  audienceChip,
  audienceDetail,
  audienceName,
  audienceSource,
  contextHandle,
  type AudienceContext,
} from "../features/console/privacy/audience";

const supa: AudienceContext = { slug: "supa", kind: "shared", viewerIsOwner: true };
const mine: AudienceContext = { slug: "seyi", kind: "personal", viewerIsOwner: true };
const theirs: AudienceContext = { slug: "lk", kind: "personal", viewerIsOwner: false };
const loading: AudienceContext = { slug: null, kind: null, viewerIsOwner: false };

/* -------------------------------------------------------------------------- */
/*                          the context is named                              */
/* -------------------------------------------------------------------------- */

describe("`team` is rendered as the context's own name", () => {
  test("because a name is checkable and `team` is not", () => {
    expect(audienceName("team", supa)).toBe("Everyone in @supa");
  });

  test("and the detail says it is not public, in words", () => {
    const detail = audienceDetail("team", supa);
    expect(detail).toContain("nobody outside it");
    expect(detail).toContain("Not public");
  });

  /**
   * A label that says "Everyone in @undefined" while a query is in flight is
   * worse than one that is merely vague, and this is the case that produces it.
   */
  test("a name that has not loaded yet still makes a true sentence", () => {
    expect(audienceName("team", loading)).toBe("Everyone in this context");
    expect(contextHandle(null)).toBe("this context");
    expect(contextHandle("  ")).toBe("this context");
  });

  test("no audience word anywhere hints at the internet", () => {
    for (const context of [supa, mine, theirs, loading]) {
      for (const visibility of ["private", "team", "@supa-leads"] as const) {
        const said = `${audienceName(visibility, context)} ${audienceDetail(visibility, context)}`;
        expect(said.toLowerCase()).not.toContain("public link");
        expect(said.toLowerCase()).not.toContain("anyone on the internet");
        expect(said.toLowerCase()).not.toContain("indexed by");
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                     `private` claims nothing about who                     */
/* -------------------------------------------------------------------------- */

describe("`Restricted` is the word, and the sentence says who", () => {
  test("the label is the same in both kinds, because it claims nothing", () => {
    expect(audienceName("private", supa)).toBe("Restricted");
    expect(audienceName("private", mine)).toBe("Restricted");
  });

  /**
   * The one thing a member cannot work out from the rules, and the thing
   * somebody otherwise learns by marking a folder private and locking out
   * their co-lead.
   */
  test("in a shared context it is owners, and says so rather than saying `mine`", () => {
    const detail = audienceDetail("private", supa);
    expect(detail).toContain("Owners");
    expect(detail).toContain("not its editors");
    expect(detail.toLowerCase()).not.toContain("yours alone");
    expect(detail.toLowerCase()).not.toContain("only you");
  });

  test("in my own context it is mine", () => {
    expect(audienceDetail("private", mine)).toContain("Yours alone");
  });

  /**
   * Rendered on somebody else's context at `member`, "Yours alone" would be a
   * sentence about notes that are not the reader's at all.
   */
  test("in somebody else's context it is theirs, not mine", () => {
    const detail = audienceDetail("private", theirs);
    expect(detail.toLowerCase()).not.toContain("yours alone");
    expect(detail).toContain("owner");
  });
});

/* -------------------------------------------------------------------------- */
/*                        a name is named, never hidden                       */
/* -------------------------------------------------------------------------- */

describe("a rule naming somebody says the name", () => {
  /**
   * The exact defect `words.ts` opens by naming, in its own words: a note
   * readable by two colleagues, labelled as reaching nobody but its owner.
   * Overstating privacy is the same class of bug as publishing something.
   */
  test("a group is never labelled Restricted", () => {
    expect(audienceName("@supa-leads", supa)).toBe("@supa-leads");
    expect(audienceName("@supa-leads", supa)).not.toBe("Restricted");
  });

  test("a live count rides along when the caller knows it", () => {
    expect(audienceName("@supa-leads", supa, 4)).toBe("@supa-leads (4 people)");
    expect(audienceName("@supa-leads", supa, 1)).toBe("@supa-leads (1 person)");
  });

  /**
   * `undefined` is not zero. A group whose membership has not loaded must not
   * render as a group nobody is in — the rule `accessRows` follows for a member
   * list still in flight, applied to the same question.
   */
  test("an unknown count is omitted rather than shown as none", () => {
    expect(audienceName("@supa-leads", supa)).not.toContain("0");
    expect(audienceName("@supa-leads", supa, 0)).toBe("@supa-leads (0 people)");
  });

  test("the detail says the owners reach it too, which is true and easy to miss", () => {
    expect(audienceDetail("@supa-leads", supa)).toContain("owners");
  });
});

/* -------------------------------------------------------------------------- */
/*                       where the rule came from                             */
/* -------------------------------------------------------------------------- */

describe("inheritance is stated, because a list of faces cannot show it", () => {
  test("a note says whether the rule is its own", () => {
    expect(audienceSource(true, "file")).toBe("Set on this note");
    expect(audienceSource(false, "file")).toBe("Inherited from its folder");
  });

  /**
   * "Only this note changes" is the sentence that makes a narrowing feel safe,
   * and it is false on a folder — in the direction that quietly closes a whole
   * subtree somebody meant to keep shared. So the words change with the kind.
   */
  test("a folder says folder, because its rule cascades", () => {
    expect(audienceSource(true, "folder")).toBe("Set on this folder");
    expect(audienceSource(false, "folder")).toContain("folder above");
  });

  test("the chip carries both halves", () => {
    expect(audienceChip("team", false, "file", supa)).toBe(
      "Everyone in @supa — inherited from its folder",
    );
    expect(audienceChip("@supa-leads", true, "folder", supa)).toBe(
      "@supa-leads — set on this folder",
    );
  });
});
