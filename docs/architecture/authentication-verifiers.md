# Authentication verifier storage and lifecycle

Context authenticates people with one-time codes and links. It has no
user-selected password database. The controls below also apply to issued
reviewer and test-account codes; those accounts have no fixed-code exception.

## Storage and verification

1. The server generates a random code or token and delivers it through the
   appropriate email, phone or invitation flow. The code is not logged.
2. Before writing a short code, the server computes
   `HMAC-SHA256(K, "context-one-time-code:v1:" + purpose + ":" + value)`.
   `K` is `AUTH_CODE_HASH_KEY` when set, otherwise `JWT_PRIVATE_KEY`. The key
   comes from deployment environment secrets and is not stored in a code row.
   If neither key exists, issuance fails rather than using a plain digest.
3. The database holds the MAC, identity binding, expiry and lifecycle metadata.
   Each store has a distinct purpose. Issued reviewer values also include the
   provider and address; phone values include the phone identity.
4. Verification recomputes the MAC of the supplied value with the server's
   key. A database copy alone cannot verify guesses without that key. Sending
   the stored MAC as the code does not bypass this step: it is hashed as a new
   supplied value. The stored MAC is not a bearer credential.
5. Successful verification consumes the code transactionally. A replacement
   invalidates the old code. Expired verifiers are refused.

The shared helper is `apps/convex/functions/lib/oneTimeCodes.ts`. It covers
phone codes, text sign-in and text-link codes, email proof, add-email and
recovery codes. The patched `hashVerificationCode` in
`patches/@convex-dev__auth.patch` uses the same construction for the auth
library's email, issued reviewer and OAuth verification codes.

## Threat model and compatibility

This protects against offline recovery from a stolen verifier table or
database backup without the deployment secrets. It does not claim protection
after both the table and the server's secret key are compromised. Key access
must remain separate from database read access. No key or active verifier
belongs in an assessment attachment, log or database screenshot.

There is a narrow migration path for invitation links issued before keyed
hashing: only `magic-link` rows and supplied tokens at least 32 characters long
can be checked by their old SHA-256 digest. Those links were generated with
about 190 bits of randomness and retain their original expiry and single-use
checks. Short OTPs cannot use this fallback. It is planned for removal after
the last old invitation expires, after November 19, 2026.

## Expiry and guessing limits

- Ordinary email and phone codes last ten minutes. Email checks are limited
  to ten failed attempts per address per hour. Phone codes allow five wrong
  attempts per code and ten checks per phone per hour.
- Staff-issued reviewer, CUJ and staging-persona codes last ten minutes. They
  have ten wrong attempts per issued code plus the ordinary hourly limit.
  Starting a public reviewer sign-in issues nothing and replaces nothing.
- Before verifying an issued code, `beforeVerification` caps its age at ten
  minutes from its original issue time. This also bounds pre-existing rows
  written with the retired multi-day expiry. Missing issued-provider lifecycle
  records fail closed.
- The retired reviewer phone alias accepts no code. `DEV_OTP_BYPASS`, the
  retired fixed-code variables and the former `TEST_OTP_*` patch do not grant
  access on any deployment.
- Invitation and text-link lifetimes are separate from the short code they
  issue. Their own single-use and expiry checks remain in force; this document
  does not describe every link as a ten-minute OTP.

## Implementation evidence

`oneTimeCodes.test.ts` proves key dependence, purpose separation, rejection
without a key, and a stored value distinct from plain SHA-256. The integration
suite `issuedSignInCodes.test.ts` drives the patched auth library through the
public sign-in action and checks stored keyed hashes, identity binding,
single use, replacement, expiry, attempt exhaustion, old-code rejection and
the narrow invitation migration path. `phoneSignIn.test.ts`,
`reviewerAccount.test.ts` and `otpBypass.test.ts` cover the removed bypasses.

Deployment records establish which implementation is live. Test results and
deployment success support an assessment response; they do not themselves
constitute acceptance by an assessment lab.
