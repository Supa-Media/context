import { describe, expect, test } from "@jest/globals";
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
 */
describe("the address that reaches auth", () => {
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
