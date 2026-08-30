/**
 * The one definition of what it means to normalize an email address here.
 *
 * ## Why this is in `packages/shared` and not in either app
 *
 * Two call sites have to agree about this, and they live in different packages:
 *
 *  - `parseInvitee` (`apps/convex/functions/lib/invitees.ts`) normalizes the
 *    address an invitation or a share is addressed to, because both are matched
 *    to an account later by **byte-exact index lookup**.
 *  - `normalizeSignInEmail` (`apps/mobile/features/auth/email.ts`) normalizes
 *    the address a person signs in with, because `@convex-dev/auth` performs no
 *    normalization of its own and `createOrUpdateUser` stores `profile.email`
 *    verbatim.
 *
 * When those two disagree, the failure is not a cosmetic duplicate. Signing in
 * as `Ada@Example.com` writes a `users` row spelled that way;
 * `shouldMintSignInCode` then looks the invitee up **lowercased**, finds
 * nothing, concludes this is a stranger with no account, and mails an
 * auto-sign-in link — the exact case that rule exists to prevent. The link
 * signs them into a second, empty, verified account, which can accept the
 * invitation. One person, two accounts, and they join somebody's context as an
 * identity that is not theirs.
 *
 * The two halves used to be two `.trim().toLowerCase()` chains and an assertion
 * in each package that the other one matched. That is two copies of a rule with
 * a test each, which is what `parseInvitee` and `normalizeSignInEmail` already
 * were before those tests existed — the same shape one level up. One function
 * both import cannot drift, and `packages/shared/**` is in the `mobile` **and**
 * `convex` change filters of the reusable CI pipeline, so a change here runs
 * both suites rather than neither. That was read at source in
 * `Supa-Media/supa-framework/.github/workflows/ci.yml` on 2026-08-30 rather
 * than assumed — a CI fact has a timestamp, and this one lives in somebody
 * else's repository, so re-read it before relying on it again. (The pipeline
 * also defines a `shared` filter and a `Test Shared Package` job, but that job
 * is gated on a `shared-package` input this repository's `ci.yml` does not
 * pass, so it can never run. Filed separately; it is why the tests for this
 * rule live in the two app suites rather than beside it here.)
 *
 * ## Lowercasing the whole address is deliberate
 *
 * RFC 5321 makes only the domain case-insensitive, so a mailbox may in
 * principle distinguish `Ada` from `ada` — but every provider that matters
 * folds case, and treating them as two people is by far the worse of the two
 * failures, being the one above.
 *
 * This is normalization only. It says nothing about whether the result is a
 * usable address: `parseInvitee` applies `EMAIL_PATTERN` and
 * `MAX_EMAIL_LENGTH` after calling this, and the sign-in screen does not —
 * which is a real asymmetry, recorded separately, and deliberately not papered
 * over by widening this function's job.
 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}
