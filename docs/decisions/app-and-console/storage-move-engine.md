# Storage move engine

## The bucket catches up behind the tree on its own, within five hours

The copy that catches a bucket up behind the file tree
([convex-tree](./convex-tree.md), phase 4) has to finish on its own, every
time, and quickly. These are the rules for how it moves bytes and how far it
may fall behind. Audit and plan: project file `move-engine/plan.md` (decided
2026-10-14, after Dev2 asked for an engine "robust enough and deterministic
enough to never fail").

- **A file that is not a note moves by the bucket's own copy** (decided
  2026-10-14, `move-engine/plan.md` step B), so its bytes never pass through
  Convex: one `CopyObject` up to 5 GiB, a multipart `UploadPartCopy` past
  that, every part pinned to the source version it started from, the
  completion only onto nothing, and any failure aborting the upload. A
  multipart copy is stamped `x-amz-meta-context-copy-of: <source etag>` so a
  pass that died before retiring the source recognises its own copy. The
  store reports `serverSideCopy: "same-store"` only where the connect probe
  proved a conditional copy; elsewhere a file over 24 MiB is left in place
  and the move shows "A file is too large to move on this storage" rather
  than overflowing the action. Notes still move by read and write, so their
  history and stamp go with them. A deleted note's marker at the destination
  is a clash like any stranger's object, never a failure for ever. Reading
  the source or dropping the part pin fails `__tests__/nodes/serverCopy.test.ts`.

- **Storage catches up within five hours, and staff hear when it won't**
  (decided 2026-10-14, `move-engine/plan.md` step C). Each pass records its
  pace on the move row, smoothed over passes, and admin › Search › Indexes
  shows each move's time left and one line for the deployment: files still to
  copy, the oldest move's age, and when the slowest bucket catches up. A move
  four hours old, on pace to miss five, or stuck is *late*: a check every 15
  minutes marks it once and mails the staff who turned on "Email me when
  storage falls behind", and its finish mails that it caught up — one mail
  each way per move, at most 12 an hour (`storageLag.ts`). Handles, counts
  and times only. Mailing on every check, or anybody off `ADMIN_EMAILS`,
  fails `__tests__/nodes/storageLag.test.ts`.
