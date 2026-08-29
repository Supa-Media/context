import { describe, expect, test } from "@jest/globals";
import { parseInvitee } from "@context/convex/functions/lib/invitees";

import { normalizeSignInEmail } from "../features/auth/email";

/**
 * The invariant these all serve: whatever a person types, pastes, or lets a
 * password manager fill, the address handed to `signIn` must be the same string
 * an invitation to them would have been addressed to. `parseInvitee` in
 * `apps/convex/functions/lib/invitees.ts` trims and lowercases; so does this.
 *
 * When they disagree, one human ends up with two accounts and the invitation
 * lands on the one they cannot sign in to — see the block comment on
 * `normalizeSignInEmail` for the full chain.
 *
 * **That last sentence used to be the whole of it: a two-package invariant
 * named in prose, with only this side imported.** Both halves were pinned to
 * their own literals and neither to the other, which is what `CLAUDE.md` means
 * when it insists a mirror be "asserted against the control plane's rather
 * than claimed in a comment".
 *
 * The same assertion now exists in `apps/convex/__tests__/invitations.test.ts`,
 * and **the duplication is deliberate, because of which CI job runs when.**
 * Measured: `ci / Test Convex Backend` is skipped on mobile-only pull requests
 * and `ci / Test Mobile App` is skipped on convex-only ones. One copy therefore
 * closes one direction only — the copy here catches this side drifting, the
 * copy there catches `parseInvitee` drifting. Neither is redundant until a
 * cross-package job runs both, which is the open row this pair works around.
 */
describe("the address that reaches auth", () => {
  // The mirror, asserted. See the note above on why this is duplicated in the
  // control plane's suite rather than living in one place.
  test.each([
    "LK@Example.Invalid",
    "  lk@example.invalid  ",
    "MiXeD.CaSe+tag@Example.Invalid",
    "ALLCAPS@EXAMPLE.INVALID",
  ])("agrees with the invitee parser on %j", (raw) => {
    const parsed = parseInvitee(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.invitee.kind !== "email") {
      throw new Error("fixture is not an email address");
    }
    expect(normalizeSignInEmail(raw)).toBe(parsed.invitee.value);
  });

  test("matches what an invitation to the same person is addressed to", () => {
    // The exact pair that breaks: an invitation is stored lowercase, so a
    // mixed-case account is invisible to the lookup that decides whether to
    // mint a sign-in link.
    expect(normalizeSignInEmail("Ada@Example.invalid")).toBe(
      "ada@example.invalid",
    );
  });

  test("survives a pasted address with surrounding whitespace", () => {
    // `autoCapitalize="none"` constrains typing and nothing else; paste and
    // autofill are how a capital letter actually gets in.
    expect(normalizeSignInEmail("  Ada@Example.invalid \n")).toBe(
      "ada@example.invalid",
    );
  });

  test("lowercases the local part too, not only the domain", () => {
    // RFC 5321 makes only the domain case-insensitive, so this is a choice:
    // treating `Ada` and `ada` as two people is the worse failure.
    expect(normalizeSignInEmail("ADA@example.invalid")).toBe(
      "ada@example.invalid",
    );
  });

  test("leaves an already-normal address exactly as it is", () => {
    expect(normalizeSignInEmail("ada@example.invalid")).toBe(
      "ada@example.invalid",
    );
  });
});
