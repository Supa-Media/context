# Communications — how a mailbox recovers

### A mailbox recovers by itself unless the person has to give a permission

Owner, 2026-10-20: "the user shouldn't have to even deal with this unless they
have to give a new permission." Four ways a connected mailbox used to stop, or
tell its owner to reconnect, over something that was never theirs to fix:

- **A refresh Google did not answer is not a reconnect.** A 5xx, 429, timeout
  or garbled answer from the token endpoint is `GOOGLE_UNAVAILABLE`, on the
  product's own transient ladder with the account healthy; only
  `invalid_grant` is `GOOGLE_RECONNECT_REQUIRED`
  (`mintGoogleAccessTokenOutcome`). A 401 from any product drops the cached
  access token so the next mint refreshes; on Calendar and Chat it is
  `GOOGLE_TOKEN_REJECTED`, also transient (Gmail's own classification is
  unchanged here). A Calendar or Chat 403 is a refusal only when
  Google's reason does not say rate limit, as Gmail's already was. Collapsing
  these into one code again puts a Google outage on the account's 15m-6h
  ladder with "Reconnect" on the card. Test:
  `apps/convex/__tests__/googleSyncLoop/recovery.test.ts`.
- **A revoked grant is asked about again daily.** `reconnect_required` used to
  clear only on a fresh connect, so one spurious `invalid_grant` stopped a
  mailbox for good. `functions/googleReconnect.ts` forces one refresh a day for
  each row whose cause is a refused grant (`REFRESHABLE_RECONNECT_CODES`), and
  a refresh that works clears the flag and makes the row due. Never
  `SCOPES_INCOMPLETE` (a permission only the person can give) and never a
  disconnected row. A failed pass keeps the row's cause instead of writing its
  own code over it, which is what the daily check looks for. Test:
  `apps/convex/__tests__/googleSyncLoop/reconnectRecheck.test.ts`.
- **The write quota counts growth.** `writeDayPart` reports what a write added
  (new size less what it replaced, never below zero), not the note's whole
  size: today's note is rewritten on every pass that brings mail, and the
  lifetime `quotaBytes` was spent on the same bytes until Gmail stopped with
  `MAIL_QUOTA_EXCEEDED` for good. Growth rather than a monthly reset, because
  a busy month's rewrites would still stop a mailbox. Counters from before (no
  `syncBytesBasis`) restart at zero: an undercount keeps a mailbox working, an
  overcount stopped it. Test:
  `apps/convex/__tests__/googleSyncLoop/quotaGrowth.test.ts`.
- **An empty history id is no cursor.** `getProfileHistoryId` answers `""`
  when Google gives none; the pass takes a baseline for an empty cursor and
  stores none rather than `""`, which `history.list` refuses on every pass.
  Test: `recovery.test.ts`.
