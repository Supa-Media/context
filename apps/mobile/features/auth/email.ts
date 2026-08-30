/**
 * The one place an address is normalized before it reaches auth.
 *
 * ## Why this exists, and why it is not cosmetic
 *
 * Invitations lowercase the address they are addressed to — `parseInvitee` in
 * `apps/convex/functions/lib/invitees.ts` — because an invitation has to match
 * an account by string equality later, and `@name` and email invitees are
 * looked up in indexes that are byte-exact.
 *
 * Nothing on the sign-in side used to do the same. `@convex-dev/auth` performs
 * no normalization of its own, and `createSupaAuth`'s `createOrUpdateUser`
 * stores `profile.email` verbatim, so signing in as `Ada@Example.com` wrote a
 * `users` row whose `email` is `Ada@Example.com`.
 *
 * The two halves then disagree, and the consequence is not a cosmetic
 * duplicate:
 *
 *  - `shouldMintSignInCode` looks the invitee up by the **lowercased** address
 *    and finds nothing, so it decides this is a stranger with no account and
 *    mints a sign-in link — the exact case the "never mail an auto-sign-in
 *    link to somebody already using Context" rule exists to prevent.
 *  - Minting creates a **second** `users` row, verified and active. One person,
 *    two accounts.
 *  - `listMyInvitations` resolves to the lowercase row, so the invitation is
 *    invisible from the account the person actually signs in to.
 *  - The link signs them into the empty duplicate, which can accept — so they
 *    join somebody's context as an identity that is not theirs.
 *
 * `autoCapitalize="none"` on the input does not cover this: it constrains
 * typing, not paste, autofill, or a password manager.
 *
 * ## What this does and does not fix
 *
 * It closes the only path in the product that creates a mixed-case account.
 * The durable fix belongs upstream, in `createSupaAuth`'s `createOrUpdateUser`,
 * so that a caller reaching the API directly cannot create one either — this
 * repository's rule is upstream-first, and that change is filed separately.
 * Rows created before this landed are unaffected and need a data check.
 *
 * ## The rule itself lives in `packages/shared`, and this is an ALIAS for it
 *
 * `normalizeSignInEmail` is the sign-in side's *name* for the rule — kept
 * because that is what `LoginScreen` calls and because the reasoning above is
 * about this screen. It is a re-export rather than a one-line wrapper, and that
 * is the whole guard: `normalizeSignInEmail === normalizeEmail` is checkable by
 * identity, so replacing it with a function — even one spelled
 * `raw.trim().toLowerCase()`, which is what the rule does *today* — fails a
 * test immediately rather than at some later point when the two have drifted.
 *
 * That matters because a behavioural test cannot see the difference. Measured
 * before the identity check existed: re-inlining the identical chain here left
 * **every** check in both suites green — zero failures either side. With the
 * check, it fails one. (Failure counts rather than suite totals, throughout:
 * a total is somebody else's merge away from being stale, and one in this
 * change already went stale that way.) Duplication is the defect this
 * move exists to remove; waiting for it to *become* a divergence is waiting for
 * the bug.
 *
 * `parseInvitee` cannot be pinned the same way — it calls `normalizeEmail`
 * inside a larger parse, so there is no identity to compare. **An earlier
 * version of this comment said its half was "held behaviourally, by the table
 * in `invitations.test.ts`", four lines after saying a behavioural test cannot
 * see the difference. Both cannot be true, and the measurement says which:**
 * re-inlining `trimmed.toLowerCase()` there failed nothing, in either suite.
 * `apps/convex/__tests__/sharedEmailRule.test.ts` is what holds it now, by
 * asserting the *call* rather than the value — the standing question is "does
 * anything test that it is CALLED?", and for that half nothing did.
 *
 * Two ways this identity could stop meaning what it means here, neither live:
 * `packages/shared/tsconfig.json` declares an `outDir`, so pointing `main` at a
 * build while jest and Metro still resolve `src` would make the two importers
 * different module instances; and `jest.config.js` resolves `web.ts` ahead of
 * `ts`, so a future `email.web.ts` would have the check assert about a file the
 * native app does not use.
 *
 * Why the whole address is lowercased, RFC 5321 notwithstanding, is argued
 * where the rule now lives.
 */
export { normalizeEmail as normalizeSignInEmail } from "@context/shared";
