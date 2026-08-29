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
 * The same assertion exists in `apps/convex/__tests__/invitations.test.ts`,
 * and **that copy is the one CI depends on.** It runs on every pull request,
 * whatever it touches, because `gateway-contracts.yml` carries no `paths`
 * filter and runs the whole control-plane suite — so it catches either side
 * drifting, in both directions.
 *
 * This copy is therefore **redundant for CI, and kept for speed**: somebody
 * changing `normalizeSignInEmail` sees it fail in `jest` in under a second
 * without running the control plane's suite. That is worth eight lines; it is
 * not worth a claim it does not support.
 *
 * (An earlier version of this note said the two copies each closed a direction
 * nothing else closed, citing a measurement that `ci / Test Convex Backend` is
 * skipped on mobile-only pull requests. That measurement was real and is still
 * true of *that* job — and it was taken five hours before
 * `gateway-contracts.yml` existed, which is the thing that makes the convex
 * copy universal. **A CI fact measured yesterday is not a CI fact.**)
 *
 * **What is asserted is narrower than the sentence above**, and deliberately:
 * the table covers addresses `parseInvitee` *accepts*, where the two agree by
 * construction. Outside it they genuinely diverge — `parseInvitee` refuses an
 * over-length or pattern-failing address that `normalizeSignInEmail` will
 * happily normalise — so this is a drift detector, not a proof of the
 * invariant.
 */
describe("the address that reaches auth", () => {
  // The mirror, asserted. See the note above on why this is duplicated in the
  // control plane's suite rather than living in one place.
  test.each([
    "LK@Example.Invalid",
    "  lk@example.invalid  ",
    "MiXeD.CaSe+tag@Example.Invalid",
    "\tada@example.invalid\n",
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
