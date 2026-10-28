# Recovery drill: managed-bucket encryption

How we show that encrypted notes in a Context-managed bucket can be brought
back after losing the running system, without putting any customer data or
key material into the evidence.

## What has to survive

Opening a sealed note body needs three things, which are kept in three places:

| Link | Where it lives | What restores it |
|---|---|---|
| Sealed objects (`notes/…`, `files/…`) | The workspace's managed bucket | A copy of the bucket's objects |
| Data-key rows (`workspaceDataKeys`, one per generation, each sealed by `encryptSecret`) | Convex | A Convex backup |
| `STORAGE_SECRET_ENCRYPTION_KEY` (and `…_ID`), which seals the rows | Convex environment | The copy kept outside Convex |

Losing any one of them loses the notes it covers: the drill shows each loss
fails closed. Every generation's row is needed, not only the current one,
because a rotation does not re-seal old objects
([managed-encryption](./decisions/storage-and-credentials/managed-encryption.md)).

## Part 1: the synthetic drill (anyone, offline)

```sh
cd apps/convex
RECOVERY_DRILL_OUT=/tmp/recovery-drill npx vitest run __tests__/recoveryDrill.test.ts
```

`__tests__/recoveryDrill.test.ts` runs the shipping code: `encryptSecret` /
`decryptSecret` from `functions/lib/crypto.ts`, and the gateway's
`withManagedEncryption` from `apps/mcp/src/store/managedEncryption.js`. With
throwaway keys and synthetic notes it:

1. Seals six notes and a binary file under data key `k1`, rotates to `k2`, and seals six more.
2. Backs up the raw bucket bytes, and the rows as one JSON document per line, laid out the way a Convex export lays out a table.
3. Drops everything in memory. Then it restores from the backup directory plus a separately held copy of the wrapping key, and checks all 14 objects against SHA-256 digests taken at write time.
4. Checks that the backup alone holds no plain note and no key.
5. Checks that a wrapping key rotated since the backup still opens it while the old key is kept as `previous`.
6. Checks the failure cases:
   - a wrong wrapping key opens nothing;
   - a lost retired row loses exactly the notes sealed under it, and they fail closed;
   - rows or objects moved to another workspace id don't open;
   - a damaged object is refused rather than served.

With `RECOVERY_DRILL_OUT` set, the backup and a `report.json` (object count,
generations, digests of the synthetic content) stay in that directory. Neither
holds a key.

What it does not prove: that production's backups exist, are complete, or
match the deployed key. That is part 2.

## Part 2: the live drill (operator with infrastructure access)

Use only a **synthetic workspace**, never a customer's. Don't put any key, token
or customer content into a note, ticket or report.

1. **Seed.** On a dedicated test account, create a managed workspace and let the rollout encrypt it (Settings › Storage shows it). Write a handful of synthetic notes and one file, and record each body's SHA-256 locally.
2. **Back up.** Confirm the scheduled Convex backup that covers the seeding time exists. Copy that workspace's bucket objects (`notes/`, `files/`, `.context/`) to a disposable bucket.
3. **Restore somewhere disposable.** Import the Convex backup into a new, disposable Convex deployment. Set `STORAGE_SECRET_ENCRYPTION_KEY` and its id there **from the copy kept outside Convex**, not from the production environment. That is the point of the drill.
4. **Open.** Point the restored deployment's binding for the synthetic workspace at the disposable bucket. Read every seeded note through the app or the gateway, and compare digests.
5. **Older generations.** If the synthetic workspace has been rotated (`startWorkspaceKeyRotation`), confirm notes from before the rotation open too.
6. **Record.** Record the times, backup id, result per note (digest match yes/no) and anything that failed. Don't record keys or bodies.
7. **Tear down.** Delete the disposable deployment and bucket, and the test account.

A pass shows that the backup, the kept key and the code agree. A fail in step 4,
with the synthetic drill passing, points at the backup or the kept key copy,
not the code.
