# Customer-owned collaboration

The owner approved one editing system for Context's people, agents, and offline
devices. Support for arbitrary external file editors is outside this change.

## Files and editing history belong together

Markdown remains readable at its ordinary path. Identity-preserving editing
state lives under `.context/collaboration/` in the same customer storage. It is
essential data, unlike a search index. Backups, transfers, and full workspace
exports must include it. A plain Markdown export remains useful, but does not
carry the history needed to reconnect an older offline device.

The console's existing note/folder ZIP download contains readable Markdown,
not a complete bucket backup. Preserving offline merge history requires a full
bucket copy including the hidden `.context/` objects. The managed-storage
migration copies all objects, including these records. Do not describe the
note ZIP as a full collaboration backup.

This explicitly extends the previous plain-files-only durability contract.
Accepted operations may briefly precede their Markdown rendering. A completed
save must include the operations in Markdown; a failed rendering keeps the
durable state available for retry. Nothing belongs in a Convex content table.

Presence is delivery and identity, not proof of saving. Losing a socket or the
last browser does not permit deletion of customer editing history. Every
device keeps its own pending edits until the storage acknowledgement covers
them. A local persistence failure must be visible.

## One merge implementation

`packages/collaboration` owns Yjs and the operation-to-Markdown adapter. This is
the explicit exception to the gateway's previous zero-runtime-dependencies rule.
Its workspace dependency is declared, installed in CI, and deployed whenever
the package changes. Other gateway code may not import arbitrary npm packages
or Node built-ins. Using the same merge implementation on both write paths
avoids another split between console and agent saves.

A replacement from an agent is based on the exact revision it read. Diffing it
against today's live text can delete somebody else's additions. Retries must
reuse the same operation identities. A version mismatch never authorizes a
blind overwrite or a fresh seed of an existing document.

## Permission and identity boundaries

Every server request rechecks access. A revision token or document ID is not
authority. Reads and writes stay within the resolved workspace's storage;
internal state is never made accessible as an ordinary note. A read-only user
cannot publish operations through a socket or the HTTP endpoint.

A renamed note retains its identity. Deleting and recreating a filename must
not attach an old device to the new note. Structural changes need recoverable
ordering with content commits, not a best-effort sidecar copy after a move.
Encryption must never be downgraded to enable collaborative text editing.

## Safe deletion and filename reuse

R2's S3 API does not enforce the conditional delete needed by a resumable
rename. The native R2 adapter's read-then-delete is not atomic either. A passing
browser test against that adapter does not prove production lifecycle safety.
The raw provider probe must continue to report the physical capabilities.

For Context-controlled writes, the storage adapter instead atomically
replace the object with a small, content-free deletion marker using conditional
PUT. Reads and listings treat that marker as absent. A create at the same path
replaces it only by matching its current version; concurrent creates cannot both
succeed. Markers have unique nonces and are never physically cleaned up: an old
cleanup request could otherwise delete a new note at the reused path. This is
storage protocol data, including when the path used to hold an ordinary note.

A provider ETag may be a content hash, even with atomic conditional DELETE.
Delete followed by same-text recreation
can therefore reuse it: a delayed delete could still match the new note. On
supported Markdown, recreating a marker must add a unique reserved
HTML footer to the physical bytes. Later writes preserve generation uniqueness;
logical reads and downloads remove that footer. Existing untagged files remain
readable and ordinary notes are not stamped until the path is reused. Internal
metadata encodes its own document/operation identities. Valid encrypted Markdown
can carry this footer outside its envelope; it remains excluded from plaintext
collaboration, and the footer never enters the ciphertext or authentication
data. Unsupported user files, including binary attachments and drawings, cannot
reuse a logically deleted path until they have a compatible generation fence.

This has a visible cost for people copying the raw bucket: retired paths can
contain marker objects, and recreated notes can contain a reserved HTML footer.
Context downloads hide the footer and listings hide the markers; listed object
sizes can include the footer's small storage overhead. A full bucket
backup must preserve the markers and their metadata alongside editing history;
external tools must not interpret them as live Markdown notes. There is no
periodic marker cleanup in this implementation. Storage adapters must recognize
existing markers even if a later provider probe changes its capabilities.

## What proves this works

Core tests cover simultaneous commits, retries, exact-base agent edits, and
failure between storage writes. The browser checks mount the real editor and
hooks against a local Worker and R2 with distinct fake identities. Both layers
are required: operations converging in a unit test does not prove that typing
in the product reaches those operations.

Migration, native delivery, structural changes, and permission failures remain
release gates. A successful local fake-account run is not evidence that the
production sign-in or membership service was exercised.
