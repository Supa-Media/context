# The staff console takes a second factor: an authenticator code per session (2026-10-28)

_Part of [Identity and access](../identity-and-access.md)._

### The staff console takes a second factor: an authenticator code per session

The staff console reads across every tenant and writes the platform's own
credentials. Signing in to it took one email code, which is one factor:
whoever reads that mailbox. A second email code would be the same factor
again, so the second factor is a time-based code from an authenticator app
(RFC 6238: SHA-1, 30 seconds, six digits, one step of drift).

**Where it is checked.** `requireAdmin` (`functions/lib/admin.ts`), which
every staff function already reaches, now asks `lib/staffFactor.ts` for the
account's standing after the allowlist. Only the second factor's own
enrollment and code checks (`functions/staffSecondFactor.ts`) stop at the
first factor (`requireStaffIdentity`), because they are the way in.

**Per session.** A code opens the staff pages for the session that typed it,
for twelve hours. It is a row keyed by the live `authSessions` id, so signing
out, or the session expiring, ends it; another device signed in with the same
email code gets nothing from it.

**No stored key.** The authenticator key is derived from the deployment's
storage key, the account and a per-enrollment nonce (an HMAC, as
`lib/guestPhones.ts` derives its key), so no table, log or backup holds it.
It is shown only to the session that started enrolling, and only until that
session types a code from it. Rotating the storage key changes every key, so
staff re-enroll after a rotation.

**Guessing.** A code is taken once (the newest step used is kept). Five wrong
codes in fifteen minutes make the account wait out the window, the right code
included. A wrong code is answered rather than thrown, so the count commits.

**Rollout, so nobody is locked out by a deploy.**

1. Ship with `STAFF_SECOND_FACTOR` unset. Staff keep working; the console
   offers "Set up" above every page.
2. Each staff member enrolls. From that moment their own sessions always
   owe a code, whatever the deployment says: enrolling binds only the person
   who just proved they hold the key.
3. `npx convex run functions/staffSecondFactor:census` reports
   `{allowlisted, accounts, enrolled, required}`, counts only. When
   `enrolled` equals `accounts` (the owner included), set
   `STAFF_SECOND_FACTOR=required`. Staff without a key can then only enroll.

An enrolled account swaps its key only from a session that already typed a
code, so a stolen email code cannot replace the key with the thief's. The
current key stays in force until the replacement is confirmed by a code from
it, typed in the session that started it, so a swap never leaves a gap.

**A lost authenticator** is a deploy-time act, like `ADMIN_EMAILS` itself:
`npx convex run functions/staffSecondFactor:resetForEmail '{"email": "..."}'`
by somebody holding the deploy key. Nothing the console runs can remove a
factor.

The App Store and Google reviewer accounts are not staff and are untouched.

What reversing this costs: one stolen email code is the whole staff console
again (CASA 3.3.1). The tests that fail are in
`apps/convex/__tests__/staffSecondFactor.test.ts` ("an enrolled account's new
session owes a code", "a code is taken once", "only the session that started
enrolling is shown the key", "five wrong codes make the account wait").
