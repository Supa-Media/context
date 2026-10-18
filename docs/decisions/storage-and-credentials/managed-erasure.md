# Managed erasure

## Deleting an account erases the storage we ran for it

Decided by the owner, 2026-10-15, for the App Store release (Apple 5.1.1(v):
an app that lets people create an account must let them delete it, data
included).

**What.** When an account is deleted, every workspace it solely owns is
deleted with it (`account.deleteAccount`, unchanged). Where such a workspace's
notes live in a bucket **we** created for it (`managedBucketName(workspaceId)`),
its notes and attachments are now permanently erased and the bucket's scoped
token revoked. A bucket the customer owns is still never touched, and a
workspace with another owner is not deleted, so its bucket stays.

**Why.** Once the binding row is gone nobody can reach a managed bucket: the
customer never held its credential. Keeping it would mean holding someone's
notes after they asked us to delete them, with no way for them to get them
back. Before this, the privacy policy told people to email us for that; the
App Store review asks for it in the app.

**The exit comes first.** Non-negotiable #1 is "can always leave with it", so
the delete card names each workspace it erases and offers its download before
the second press (`DeleteAccountCard`, fed by `accountDeletion.deletionPreview`,
which uses the same sole-owner check as the deletion). The general warning
says storage we run is erased even before that list loads.

**How it cannot lose the bucket.** The workspace cascade writes a
`managedErasures` row in the same transaction that deletes the binding (and
any move into storage we run, which names a second managed bucket). The row
holds a workspace id, the bucket name and the token's id; no credential and no
content. `functions/managedErasure.ts` then:

- claims the row with a 15-minute lease;
- re-derives the bucket name from the workspace id and refuses (status
  `refused`, nothing deleted) a row naming any other bucket;
- revokes the token **only** if Cloudflare names it `scopedTokenName(bucket)`,
  so a wrong id never revokes an operator's or another bucket's token;
- deletes up to five pages of up to 1,000 objects per run, then the empty
  bucket, re-listing from the start each page;
- treats a 404 as already gone, so a retry after a partial success finishes;
- records every outcome; a failure keeps the row pending with a closed-set
  error code and retries with backoff (one minute doubling, at most six hours),
  forever;
- a cron every 15 minutes re-runs any due row whose lease lapsed, covering a
  run that died before recording.

The token goes before the objects: its secret half was already deleted with
the binding, and revoking it closes the only way new objects could arrive
while the bucket is emptied. The two steps are independent, so one failing
never holds up the other, and the row is `done` only when both are settled.

**Cancelling is not deleting.** Cancelling Premium still puts a workspace back
on the free plan, writable and exportable; nothing here runs on cancellation.

**Residuals, named.** A bucket kept for a week after a move to the customer's
own storage (`managedRetainedUntil`) is erased by the handoff's own scheduled
job when that week ends, not at once, because its token id lives only in that
job. `workspaceDataKeys` is still kept, as `encryption.md` decides; for an
erased managed bucket it opens nothing.

**What would break it, and the test that says so.**
`__tests__/account/managedErasure.test.ts`: dropping the bucket-name check, the
token-name check, the derived-name condition in the cascade, or the
"bucket deleted" condition on `done` each fails a case there.
