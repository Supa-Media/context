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

Part 2 runs the supported backup and restore path end to end, on data that
never existed anywhere but the drill. **It never uses a production deployment,
a production backup, a customer bucket, the customer-data Cloudflare account
or a production key.** Importing a production backup anywhere, even into a
throwaway deployment, copies customer rows, sealed OAuth and processor
credentials, and scheduled jobs that send mail and texts. That is a customer
export, and it is out of scope however the target is torn down afterwards.

### What is involved

- **Source:** a new, empty Convex deployment made for the drill (a separate
  project, not a preview of production), running the code at the commit
  under test.
- **Target:** a second new, empty Convex deployment, used only for the import.
- **Drill bucket account:** a Cloudflare account that holds no customer data
  (not the managed customer-data account), with an R2 token scoped to it.
- **Keys:** a wrapping key made for the drill (`openssl rand -base64 32`),
  stored only where the drill's "copy kept outside Convex" lives. No
  production key is read, copied or compared.

### Before seeding: the source has no way out

Set **only** these on the source deployment: `STORAGE_SECRET_ENCRYPTION_KEY`
and `STORAGE_SECRET_ENCRYPTION_KEY_ID` (the drill key),
`MANAGED_R2_ACCOUNT_ID` (the drill account) and the `MANAGED_R2_API_TOKEN`
app secret (the drill token), plus whatever sign-in needs for one synthetic
account. Leave every outbound integration unset: Google client id and secret,
mail (Resend), texting (Sendblue, Linq, Twilio), Stripe, AI providers, search
providers, Sentry and PostHog. With those unset, a scheduled job that tries to
send something fails instead of reaching anybody. Never connect Google or any
processor to the drill account.

### Steps

1. **Seed (source).** Sign in with a synthetic test account, create a
   managed workspace, and let the rollout encrypt it. Write a few synthetic
   notes and one file. Record `{object key: SHA-256 of the plain body}` in
   `digests.json`. Rotate once (`startWorkspaceKeyRotation`) and write a few
   more, so two generations are covered.
2. **Back up (source).** Take the supported backup of the source deployment
   (a Convex snapshot export, the same mechanism as the scheduled backups).
   Copy the drill bucket's objects (`notes/`, `files/`, `.context/`) to a
   second drill bucket with an object copy tool.
3. **Isolate the target.** Set the target's environment to the drill wrapping
   key **from the kept copy**, and nothing else from the list above. Pause the
   target (Settings › Pause deployment) before importing.
4. **Restore (target).** Import the snapshot into the empty target. While it
   is still paused, open `_scheduled_functions` and cancel anything pending.
   A restored job must never run against an integration, even a drill one.
5. **Export the restored rows (target).** Take a snapshot export of the
   *target*. Its `workspaceDataKeys/documents.jsonl` is what the next step
   reads, so the import itself is under test, not just the source export.
6. **Open with the shipping code.** Lay out a working directory as
   `apps/convex/__tests__/recoveryDrillArtifacts.test.ts` describes
   (`bucket/` from the copied drill bucket, `convex/workspaceDataKeys/` from
   step 5, `digests.json` from step 1), then run:

   ```sh
   cd apps/convex
   RECOVERY_DRILL_FROM=/path/to/drill \
   RECOVERY_DRILL_WORKSPACE=<synthetic workspace id> \
   RECOVERY_DRILL_WRAPPING_KEY="$(cat /path/to/kept-drill-key)" \
     npx vitest run __tests__/recoveryDrillArtifacts.test.ts
   ```

   It decrypts every generation's row with the kept key and opens every
   seeded object through `withManagedEncryption`. It passes only if every
   object matches its digest, and writes `report.json` with a result per
   object and no keys or bodies.
7. **Record.** Record the commit, the times, the snapshot ids, the two
   deployment names, the object count and `report.json`. Don't record keys,
   tokens or bodies.
8. **Clean up, and show it.** Delete both deployments, both drill buckets,
   the drill R2 token and the drill key. Record that each one is gone, for
   example a not-found from the dashboard or API, as the cleanup evidence.

### What a pass shows, and what it does not

A pass shows that a supported snapshot export and import, a bucket object
copy, a kept wrapping key and the shipping code together bring every sealed
object back, across a key rotation. It does not show that production's
scheduled backups exist or hold every table, or that production's kept key
matches the deployed one. Those are checked separately and read-only, without
exporting customer data. A fail in step 6 while Part 1 passes points at the
backup, the import or the kept key, not the code. Part 1 passing doesn't mean
Part 2 ran.
