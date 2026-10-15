# Identity and access — account safety

### Email guards the big changes; a phone alone never takes an account

Decided by the owner, 2026-10-12 (boards k1–k4). People sign in with their
phone, and texting the assistant is authenticated by the number. That makes a
SIM swap, or a moment with someone's unlocked phone, worth an account unless
something else stands behind the changes that matter. Our rule is that one of
the account's confirmed emails stands behind them:

- **Check it's you.** A big change needs an emailed code confirmed on *this
  sign-in* within the last 15 minutes (`EMAIL_PROOF_WINDOW_MS`,
  `functions/lib/emailProof.ts`). The proof belongs to one auth session, so a
  second device signed in by phone gains nothing from the first one's code. A
  session that has been signed out stops counting at once.
- **What is big:** changing the phone or linking another texting number;
  adding a second email, removing one, or moving mail to another; pointing
  existing storage elsewhere (own bucket, Dropbox, Cloudflare, storage moves
  and the managed hand-off); disconnecting storage; exporting encryption keys;
  approving an AI connection, a machine or a plugin; deleting a workspace or
  the account; signing other devices out; turning phone sign-in back on; and
  stopping a waiting new email.
- **What is not:** reading and editing notes, the first email and the first
  phone (nothing to protect yet), and **Download everything**. The export is
  the client reading notes it can already read, so gating it would mean gating
  reading; and non-negotiable #1 says the exit is never gated. Taking a copy is
  not taking the account.

The server refuses with `EMAIL_PROOF_REQUIRED`; the app's Convex client opens
the one dialog and retries the call once (`features/account/emailProofGate.ts`).
Every guarded mutation refuses before it writes, and every guarded action asks
before it does anything, so the retry is safe.

### A texted code never joins an account that has an email

The phone check's join (2026-10-09, "one person, one account") let a new
email account that typed a held number fold into the holder, its email and
all. With a stolen number that is a takeover: the thief's own email lands on
the victim's account and from then on passes every email check. So a join now
happens only when the holder has no confirmed email yet; otherwise the answer
is `has_account` and the person signs in with the phone and adds the email on
Account settings, where the account's own email is asked first
(`lib/account/phoneJoin.ts`, `__tests__/phoneCheck.test.ts`).

### Every phone sign-in is mailed, and "This wasn't me" pauses the phone

Each phone sign-in mails every confirmed email with the time and the number's
last four digits (the sign-in provider gives us no IP or device, so we do not
pretend to show one). The mail carries a single-use link, valid seven days,
whose token is stored only as a hash. Pressing "This wasn't me" on that page
signs every device out, unlinks texting, and pauses phone sign-in: the number
cannot sign in, is texted nothing, and the assistant does not answer it until
someone who passed an email code turns it back on (`functions/signInAlerts.ts`).

### Lost every email: a new one waits seven days, and nothing shortens it

Someone with only their phone can add a new email, after proving the new
address with its own code. It is added after **seven days**; every current
email is told at once and again a day before, and each mail carries a link that
stops it (`functions/emailRecovery.ts`). There is no faster path and no staff
override: a shorter wait is the window a SIM swapper needs. Stopping it from
the app needs an email code, so the phone alone cannot cancel its own attacker's
cancellation either way round.

### What this does not close

A signed-out device's access token can live up to about an hour for ordinary
reads and writes; every big change is refused from it immediately, because
proof checks require the session row to exist. Staff typing a phone in the
admin People tab is unchanged: staff vouch for people they know.

Simplifying any of this to "a confirmed phone is enough" hands the account to
whoever holds the number. `__tests__/emailProof.test.ts` drives every guarded
entry point from a phone-only session and fails if one goes through;
`__tests__/phoneChange.test.ts`, `signInAlerts.test.ts` and
`emailRecovery.test.ts` fail if the phone moves, the pause lifts, or the wait
shortens without an email.
