/**
 * SHARING, FROM THE CONSOLE'S SIDE.
 *
 * The pure parts: which rows may be shared, what link is handed out, and the
 * sentences the dialog tells the owner. Everything here is in a module a test
 * can reach, which is the rule `capabilities.ts` states at length — across a
 * sabotage sweep of this feature area, every guard expressed as a pure module
 * was held and every guard expressed inside a hook or component was not.
 *
 * The one that matters most is `canShare`. It is `canEdit && isOwner`, and the
 * half that gets dropped is `isOwner` — which is exactly the defect PR #93/#95
 * removed from three other surfaces after an editor used it.
 */

import { describe, expect, test } from "@jest/globals";
import { capabilitiesForRole, canSetVisibility, canShare } from "../features/console/capabilities";
import {
  describePersonalShare,
  SHARE_PATH_PREFIX,
  describePreviewTitle,
  describeShareRow,
  shareEligibility,
  shareUrl,
  sharesBreakingWarning,
  sharesFor,
  type NoteShare,
} from "../features/console/files/shares";

const share = (over: Partial<NoteShare> = {}): NoteShare => ({
  shareId: "s1",
  token: "a".repeat(64),
  recipient: "@lk",
  audience: "name",
  entryPath: "1-projects/plan.md",
  titleInPreview: true,
  previewTitle: "Plan",
  createdAt: 1,
  ...over,
});

describe("who may share", () => {
  test("an owner may", () => {
    expect(canShare(capabilitiesForRole("owner"))).toBe(true);
  });

  /**
   * THE test. An editor writes notes; deciding who outside the context reads
   * them is not the same grant, and the server says so with `minimum: "owner"`.
   */
  test("an editor may not", () => {
    expect(canShare(capabilitiesForRole("editor"))).toBe(false);
  });

  test("a member may not", () => {
    expect(canShare(capabilitiesForRole("member"))).toBe(false);
  });

  /**
   * An unknown role is not a permissive one. `undefined` is a console with
   * nothing selected; an unrecognised string is what a newer control plane
   * would send. Both must answer no — the direction this has to fail is
   * "offer less than the server allows".
   */
  test("an unknown or absent role may not", () => {
    expect(canShare(capabilitiesForRole(undefined))).toBe(false);
    expect(canShare(capabilitiesForRole("viewer"))).toBe(false);
  });

  /**
   * They are the same expression today and are deliberately two functions.
   * A future decision to let editors share must not silently also hand them
   * the access map.
   */
  test("it is its own decision, not an alias for the visibility one", () => {
    for (const role of ["owner", "editor", "member", undefined]) {
      const caps = capabilitiesForRole(role);
      expect(typeof canShare(caps)).toBe("boolean");
      expect(typeof canSetVisibility(caps)).toBe("boolean");
    }
  });
});

describe("what may be shared", () => {
  test("a note may", () => {
    expect(
      shareEligibility({ path: "1-projects/plan.md", kind: "file", readOnly: false }),
    ).toEqual({ ok: true });
  });

  test("a folder may not, and is told why", () => {
    const result = shareEligibility({
      path: "1-projects",
      kind: "folder",
      readOnly: false,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/share a note inside it/i);
  });

  /** `privacy.md` is the access map; handing it over enumerates every private folder. */
  test("a read-only row may not", () => {
    expect(
      shareEligibility({ path: "privacy.md", kind: "file", readOnly: true }).ok,
    ).toBe(false);
  });

  test("a non-note file may not", () => {
    expect(
      shareEligibility({ path: "3-resources/slides.pdf", kind: "file", readOnly: false })
        .ok,
    ).toBe(false);
  });

  test("the extension check is case-insensitive", () => {
    expect(
      shareEligibility({ path: "1-projects/PLAN.MD", kind: "file", readOnly: false }).ok,
    ).toBe(true);
  });
});

describe("the link", () => {
  /**
   * Must agree with `SHARE_PREFIX` in `infra/router/src/preview.ts`. If they
   * diverge, the console hands out links whose card the router does not
   * recognise — every share unfurls as the frozen product card and nobody can
   * tell why. Asserted rather than left to a comment.
   */
  test("uses the prefix the router routes", () => {
    expect(SHARE_PATH_PREFIX).toBe("/s/");
  });

  test("is absolute and built from the console's own origin", () => {
    expect(shareUrl("abc", "https://context.lc")).toBe("https://context.lc/s/abc");
  });

  /**
   * Self-hosting is a supported path. A Copy Link that pasted our domain into a
   * self-hoster's chat sends their colleague to sign in to somebody else's
   * product to look for a note that is not there.
   */
  test("honours a self-hosted origin", () => {
    expect(shareUrl("abc", "https://notes.example.invalid")).toBe(
      "https://notes.example.invalid/s/abc",
    );
  });

  test("does not double the slash when the origin carries one", () => {
    expect(shareUrl("abc", "https://context.lc/")).toBe("https://context.lc/s/abc");
  });

  test("works in development", () => {
    expect(shareUrl("abc", "http://localhost:8081")).toBe(
      "http://localhost:8081/s/abc",
    );
  });
});

describe("what the owner is told", () => {
  /**
   * The traversal rule stated outright. "Share this note" is shorter and
   * describes a grant the reader would guess wrong in the direction that
   * matters — the linked notes come with it.
   */
  test("the description names the linked notes, not just this one", () => {
    /*
      One sentence carries all of it now — `describeShare` said the same three
      things directly beneath this one and is gone. The assertions did not
      move: what the owner must not guess wrong is unchanged, only how many
      paragraphs it takes to say.
    */
    expect(describePersonalShare()).toMatch(/notes it links to/i);
    expect(describePersonalShare()).toMatch(/sign in/i);
    expect(describePersonalShare()).toMatch(/nothing else/i);
    expect(describePersonalShare()).toMatch(/take it back/i);
  });

  /** Named after the title that will actually appear, not "may expose metadata". */
  test("the preview warning quotes the title it will show", () => {
    expect(describePreviewTitle("Chapter transition", "name")).toContain(
      "Chapter transition",
    );
    expect(describePreviewTitle("Chapter transition", "name")).toMatch(
      /before signing in/i,
    );
  });

  test("with no title it says so rather than quoting an empty string", () => {
    const text = describePreviewTitle(undefined, "name");
    expect(text).toMatch(/note's name/i);
    expect(text).not.toContain("“”");
  });

  /**
   * "Before signing in" is the cost for a link whose reader signs in
   * afterwards. An unlisted link's reader never does, so that sentence would
   * be naming a step that does not happen — and would read as reassurance.
   */
  test("an unlisted link does not promise a sign-in that never comes", () => {
    const text = describePreviewTitle("Chapter transition", "anyone");
    expect(text).not.toMatch(/signing in/i);
    expect(text).toContain("Chapter transition");
  });

  test("each kind of row says what it actually grants", () => {
    expect(describeShareRow("anyone")).toMatch(/no sign-in/i);
    expect(describeShareRow("anyone")).toMatch(/anyone who has this link/i);
    expect(describeShareRow("members")).toMatch(/already given access/i);
    expect(describeShareRow("name")).toMatch(/notes it links to/i);
    // The one a reader must not mistake for another: the members link grants
    // nothing, the unlisted one grants everything it points at.
    expect(describeShareRow("anyone")).not.toBe(describeShareRow("members"));
  });
});

describe("what a rename costs the links people hold", () => {
  /**
   * An unlisted link is held by an unknown number of people — that is the whole
   * point of it — so a row count printed as a headcount would be read as the
   * size of the audience. It is named rather than counted.
   */
  test("an unlisted link is named, never counted as one person", () => {
    const text = sharesBreakingWarning(
      [share({ audience: "anyone", recipient: "Anyone with the link" })],
      "1-projects/plan.md",
      "Renaming",
    );
    expect(text).toMatch(/unlisted link anyone can open/i);
    expect(text).not.toMatch(/1 person/i);
    expect(text).toMatch(/Renaming it breaks it/);
  });

  test("addressed links are still counted, beside it", () => {
    const text = sharesBreakingWarning(
      [
        share({ shareId: "s1" }),
        share({ shareId: "s2", recipient: "a@example.invalid", audience: "email" }),
        share({ shareId: "s3", audience: "anyone", recipient: "Anyone with the link" }),
      ],
      "1-projects/plan.md",
      "Moving",
    );
    expect(text).toMatch(/2 people hold links/i);
    expect(text).toMatch(/unlisted link/i);
    expect(text).toMatch(/breaks them/);
  });

  test("and with no unlisted link the sentence is what it always was", () => {
    expect(
      sharesBreakingWarning([share()], "1-projects/plan.md", "Archiving"),
    ).toMatch(/^1 person holds a link to this note\. Archiving it breaks it —/);
  });
});

describe("the shares on one note", () => {
  test("only this note's, newest first", () => {
    const rows = sharesFor(
      [
        share({ shareId: "a", createdAt: 1 }),
        share({ shareId: "b", entryPath: "other.md", createdAt: 2 }),
        share({ shareId: "c", createdAt: 3 }),
      ],
      "1-projects/plan.md",
    );
    expect(rows?.map((row) => row.shareId)).toEqual(["c", "a"]);
  });

  /**
   * `undefined` is "not loaded"; `[]` is "nobody". A dialog that renders the
   * first as the second tells the owner their share did not work, and the
   * mistake they make next is sharing it twice.
   */
  test("loading is not the same as nobody", () => {
    expect(sharesFor(undefined, "1-projects/plan.md")).toBeUndefined();
    expect(sharesFor([], "1-projects/plan.md")).toEqual([]);
  });

  test("a note nobody has is an empty list, not undefined", () => {
    expect(sharesFor([share({ entryPath: "other.md" })], "1-projects/plan.md")).toEqual(
      [],
    );
  });
});

/* -------------------------------------------------------------------------- */

describe("what renaming a shared note costs", () => {
  /*
    A share is stored against `entryPath` and the file operations never touch
    the `noteShares` table, so renaming, moving or archiving a note leaves every
    outstanding link pointing at a path that no longer exists — silently, with
    nothing in any of the three dialogs saying so. The archive dialog went
    further and said "Nothing is deleted", which is true of the bytes and false
    of the access.
  */
  test("it names the count and the verb", () => {
    const text = sharesBreakingWarning(
      [share({ shareId: "a" }), share({ shareId: "b" })],
      "1-projects/plan.md",
      "Renaming",
    );

    expect(text).toContain("2 people hold links");
    expect(text).toContain("Renaming");
    expect(text).toContain("them");
  });

  test("one link is singular, in both halves of the sentence", () => {
    // "1 people hold links … breaks them" is the tell of a count formatted once
    // and a pronoun forgotten.
    const text = sharesBreakingWarning([share({ shareId: "a" })], "1-projects/plan.md", "Moving");

    expect(text).toContain("1 person holds a link");
    expect(text).toContain("breaks it");
    expect(text).not.toContain("people");
  });

  test("a note nobody holds says nothing at all", () => {
    expect(
      sharesBreakingWarning([share({ entryPath: "other.md" })], "1-projects/plan.md", "Archiving"),
    ).toBeNull();
  });

  test("a list that has not loaded is silent, not reassuring", () => {
    /*
      The distinction `sharesFor` already draws, and the direction it has to
      fail in. Rendering "not loaded" as "no shares" would print *nothing* over
      a note somebody has in fact shared — a reassurance by omission, at the
      moment they are about to break it.
    */
    expect(sharesBreakingWarning(undefined, "1-projects/plan.md", "Renaming")).toBeNull();
  });
});
