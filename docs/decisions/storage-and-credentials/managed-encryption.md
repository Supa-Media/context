# Storage and credentials — managed-storage encryption

## A managed bucket holds sealed bodies, and every way out is plain

**Decided 2026-09-29** (private beta workstream 1; artboard approved by the
owner the same day). A bucket Context runs for somebody stores each object's
body sealed with a key that lives outside the bucket. A bucket the customer
owns is never touched. Every path a person or their tools read through, and
every way out (the hand-off to their own bucket, a download), gives plain
files.

This is **not end-to-end encryption**, and no copy may call it that. Context
holds the key and opens notes to search them, to serve AI clients and to render
websites. What it protects against is somebody who has the bucket and nothing
else: a leaked R2 token, a mis-scoped account member, an R2 incident. The
customer-facing sentence is "Encrypted in transit and at rest", followed by
the fact that file and folder names are not encrypted.

### What is sealed, and with what

- **The key.** The workspace's versioned data key (`workspaceDataKeys`, the
  same rows per-note encryption uses, generations never deleted). The storage
  key is HKDF-Expand over it with the label `context-managed-storage-v1`,
  written as HMAC-SHA256 because the gateway's passphrase guard forbids
  WebCrypto `deriveKey`/`deriveBits` in the gateway.
- **Each object.** A fresh AES-256-GCM key, wrapped by the storage key.
- **The envelope**, version 1: `CTXENC` + `0x01`, generation length,
  generation, wrap IV (12), wrapped key (48), content IV (12), ciphertext and
  tag. The content's associated data is `context-storage-v1:<workspaceId>:`
  plus the header bytes; the wrap's is
  `context-storage-key-v1:<workspaceId>:<generation>`. Bytes from another
  workspace never open here, even under the same key material.
- **Not bound: the object's path.** A server-side copy to another path (a
  rename, a move) must keep opening, so the path is left out on purpose.
- **Plain on purpose:** object keys, sizes, content types, and deletion
  markers (`LOGICAL_DELETE_CONTENT_TYPE`), which carry no content.
- **Overhead:** 98 bytes per object. Measured in Node's WebCrypto, one seal or
  open costs about 0.3 ms up to 50 KB and about 7 ms at 5 MB.

### Where it sits

`withManagedEncryption` wraps the adapter directly inside `storeForBinding`,
**beneath** the logical-delete view, the note cap and the raw-object view. That
puts every caller above it on plain bytes, so nothing above it can write around
it. The walk alone asks for the unwrapped view (`sealedObjects: true`). The
control plane sends the mode as a sibling of the binding
(`managedEncryption: { mode }`) alongside the existing `encryptionKey`. The
gateway, the console's file operations, the hand-off copy and the email worker
all build their store from that one lookup.

### Modes and states

| Workspace state | Gateway mode | Reads | Writes |
|---|---|---|---|
| no row, or `waiting` | plain | plain | plain |
| `encrypting`, `checking`, `failed` | `migrating` | both kinds | sealed |
| `encrypted` | `encrypted` | refuses a plain body | sealed |

**Fail closed, in both directions.**

- A mode with no key refuses the whole store (`ENCRYPTED_UNREADABLE` to the
  app, which shows the recovery page with editing off), because a store built
  without the wrapper would write plain into a workspace that refuses plain.
- A failed mode lookup at the control plane returns no binding at all.
- A customer-owned binding never gets a mode, even when a stale row exists
  (`bindingIsManaged` is checked on every lookup).

### The walk

The walk runs in Convex, the same shape as the managed hand-off: one page of
one workspace per action, rescheduling itself, with a `runId` so that a pause,
a retry or a restart retires any run still in flight. Its phases are count,
then seal (100 objects a page, 8 at a time), then check (every object is read
again). Only then does the workspace become `encrypted`.

- **Every seal is a conditional write** on the etag it read, then a read-back
  that must open to exactly the original bytes. A save that lands first wins
  the write, and the walk counts that object as `raced` and moves on. People
  write sealed in `migrating` mode, so nothing is lost and nothing older
  overwrites anything newer.
- **A batch settles before a failure is reported.** A refusal marks the
  workspace `failed` only after its sibling seals have finished, so the row
  never reads failed while writes are still in flight.
- **A walk failure pauses the whole rollout** (`failed`). Staff see a stable
  code, never a message, since a message could quote a path. Owners see
  "Paused".
- **Scheduling:** at most two workspaces are walked at once, because this is
  our own R2 account.

### Rollout

The rollout is staff-only (`requireAdmin` in every public handler). It covers
our own workspaces, workspaces staff pick, or all. Its states are:

- **running**
- **paused**, which requires a reason
- **failed**, set automatically
- **complete**
- **off**, from "Stop starting new workspaces". Walks already under way
  finish, and waiting rows are dropped. **Turning it off never makes an
  encrypted workspace plain.**

A rollout over all workspaces also takes in every workspace that gets a
managed bucket afterwards.

### Rollback, restore, rotation, deletion

- **Rollback is to `migrating`, not to plain bytes.** Setting a workspace's
  row back to `checking` (a row edit in the Convex dashboard; see the runbook
  below) makes reads accept both kinds again, which undoes
  every behaviour the rollout introduced except the bytes themselves. We do not
  build a walk that decrypts in place. The only reason to want plain bytes in a
  managed bucket is to hand them to somebody, and the hand-off already
  decrypts as it copies.
- **Leaving managed storage** decrypts during the copy (the source store is
  built in the workspace's mode). The copy's verification compares plain bytes
  with plain bytes. At cutover the row is deleted, so a later move back starts
  plain and is walked again.
- **Key rotation:** new saves seal under the new generation. Objects keep
  opening under the generation they name, because generations are never
  deleted. A walk after a rotation seals remaining plain objects under the
  current generation. It does **not** re-seal objects already sealed under an
  older generation. That is a known limit, not a guarantee: rotating does not
  retire the old key from managed objects.
- **Workspace deletion** sweeps the rows (`finalizeWorkspaceDeletion`). The
  keys go with `workspaceDataKeys`.
- **Version history:** R2 keeps no object versions, so a managed bucket has no
  plain earlier versions left behind. If managed storage ever moves to a store
  with versioning on, the versions from before the walk are plain, and this
  section has to change.

### Runbook

- **Something looks wrong mid-rollout:** Pause, with a reason. Every walk
  stops at its next page. Nothing becomes unreadable, because a half-walked
  workspace reads both kinds.
- **A workspace failed:** read its code in the staff card.
  - `KEY_UNAVAILABLE`: the key could not be opened, so check the keyset
    environment.
  - `VERIFY_FAILED`: a read-back did not match. Stop and investigate the
    store before retrying.
  - `ENCRYPTED_UNREADABLE`: an object claims to be sealed but does not
    open. Look at that workspace's objects.

  Retry it once the cause is fixed. The rollout resumes by itself when no
  workspace is left failed.
- **Encrypted reads are refusing something they should not:** set that
  workspace's row to `checking` so reads accept both kinds again, then find
  the object.
- **Stop for good:** "Stop starting new workspaces". Encrypted workspaces stay
  encrypted and readable.

### What stays plain outside the bucket

This change seals the bucket and nothing else. Other places hold note text
under their own decisions:

- the live editing room (bounded, see
  [collaboration-and-live-rooms](./collaboration-and-live-rooms.md));
- the per-context search database;
- the router's per-revision copies of published website pages.

None of them is the only copy of anything, and each is covered by the decision
that allowed it.

### An object that only looks sealed

A plain object whose first seven bytes happen to be `CTXENC\x01` fails to
open. The workspace then stops as `failed`, with the object left untouched,
rather than having that object served or sealed over. Only a deliberately
crafted upload hits this, and it can only stop its own workspace.

### What a "simplification" would cost

- **Binding the path into the associated data** breaks every server-side
  copy, including renames and moves.
- **Putting the wrapper above the logical-delete view** lets a deletion
  marker or a raw-object copy bypass it.
- **Letting reads fall back to plain in `encrypted` mode** turns a tampered
  or truncated object into a silently served one.
- **Deriving the key with `deriveKey`** trips the gateway's passphrase guard.
- **Recording the failure message** is how a path would reach a log.

**The tests that fail:**

- `apps/mcp/test/managedEncryption.test.mjs` (format, tamper, cross-workspace,
  modes, walk)
- `apps/convex/__tests__/managedEncryption.test.ts` (staff-only, end to end,
  fail closed, owner view)
- `apps/convex/__tests__/managedEncryptionEdges.test.ts` (partial failure and
  retry, rotation mid-walk, stale runs, hand-off mid-walk, final check, forged
  envelope, concurrency)
- `infra/email-worker/src/managedEncryption.test.ts`

Each carries a sabotage record.

### Plain files stay canonical

Non-negotiable #3 said Markdown stays portable and human-readable. In a
managed bucket that stays true of what the product reads and of every exit,
and is no longer true of the raw bytes at rest. The owner chose to amend it
(2026-09-29): `CLAUDE.md` #3 and [managed-storage](./managed-storage.md)
item 3 now say so.
