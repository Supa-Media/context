# Notes stored by id

## Names, folders and privacy live on tree rows; the bucket holds bodies by id

*Decided by the owner, 2026-10-15* ("I want like a clean migration. I don't
want there to be legacy ways things operate"; plan in the project file
`notes-by-id/plan.md`).

**Why.** With the bucket as the source of truth for names and folders, a
rename was a copy and a delete, and moving or archiving a folder was a copy
of every file beneath it. Phase 4 of the Convex tree hid that behind a queue,
but the queue, its overlay, reserved names and the five-hour catch-up
existed only to keep bucket keys equal to names. Auto-organizing a workspace
moves many notes, so the cost was paid constantly.

**What it is.**

- Every bucket, Context-managed or the customer's own, holds note bodies at
  `notes/<noteId>.md`, other files at `files/<noteId>.<ext>`, and plumbing
  under `.context/`. `noteId` is a UUIDv7 that never changes.
- Each workspace's tree rows (`nodes`) hold the name, the parent folder, the
  `storageKey` and the access. A path is derived from the rows. A move,
  rename, archive or trash is one row change and copies nothing.
- Privacy is native to the rows. A row's access is `private` (owners) or
  `team` (members), plus any mix of groups and named people, inside the
  workspace or not (by email until they have an account), each with view or
  edit. Absent means "as its parent"; the nearest setting wins, and a note's
  list replaces its folder's list rather than adding to it, which is the
  engine's old "longest prefix wins, exact note rule first". `privacy.md` is
  retired, and so are the note ACL files.
- Context may move and rewrite any key in a bucket it is connected to, a
  customer's own included. Files put into a bucket by other tools are not
  picked up. No compatibility with syncing a bucket to Obsidian is kept;
  Obsidian plugins that run inside Context are.
- Leaving is **Download as folders**: a decrypted zip with real names, free
  on every plan and after cancelling. Import runs the same copy pass as the
  migration.
- There is no gateway mode without a control plane, and no Dropbox store.

**The migration** (owner, 2026-10-15). The mover copies every object to its
id key and records `copiedKey` on the row; from then on every write goes to
both keys. Staff watch the share copied, restart and diagnose it in the admin
console, and one global switch moves every reader to the copies, with a
switch back. Both keys get every write, so switching either way loses
nothing. Old keys are deleted seven days after the owner confirms the switch.

**What this supersedes.** The bucket as canonical for names
([convex-tree](../app-and-console/convex-tree.md): sweeps, parity, the phase 3
privacy authority and phase 4 queued moves), folder moves in
[storage-move-engine](../app-and-console/storage-move-engine.md),
[queued-trash](../app-and-console/queued-trash.md), and the stable on-bucket
layout with `index.md` and `privacy.md` at root. Those records stay as
history until the code they describe is deleted.

What a "simplification" would cost: reading a name, a folder or a rule from
the bucket again brings back a second answer that disagrees with the rows,
and keying bytes by path brings back copies on every move.
