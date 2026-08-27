import { describe, expect, test } from "@jest/globals";
import {
  shareBackSuggestions,
  sharedWithYou,
  type MembersView,
} from "../features/console/members/members";

/**
 * The reciprocity list in the invite box.
 *
 * Somebody who arrived here through an invitation knows exactly one person who
 * is already on Context, and it is the person who invited them. That makes
 * "share back" the highest-converting invitation available and the only one
 * that needs no address book, no contact upload and no directory — so the one
 * thing this must never do is invent a name that is not already in front of
 * the caller.
 *
 * Two ways it could: by suggesting somebody from a context whose slug does not
 * address a person, and by leaking a handle the caller could not otherwise
 * enumerate. Both are covered below. The derivation reads only the context
 * list the console already holds — no new query — which is sound *because*
 * every personal context has exactly one owner and its slug is that owner's
 * handle. If ownership ever becomes transferable this file should fail.
 */

const EMPTY_VIEW: MembersView = {
  members: [],
  invitations: [],
  loading: false,
  failure: null,
};

function view(overrides: Partial<MembersView>): MembersView {
  return { ...EMPTY_VIEW, ...overrides };
}

describe("who counts as somebody who shared with you", () => {
  test("a personal context you are a member of names its owner", () => {
    // `@seyi` is not merely the context's address — it is the handle of the one
    // person who owns it, which is what makes it a person you can invite back.
    expect(
      sharedWithYou([{ slug: "seyi", role: "member", kind: "personal" }]),
    ).toEqual(["seyi"]);
  });

  test("so does one you can edit — write access is still somebody else's context", () => {
    expect(
      sharedWithYou([{ slug: "seyi", role: "editor", kind: "personal" }]),
    ).toEqual(["seyi"]);
  });

  test("your own context is not somebody who shared with you", () => {
    expect(sharedWithYou([{ slug: "lk", role: "owner", kind: "personal" }])).toEqual([]);
  });

  test("a shared context names a place, not a person, so it is excluded", () => {
    // A shared context has no single personal owner. Suggesting its slug would
    // offer to invite a workspace, and `@name` addressing only resolves to a
    // person through the sole-owner invariant.
    expect(
      sharedWithYou([{ slug: "ignite", role: "member", kind: "shared" }]),
    ).toEqual([]);
  });
});

describe("suggesting only people who are not already here", () => {
  test("somebody already in this context is not suggested", () => {
    // Inviting an existing member is a no-op in the control plane rather than
    // an error, so this would not break — it would offer a button that does
    // nothing visible, which is worse than not offering it.
    const suggestions = shareBackSuggestions(
      [{ slug: "seyi", role: "member", kind: "personal" }],
      view({
        members: [
          { userId: "u1", role: "member", name: "@seyi", joinedAt: 0, isMe: false },
        ],
      }),
    );
    expect(suggestions).toEqual([]);
  });

  test("nor is somebody with an invitation already outstanding", () => {
    const suggestions = shareBackSuggestions(
      [{ slug: "seyi", role: "member", kind: "personal" }],
      view({
        invitations: [
          { invitationId: "i1", invitee: "@seyi", role: "member", expiresAt: 0 },
        ],
      }),
    );
    expect(suggestions).toEqual([]);
  });

  test("the comparison ignores the @ and the case, because the field does too", () => {
    const suggestions = shareBackSuggestions(
      [{ slug: "seyi", role: "member", kind: "personal" }],
      view({
        members: [{ userId: "u1", role: "member", name: "SEYI", joinedAt: 0, isMe: false }],
      }),
    );
    expect(suggestions).toEqual([]);
  });

  test("a member identified only by email never suppresses a handle", () => {
    // `name` is optional on a member who has not claimed one. Reading it
    // unguarded threw; treating an address as a handle would suppress the
    // wrong suggestion.
    const suggestions = shareBackSuggestions(
      [{ slug: "seyi", role: "member", kind: "personal" }],
      view({
        members: [
          { userId: "u1", role: "member", email: "seyi@example.invalid", joinedAt: 0, isMe: false },
        ],
      }),
    );
    expect(suggestions).toEqual(["seyi"]);
  });

  test("several people who shared with you are all offered", () => {
    expect(
      shareBackSuggestions(
        [
          { slug: "seyi", role: "member", kind: "personal" },
          { slug: "lk", role: "owner", kind: "personal" },
          { slug: "ada", role: "editor", kind: "personal" },
        ],
        EMPTY_VIEW,
      ),
    ).toEqual(["seyi", "ada"]);
  });

  test("an account that was never shared with is offered nobody", () => {
    // The plain invite box, with no suggestion row at all. A brand-new owner
    // who came in through the front door has no reciprocity list, and an empty
    // heading over nothing is worse than no heading.
    expect(
      shareBackSuggestions([{ slug: "lk", role: "owner", kind: "personal" }], EMPTY_VIEW),
    ).toEqual([]);
  });
});
