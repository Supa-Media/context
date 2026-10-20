import { describe, expect, test } from "@jest/globals";
import { domainBandKind, domainBandOffer, readOnlyReasonFor } from "../features/share/domainBand";
import type { SharedNote } from "../features/share/share";

/**
 * The shared link's band when the note's workspace is open to an email domain
 * (Dev, 2026-10-20). It names the domain and never the workspace; signed out
 * it carries the sign-in, signed in at another address it offers to add one,
 * and a reader the server gave a slug never sees it (the page sends them in).
 */

const EDITS = { domain: "publicworship.life", canEdit: true, joinSlug: null };
const READS = { domain: "publicworship.life", canEdit: false, joinSlug: null };

function note(domainAccess: SharedNote["domainAccess"], openToAnyone = true): SharedNote {
  return {
    path: "1-projects/onboarding/prep.md",
    text: "# Prep\n",
    kind: "note",
    entries: [],
    entryPath: "1-projects/onboarding/prep.md",
    links: [],
    openToAnyone,
    collecting: false,
    editableInContext: null,
    domainAccess,
  };
}

const noop = { signIn: () => {}, addEmail: () => {}, switchAccount: () => {} };

describe("the band's sentence", () => {
  test("signed out, it invites the domain's email to edit", () => {
    expect(readOnlyReasonFor(note(EDITS))).toBe(
      "You can read this. Sign in with your @publicworship.life email to edit it.",
    );
  });

  test("signed out, a domain that only reads invites joining, without naming the workspace", () => {
    expect(readOnlyReasonFor(note(READS))).toBe(
      "You can read this. Sign in with your @publicworship.life email to join this workspace.",
    );
  });

  test("signed in elsewhere, it says which address and what to add", () => {
    expect(readOnlyReasonFor(note(EDITS), true, "ada@gmail.com")).toBe(
      "You're signed in as ada@gmail.com. To edit, add your @publicworship.life email to your account.",
    );
  });

  test("with no domain, the sentence is today's", () => {
    expect(readOnlyReasonFor(note(null))).toBe(
      "You're reading a shared link. Only people in this workspace can change it.",
    );
    expect(readOnlyReasonFor(note(null, false), true, "ada@gmail.com")).toBe("This was shared with you to read.");
  });
});

describe("the band's buttons", () => {
  test("signed out: one sign-in, and the top-left pill stands down", () => {
    const offer = domainBandOffer(domainBandKind(EDITS, false), noop);
    expect(offer?.signInInBand).toBe(true);
    expect(offer?.actions.map((action) => action.label)).toEqual(["Sign in to edit"]);
    expect(domainBandOffer(domainBandKind(READS, false), noop)?.actions[0]?.label).toBe("Sign in to join");
  });

  test("signed in elsewhere: Add email, and a quiet other account", () => {
    const offer = domainBandOffer(domainBandKind(EDITS, true), noop);
    expect(offer?.signInInBand).toBe(false);
    expect(offer?.actions.map((action) => [action.label, action.quiet === true])).toEqual([
      ["Add email", false],
      ["Use another account", true],
    ]);
  });

  test("no band at all for a reader the server is sending in, or a link with no domain", () => {
    expect(domainBandKind({ ...EDITS, joinSlug: "pw" }, true)).toBeNull();
    expect(domainBandKind(null, false)).toBeNull();
    expect(domainBandOffer(null, noop)).toBeNull();
  });
});
