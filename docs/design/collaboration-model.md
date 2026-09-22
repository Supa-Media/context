# Automatic collaboration in Context

Status: implementation under review; local evidence is recorded separately from
baseline failures in `artifacts/collaboration/`.

## Why saving and collaboration used to disagree

The previous editor synchronized live Yjs updates through a room, while a
browser elected as saver periodically wrote the whole Markdown file. Offline
saves and agent edits also wrote whole files. Room state, file versions, and
local drafts could therefore describe different versions of a note. Fixing one
write path did not make the others agree. An empty room was not durable history.

The offline download indicator described the local mirror, not whether the open
note had saved. Search indexing was a third, independent status. Combining those
signals made a saved note appear unavailable or a connected editor appear saved.

## One durable editing path

`packages/collaboration` preserves each note's Yjs identity and editing history
in the customer's bucket, alongside readable Markdown. Both the console and MCP
use this package. No note content is added to a Convex database.

1. A device opens the saved Yjs document, retaining character identities.
2. Typing updates that document and queues the resulting operations locally.
3. The authenticated gateway merges operations into the durable bucket state.
4. Conditional writes coordinate competing servers and render the resulting
   Markdown. A saved acknowledgement follows successful rendering.
5. Other editors receive a content-free notification and fetch updates through
   a freshly authorized request. A periodic repair also recovers missed notices.

There is no elected browser saver. The gateway works without another editor
being present. Retry delivery is safe; an interrupted multi-object commit is
recovered by a subsequent read or write. Client retries and periodic repair drive
that recovery; there is no separate always-running materialization service.

An agent reads text plus a revision token. Its replacement is compared with the
exact retained version it read, and those edits are merged into the current
shared document. An unseen human insertion is not deleted merely because it was
absent from the agent's earlier read. Missing history refuses the write instead
of authorizing a blind overwrite.

## Offline and status

The device retains a snapshot and pending operations before declaring them saved
locally. Reopening offline restores those identities. Reconnecting uploads the
same operations, so duplicate delivery and message ordering do not create copies.
The interface distinguishes saving locally, waiting for connection, syncing,
saved to the bucket, storage failure, and unavailable or revoked access.

An older whole-file draft is translated using its retained revision when that
revision exists. If its pre-upgrade base was never retained, the draft stays
visible and recoverable; the app cannot safely invent that missing history.

## Renames, deletion, and encryption

Rename preserves document identity through a recoverable storage operation.
Old paths can forward collaboration requests only after destination permission
checks. Trash keeps the document's identity for restore; old devices cannot
recreate a deleted filename or attach to a different note that later uses it.
A destination collision is refused rather than overwriting the existing note.

Encryption freezes plaintext editing, durably writes the encrypted envelope,
and purges the collaboration generation's plaintext history. Retrying resumes an
interrupted transition. Decryption starts a new generation. Encrypted notes and
drawings retain their separate editing protocols; plaintext collaboration never
interprets their ciphertext or drawing payloads.

## Trade-offs and limits

- Essential history takes additional bucket space and storage requests. It must
  accompany full backups and transfers; it is not a disposable search index.
- Concurrent changes converge automatically, but the system cannot decide which
  of two contradictory rewrites a person intended. The merged prose can still
  need ordinary editing.
- Access revocation stops server reads and writes; it cannot erase content a
  device already received. Unsent local writing is retained.
- Automatic collaboration requires verified conditional storage operations.
  Arbitrary Obsidian/rclone/bucket-console overwrites are outside this contract.
- Storage providers may retain their own object versions. This change does not
  claim to erase provider backups or copies already on another device.

## Verification

The browser runner mounts production file hooks, editor, presence, and offline
storage against a real local Worker and R2 bucket, with two isolated browsers and
distinct fake users. MCP edits use a third grant. It checks populated and empty
notes, simultaneous typing, saved Markdown, navigation, reload, offline reload,
agent races, lost acknowledgements, server restart, revoked access, and structural
changes. Core tests inject failure between storage mutations and exercise retry,
identity, ordering, and permission boundaries separately.

Fake authentication does not establish production sign-in or membership setup.
Native guest/host tests execute the Yjs bridge but do not replace a device run.
The baseline report, current test results, and deployment status must remain
separate claims; see `artifacts/collaboration/README.md`.
