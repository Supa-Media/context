# Storage and credentials: moving between buckets the owner holds

> **Retired for new connections (decided by the owner, 2026-11-01):** bring-your-own bucket is no longer offered; a workspace on one gets its full export before it moves to its workspace object. See [workspace-objects](./workspace-objects.md).

## A move between the owner's own buckets is a third direction, and never touches the old one

**Decided 2026-10-01** by the owner (Settings move, design in
`docs/design/own-storage-moves`). An owner can move a workspace from the
storage it uses now (a bucket they hold) into another bucket they
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
