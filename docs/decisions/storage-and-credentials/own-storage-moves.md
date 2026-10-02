# Storage and credentials: moving between buckets the owner holds

## A move between the owner's own buckets is a third direction, and never touches the old one

**Decided 2026-10-01** by the owner (Settings move, design in
`docs/design/own-storage-moves`). An owner can move a workspace from the
storage it uses now (a bucket they hold, or Dropbox) into another bucket they
hold, from Settings > Storage, with the same copy, checks and switch-over as
the move out of managed storage.

- **One engine, three directions.** `managedStorageMigrations.direction` is
  `to_managed`, `to_customer` or `to_own`. Code asks the question it means
  through `lib/managedProvisioningFns/direction.ts` (`intoOwnersBucket`,
  `outOfManagedBucket`, `involvesManagedStorage`), never
  `direction === "to_customer"`, because with a third direction those
  questions have different answers.
- **The old storage is never touched.** After the switch Context forgets its
  credential and leaves every object in place; the owner deletes it when they
  choose. There is no "switch back": both ends are theirs, and going back is
  another move. Reversing this would be the first time Context deletes from a
  bucket a customer holds.
- **A `to_own` move never writes the plan row.** Context's storage is on
  neither end, and a free workspace may have no plan row. Its progress is read
  from the migration row. An upgrade never resumes a `to_own` row and refuses
  with `MOVE_IN_PROGRESS` while one is copying.
- **Nothing else changes storage while a move copies.** `applyBinding` (every
  caller but the switch-over itself) and disconnect refuse with
  `MOVE_IN_PROGRESS`.

Tests: `apps/convex/__tests__/ownStorageMove.test.ts`.

## Dropbox is a source and never a destination, and its grant outlives the switch for the catch-up

**Decided 2026-10-01** by the owner. Dropbox support is ending (`billing.md`:
no new Dropbox connections), so a Dropbox workspace may move off it but nothing
may move onto it.

The catch-up passes after a switch (`lib/moveCatchUp.ts`) read the old storage
for writes that landed after the last check. A Dropbox grant used to be
revoked at the switch, so those writes were lost for a Dropbox source, in the
upgrade too. Now the switch-over passes `deferDropboxRevoke` to
`applyBinding`, the passes carry the sealed refresh token (resealed if Dropbox
rotates it) and revoke the grant when they finish or stop, and a revoke
scheduled at the switch for 45 minutes later (`DROPBOX_REVOKE_BACKSTOP_MS`,
after the last pass at 30) revokes it even if no pass runs.

Tests: `apps/convex/__tests__/ownStorageMoveDropbox.test.ts`.

## Dropbox workspaces are told support is ending, without a date

**Decided 2026-10-01** by the owner. Owners of a Dropbox workspace see "Dropbox
support is ending" in the console (`dropbox-ending`, asked again 14 days after
it is put away) and permanently in Settings > Storage, with the two ways off
it: a bucket of their own, or Context storage through Premium. No end date is
given until one is decided, so nothing is promised that would then have to be
kept.

Tests: `apps/mobile/__tests__/dropboxEndingNotice.test.ts`,
`apps/mobile/__tests__/handoffCard.test.ts`.
