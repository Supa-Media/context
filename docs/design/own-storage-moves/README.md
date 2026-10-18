# Moving a workspace between buckets the owner holds

Status: approved 2026-10-01 and built. Durable decisions are in `docs/decisions/storage-and-credentials/own-storage-moves.md`.

## Intent

An owner can move a workspace's files from the storage it uses now to a
different bucket they own, from inside the app, without losing a write and
without Context deleting anything of theirs.

What exists today and does not change:

| From | To | How | Status |
|---|---|---|---|
| Own bucket | Context-managed | Premium upgrade, `direction: "to_managed"` | exists |
| Context-managed | Own bucket | Move out in Settings, `direction: "to_customer"` | exists |
| Own bucket | Another own bucket | Settings, `direction: "to_own"` | **this design** |

"Own bucket" means an S3-family bucket the owner holds: `r2`, `s3`, `b2` or
`s3-compatible`, connected to the hosted service. Moving a workspace between
two separate Context installations is out of scope.

## Decisions

1. **A third direction in the existing engine.** The move reuses the
   `managedStorageMigrations` row, the copy worker
   (`runManagedStorageMigration`), its count, copy and verify phases, the cutover
   (`finishManagedStorageMigration`) and the catch-up passes
   (`moveCatchUp`). Rejected: copying in the app (needs the app open, no
   verification, duplicates the engine) and instructions only (not in the app,
   loses writes made during a manual copy).
2. **The old bucket is never touched.** After cutover Context forgets the old
   credential and leaves every object where it was. The owner deletes it when
   they choose. There is no "switch back" control: both buckets are theirs, and
   going back is another move.

## Backend (`apps/convex`)

### Data model

`managedStorageMigrations.direction` gains a third literal:

```ts
direction: v.union(v.literal("to_managed"), v.literal("to_customer"), v.literal("to_own"))
```

No new table and no new fields. The row's existing `targetProvider`,
`targetEndpoint`, `targetRegion`, `targetBucket`, `targetRootPrefix`,
`targetAccessKeyId`, `encryptedTargetSecretAccessKey`, `targetForcePathStyle`,
`targetClaimed`, `existingFiles`, `status`, `phase`, counters, `failedKeys`,
`readyToCutover` and `startedBy` carry a `to_own` move unchanged. Progress for
`to_own` is read from this row, not from `workspacePlans.managedProvisioning`,
because a free workspace may have no plan row.

The catch-up arguments (`moveCatchUp.ts`, `sourceSnapshotValidator`) carry the
S3 shape: the sealed key pair stays in the scheduled arguments, exactly as the
S3 secret already does. No table holds it.

### API

| Function | Kind | Args | Returns | Refuses with |
|---|---|---|---|---|
| `storage.startStorageMove` | action, owner | `workspaceId` plus the S3 fields `bindStorage` takes | `{ started: true }` | `NOT_AUTHENTICATED`, `INSUFFICIENT_ROLE` (not owner), `MANAGED_STORAGE` (use the move out), `SAME_STORAGE`, `MOVE_IN_PROGRESS`, the endpoint and probe errors `bindStorage` already returns |
| `beginOwnStorageMoveHandler` | mutation handler in `lib/managedProvisioningFns/migrationBegin.ts` | `workspaceId`, `actorUserId`, sealed target | `{ started: true }` | re-checks owner, not managed, binding unchanged |
| `managedHandoff.cancelManagedStorageHandoff` | existing, widened | unchanged | unchanged | now also stops a `to_own` move |
| `managedHandoff.chooseExistingFilesForHandoff` | existing, widened | unchanged | unchanged | now also answers for a `to_own` move |

`startStorageMove` seals the destination secret with the same code path as
`bindStorage` and `startManagedStorageHandoff`, so the plaintext exists only for
the length of one action call.

While a move of any direction is running, `bindStorage`, `disconnectStorage`
and the Premium provisioning entry refuse with `MOVE_IN_PROGRESS`.

### Cutover for `to_own`

`finishManagedStorageMigrationHandler` gets a third branch:

1. The existing guard, with `to_own` requiring the source binding is unchanged
   and is not the managed bucket.
2. `applyBinding` to the target.
3. Delete the migration row. Audit `storage.moved` with `objectsCopied` and the
   source and target providers (no bucket names, no keys).
4. No `workspacePlans` patch and no managed-bucket deletion.
5. Schedule catch-up pass 0. The sealed key pair is passed, as today.
6. The "paused" email (`handoffEmail.sendHandoffEmail`) is sent for `to_own`
   pauses too.

## App (`apps/mobile`)

### Settings, Storage, own bucket, owner only

1. "Change storage" keeps today's job: re-point or re-key without copying (the
   "it already has my files" path). Moving is a separate card, "Move to
   another bucket", whose form calls
   `startStorageMove`. Built this way rather than as a toggle on the re-key
   form, which is prefilled with the current bucket for rotating a key.
2. `HandoffCard` draws a `to_own` move: the same five steps, stop, the
   existing-files question and failure lines, said about "the storage it uses
   now", never Context's storage. The promise that the old storage is left as
   it is appears on the offer and in the form; after the switch the storage
   card shows the new bucket, and nothing records the finished move. No
   switch-back button.
3. `StorageActions` gains `move(values)`. The storage view's existing
   `handoff*` fields carry a `to_own` move too; the card tells the two apart
   by whether the workspace is on managed storage.
4. Premium shows `MOVE_IN_PROGRESS` as "Your files are being moved to another
   bucket", retryable once the move has finished or been stopped.

### Managed workspaces

No change.

## Errors and edge cases

| Case | Behaviour |
|---|---|
| Destination equals current storage | `SAME_STORAGE` before anything starts |
| Destination unreachable or bad key | Probe at start refuses; old storage stays live |
| Destination already holds files | Existing replace (type bucket name) or merge question |
| Writes during the move | Old storage stays live; passes repeat until one finds no change |
| Stop | Allowed until `readyToCutover`; then "too late to stop", as today |
| Owner rebinds, disconnects or upgrades mid-move | Refused with `MOVE_IN_PROGRESS`; if the source changes anyway, `SOURCE_CHANGED` pause and email |
| Write lands in old storage after cutover | Catch-up passes bring it across; never overwrite or delete in the new bucket |

## Tests

Written before the code. Each guard is sabotaged once to confirm its test fails.

Convex (`apps/convex/__tests__/`):

1. Own bucket to own bucket: every object byte-identical in the target, binding
   switched, old bucket unchanged after (no deletes).
2. Refusals: editor and member cannot start, stop or answer; `SAME_STORAGE`;
   `MOVE_IN_PROGRESS`; `MANAGED_STORAGE`.
3. During a move, `bindStorage`, `disconnectStorage` and provisioning refuse;
   a changed source pauses with `SOURCE_CHANGED` and sends the email.
4. Isolation: a move in workspace A never reads or writes workspace B's bucket
   or credentials.
5. Existing `to_managed` and `to_customer` suites pass unchanged.

App (`apps/mobile`, jest):

1. `ConnectForm` move mode calls `move`; "just switch" calls `connect`.
2. `HandoffCard` renders a `to_own` move and its finished line; no switch back.

## Records

A decision note, `docs/decisions/storage-and-credentials/own-storage-moves.md`,
indexed in `docs/decisions/README.md`, covering decisions 1 and 2 above and the
tests that fail if each is reversed.
