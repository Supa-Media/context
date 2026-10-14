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
- **Between two workspaces, a file over 8 MiB stays where it is, named**
  (decided 2026-10-14, step D). A cross-workspace batch is read whole in one
  action and crosses the 16 MiB argument limit twice, so such a file used to
  wedge every batch after it. It is now sized with a HEAD before it is read,
  left in the source, and listed in the move's notice beside the encrypted
  notes ("too large to move between workspaces yet"). It stays there until the
  mover carries files between buckets (step F). Dropping either
  size check fails `__tests__/contextMoveLarge.test.ts`.
- **Files have a 20 MB limit, and a whole-bucket move leaves a bigger one where
  it is, named** (decided by the owner, 2026-10-14, replacing the chunked-seal
  question). The app's own uploads already stop at 5 MB; a bigger file only
  arrives by being put in a customer's own bucket some other way. A move to or
  from managed storage used to fail for good on the first file over 25 MB. Now
  each page's files over the limit are left in the source unread, named on the
  move (up to 50, and counted), and after the switch the owner sees "N files
  stayed behind" in Settings › Storage until they put it away. Nothing is
  deleted. Streaming large files through a Convex action (PR #1625) was closed
  instead: the owner does not want file bytes going through Convex at all, and
  the byte work moves to a mover next to the bucket. Reconciling the whole page,
  or dropping the notice at the switch, fails
  `__tests__/managedHandoffControls.test.ts`.
- **A file moved or copied in one go keeps its bytes** (2026-10-14). `movePath`
  and `copyPath` decoded every object as text, which broke any image or PDF in
  a folder moved that way. Putting `text()` back fails
  `__tests__/fileOps/binaryMoves.test.ts`.
