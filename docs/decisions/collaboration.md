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

## Live delivery is independent of saving

For durable prose, each locally persisted Yjs edit can travel immediately over
its presence socket. It does not wait for the bucket commit or replace the
HTTP save queue. A socket receipt never means Saved. Writable recipients keep
received operations in their own durable queue as well: if they type against
an uncommitted peer insertion, those dependencies must survive the author
closing their browser. Read-only recipients retain received operations locally
but cannot publish them; a fresh bucket read confirms when they are saved.

The relay does not store an authoritative document. Each frame carries a
transient bearer to authorize the sender and obtain the workspace's storage
binding through the existing two-proof boundary. It is not logged, attached to
the socket, stored, or forwarded to peers. Socket attachments contain only
server-derived grant, workspace, path, and document identities. A bounded
control-plane lookup freshly checks recipient grants and memberships; current
privacy rules and the active document generation decide delivery. Permission
failures close ineligible recipients before content is sent. Old clients
without a pinned document identity receive only content-free commit notices.

Network and authorization latency still apply. This path removes bucket writes
and a second document fetch from normal live typing; it does not promise a
fixed production delay. Lost relay messages are repaired from the durable
bucket state. Large updates can fall back to that same path.

Cursors encode positions against the durable editor document, including empty
notes, and reannounce the current selection after socket reconnects. The
presence chip shows peer names and a count of other editors. Acceptance checks
must inspect those rendered elements and require separately typed characters
to appear in another browser while durable writes are deliberately held;
eventual convergence alone does not verify the live editing experience.

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

## Large folder move bound

A folder move of at most 500 visible objects carries each collaborative
document through its identity-preserving lifecycle. Above 500 objects, Context
uses a logical cutover followed by bounded raw-object materialization. That
large-folder path currently refuses before changing privacy rules, forwarding,
move jobs, or note bytes if any Markdown source already has collaboration
history. Move such a folder in smaller batches so each note uses the lifecycle
path. This bound is a current product limitation; a logical cutover must not
strand an active document identity to make a large move appear seamless.

## What proves this works

Core tests cover simultaneous commits, retries, exact-base agent edits, and
failure between storage writes. The browser checks mount the real editor and
hooks against a local Worker and R2 with distinct fake identities. Both layers
are required: operations converging in a unit test does not prove that typing
in the product reaches those operations.

Migration, native delivery, structural changes, and permission failures remain
release gates. A successful local fake-account run is not evidence that the
production sign-in or membership service was exercised.

## Console grants are shared within a browser, independent across browsers

The editor, presence socket and agent share one in-memory, workspace-keyed
console grant cache. Concurrent requests share the same pending mint, and
switching notes reuses the live grant. Account changes discard the cache;
no bearer is persisted. Each loaded console has an ephemeral instance id.
The backend replaces grants only within the same user, workspace and instance,
so opening another browser cannot revoke an editor's token. Expired first-party
rows can be reused to keep the connections list bounded by recent instances.
Legacy clients without an instance id retain their replacement behavior.
Membership checks, scope clamping, expiry, revocation and the per-user mint
limit still apply. An instance id is a cache identity, never authority.

A consumer the gateway refused names the refused token when it asks again
(`{ rejected }`), and the cache mints only if that token is still the one it
holds. Minting for an instance revokes that instance's previous token, so a
consumer that re-minted on news another consumer had already acted on would
revoke the replacement everyone else was using. A mint that has not answered
within fifteen seconds rejects every waiter and is never cached if it answers
later; without that bound, one stalled mint was returned to every consumer for
the life of the tab. Reversing either is caught by
`apps/mobile/__tests__/consoleGrantCache.test.ts`.

## A live connection recovers on its own, and only the control plane says no

The presence socket is supervised as numbered attempts. Each attempt (mint,
handshake and welcome together) has a 20-second deadline, and every callback
from an abandoned attempt is ignored, so a late grant or a stale `onclose`
cannot open a second socket or schedule a second retry. Backoff is capped at
30 seconds, spread by jitter so a gateway deploy does not bring every console
back on the same tick, and reset by a welcome.

An OPEN socket is not assumed alive. The gateway answers every ping, so three
on-time pings with nothing heard, plus a five-second grace, replace it. A
heartbeat that ran late belonged to a throttled or suspended tab and is not
counted; that tab's socket is probed instead when it returns (focus, becoming
visible, or the network coming back). Hiding a tab is not a return.

A browser reports a refused WebSocket upgrade as code 1006, the same as a
network failure, so a socket close is never read as revocation. Two sockets in
a row that never open earn one credential refresh per run of failures, and
then it is backoff, never a mint per retry. The definitive answers are the
control plane refusing to mint (`WORKSPACE_NOT_FOUND`, `NO_SCOPES_GRANTED`)
and the gateway's `4003` close; both end the room quietly. A refreshed
credential can never restore access, because minting re-checks membership.

The durable HTTP path follows the same rule: a 401 is retried once with the
refused token named, and a 401 against the replacement or any 403 is revoked.
Its errors carry the HTTP status, not the gateway's body code; the body codes
(`invalid_token`, `not_found`) matched none of the statuses the controller
decides on, so real refusals and outages never reached them. Requests end
after 30 seconds as network failures, keeping the queue, and concurrent
repairs share one follow-up read.

`apps/mobile/__tests__/presenceRecovery.test.ts`,
`collaborationTransport.test.ts` and `durableCollaboration.test.ts` hold these
contracts; the browser gate (`apps/mcp/test/browser/verifyEditor.mjs`) holds a
silent handshake and a silently dead socket against the real gateway.
