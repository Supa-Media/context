import { describe, expect, test } from "@jest/globals";
import { normalizeEmail } from "@context/shared";

import { normalizeSignInEmail } from "../features/auth/email";

/**
 * The invariant these all serve: whatever a person types, pastes, or lets a
 * password manager fill, the address handed to `signIn` must be the same string
 * an invitation to them would have been addressed to. When they disagree, one
 * human ends up with two accounts and the invitation lands on the one they
 * cannot sign in to — see the block comment on `normalizeSignInEmail` for the
 * full chain.
 *
 * **That used to be a two-package invariant named in prose, then a fixture
 * table duplicated in two packages.** Both halves were pinned to their own
 * literals and neither to the other; the duplicate tables then drifted inside
 * their own commits, one shipping four rows against five. Both sides now call
 * `normalizeEmail` from `packages/shared`, so over the domain `parseInvitee`
 * accepts they agree by construction, and the table is gone from here rather
 * than kept in sync by hand.
 *
 * **This file no longer imports the control plane**, which is the point of the
 * move: a rule with a copy on each side of a package boundary is a rule that
 * will drift, and a reusable pipeline's path filters cannot see a cross-package
 * import, so the tests that would catch the drift are skipped on exactly the
 * changes that cause it.
 *
 * **The first check below is the one that closes the duplication rather than
 * its symptom.** No behavioural assertion can see a behaviourally identical
 * copy: measured with that check removed, re-inlining `raw.trim().toLowerCase()`
 * into `normalizeSignInEmail` left **every** check green — zero failures here
 * and zero in the control plane. So `email.ts` re-exports the shared rule under its own
 * name and this asserts the two are the same function object; the same
 * re-inline now fails here, and only here.
 *
 * The rest is the sign-in side's behaviour, which is worth keeping beside the
 * alias: they are what says *what* the shared rule has to do for this screen,
 * and they fail if the shared rule changes under it. Drift between the two
 * implementations is caught by `apps/convex/__tests__/invitations.test.ts`,
 * which compares this function against `parseInvitee` and runs on every pull
 * request into `main` via `gateway-contracts.yml`.
 */
describe("the address that reaches auth", () => {
  test("is the shared rule itself, not a second copy of it", () => {
    // Identity, not behaviour. `toBe` on a function object is what makes a
    // re-inlined `raw.trim().toLowerCase()` fail here — every assertion after
    // this one would still pass with such a copy in place.
    expect(normalizeSignInEmail).toBe(normalizeEmail);
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
