# Tree writes go to the workspace object first (2026-11-02)

Decided by the owner, 2026-11-02, choosing "Yes, all tree writes" on "Move saves to write straight to the workspace
object?". Asked "why the heck would we move reads but not writes?" after a save was measured at about 4 to 5 seconds,
most of it control-plane round trips: setting a row's access (median 2.1 s, mostly waiting for the object to catch
up) and recording the note's id (0.9 s), against 1.1 s to write the text itself (production `mcp_entry`, 2026-11-02,
read with the `MCP entry timings` workflow).

## What changes

[Every row write reaches the workspace object](./workspace-object-rows.md) made the object a copy that Convex keeps up
to date: Convex takes every write, and an outbox pushes it across afterwards. That copy step is where a save's
seconds went, and it jammed for a whole afternoon on 2026-11-02. For a workspace whose `home` is `object`, the
direction now flips:

- **The object is the writer of record** for its tree rows, its grant rows and its access rules. A write is one call
  to the object, decided and committed in one transaction there, with the permission check beside it.
- **Convex keeps a mirror, written behind.** The object queues each change it took (an outbox of its own, drained by
  its alarm) and sends it to the control plane (`POST /gateway/rows/mirror`, gateway secret only, the same shape as
  `/gateway/access/mirror`). Convex applies it without opening an outbox entry of its own, so a change never bounces
  back. The mirror is what Convex's remaining readers see until they move to the object, and the rollback.
- **Clocks belong to the object.** The object stamps each row it changes with `at = max(now, held.at + 1)`, and
  remembers that clock (`own_at`) and which fields it changed since Convex last caught up (`own_fields`). The mirror
  sets the Convex row's `objectAt` to that clock. A row Convex still pushes (a writer not moved yet) carries its
  `objectAt`: when it is at least the held `own_at`, Convex has seen the object's writes and the whole row is taken;
  when it is older, the pushed row is taken except for the fields the object owns, so a rename made in Convex still
  arrives while a save's version made in the object is kept. The mirror applies the object's change as an operation
  through Convex's own handlers (the same code the gateway's route ran), so Convex's log and facts stay as they were,
  and it opens no outbox entry, so nothing bounces back. A change Convex refuses is dropped and counted, never
  retried forever: one stuck entry must not hold every later one, which is how the push outbox jammed on 2026-11-02.
  Access versions are minted by the object the same way.
- **A narrowing waits for the mirror; nothing else does.** Taking access away, hiding, moving or deleting answers only
  once Convex has the change, so a reader still on Convex never shows what was taken away (the rule
  `/gateway/access/mirror` already follows). A save's version, size and time, a new note, and anything that only
  widens or keeps access mirror behind and never hold the answer.
- **The gateway's save path makes no control-plane call** for such a workspace: the row lookup, the version record, a
  new note's row and its tier are object calls, and the bucket backup is written behind (`store.defer`), as
  `store/workspaceRouting.js` already says it is.

## First steps that need none of it (2026-11-02)

- An existing note saved without asking for a visibility no longer writes its tier: the write only re-pinned what
  it had, and cost the 2.1 s above on every save (`tools/notes/write.js` `tierKept`; `test/writeKeepsTier.test.mjs`).
- The bucket's backup copy of a save is written behind the response, as `workspace-objects.md` always said: the
  session store never had the request's `waitUntil`, so it was awaited. One key's backup writes still land in the
  order they were made (`store/workspaceRouting.js`; `test/workspaceRouting.test.mjs`, `test/backupBehind.test.mjs`).

## Order of work

The object's write ops, its outbox and the Convex mirror route land first, with saves on them. Access and sharing
writes, file operations (create, move, rename, copy, archive, trash, restore, delete) and the background writers
(trash emptying, purge, old copies, id copies, facts, Tex group homes) then move onto the same ops. Readers move off
Convex's tables in parallel (the app's listing and change feed, the gateway's manifest, names, jobs, id lookups and
binding rules), because each already has the object's rows to read. When nothing reads Convex's node tables for a
workspace on its object, the mirror stops and the tables go, as the switch already plans for its rollback copies.

## What a simplification would cost

Writing the object and Convex side by side from the gateway, both awaited, keeps every save's control-plane round
trip, which is the cost this removes. Letting a narrowing answer before the mirror lands lets the app's Convex listing
show a note its owner just made private. Letting Convex's older push overwrite the object's newer row silently undoes
saves. Tests: added with each step, named in this file as they land.

## The object renders its own rules (2026-11-03)

The first step of moving access writes: the object holds the grant rows and renders the member and guest rules
itself, before anything is judged by them. Every push that carries rules (`lib/rowWatch/drain.ts`) also carries the
**access set** they were rendered from, read beside them (`nodesPrivacy.accessSet`,
`lib/nodes/accessSet.ts`): each row that carries a setting, keyed by its token id (`@#<id>`) and kind, with its base
and its grantees in the `nodeAccess` shape (`{kind, id, role}`), the access version, the private paths still pending
their row, and whether `accounts` grants are honoured and the chat homes sealed here. It rides the round's last
call, once every row of the round is held. The object keeps it in `ws_access` (`workspaceStore/accessRows.js`),
whole, unless it holds a later version, places each record at its own live row's path (the sent path only for a
row it no longer holds), applies the same overlays as `accessRowsOf` with the same `renderAccess`, and records
whether the result equals the rules it holds (`ws.access.state`; `ws.access.check` compares without keeping
anything, for the read-only production run, `Workspace object access parity`). A chunked move part way through is
skipped: its rules name both paths.

Nothing reads the rendered rules yet, and a set the object refuses never fails the push it rides on: the pushed rules
stay the only thing reads are judged by until the access writers move onto `ws.write.access` and the parity report has
stayed equal. A grant taken back is gone from the next set, and an older set never replaces a newer one, so a
replayed push cannot bring it back (`apps/mcp/test/workspaceAccessRows.test.mjs`,
`apps/convex/__tests__/nodes/objectAccessParity.test.ts`).

## Landed: the Convex mirror (`objectAt`)

Convex keeps `nodes.objectAt`, the object's clock of the last change it made to the row. `POST /gateway/rows/mirror` (`functions/lib/gatewayRoutes/rowsMirror.ts`) takes a batch in order and calls `functions/objectRowsMirror.ts` `wrote` per change, built with `internalMutationMirrored` (no outbox entry, no push). A refused or missing row is `{ applied: false, reason }`, never a throw. Tests: `__tests__/objectRowsMirror.test.ts` (keyed write opens no outbox entry; `objectAt` never goes backwards; missing and refused rows; route order, bad body, transient stop). Sabotage: building `wrote` with the watched `internalMutation` fails the outbox case. `objectAt` is outside the object digest (`__tests__/workspaceObjects.test.ts`).

## File operations in the object (2026-11-03)

`apps/mcp/src/workspaceStore/treeOps.js` holds create folder, move and rename, trash, restore and delete over the
object's rows, with the refusals Convex's row move gives (`rowMove.ts`, `rowTrash.ts`, `archiveTwins.ts`,
`sealedChats.ts`), each one synchronous run of SQL so the object commits it whole. A folder move rewrites every path
under it in that one transaction: nothing is chunked, because a workspace's rows fit in its object. A note outside the
trash is never deleted in one step; it goes to the trash, as Convex refuses a keyed delete. Each answer names the rows
it wrote and the ids it removed with their clocks, for the outbox. Rows the object makes take ids `o_` and 32 hex
characters. Whether the caller may see what it moves is the caller's `judge`, built from the rules it holds. Tests:
`apps/mcp/test/treeOpsMove.test.mjs`, `apps/mcp/test/treeOpsTrash.test.mjs`.

## Rows the object makes keep the object's id (2026-11-03)

A row the object makes (a folder a move stands up, a new note) has the object's id, `o_` and 32 hex characters, and
Convex takes it behind under its own `_id`. Convex keeps the object's id as `nodes.objectId` (index
`by_workspace_objectId`), every push names such a row by it (`lib/workspaceObjects/rows.ts` `objectIdOf`, the push's
rows and removals and the whole-copy pages), and a mirrored change finds the row through `lib/nodes/objectIds.ts`
`nodeByObjectId`. A row deleted outright no longer has its `objectId` to read, so the row watch keeps it on the outbox
entry (`goneObjectIds`) and the push removes it under that id. Without the column, a Convex insert would come back to
the object as a second row at the same path. Tests: `apps/convex/__tests__/objectRowIds.test.ts` (sabotage: naming the
row by `_id` fails two cases, dropping `goneObjectIds` fails one).

## Trash and restore are object writes; the tree mirror (2026-11-03)

`ws.write.trash` and `ws.write.restore` (`apps/mcp/src/workspaceStore/treeWrites.js`) run `treeOps` in one object
transaction and answer with one `tree` change: the moved root, any folders stood up, and any rows retired. Convex
takes it through `objectRowsMirror.tree` (`lib/nodes/mirrorTree.ts`), which plans the whole change before writing,
revives or adopts folders by `objectId`, patches the moved root (and, on stored paths, every descendant, refused
past 500), and runs the same follow-ups a Convex-side move runs. Trash narrows and waits for the mirror; restore
does not widen, because **a restore only returns a note to the name it came from**: `from` must be
`.context/trash/<stamp>/<to>`. Letting the caller pick the name would let a member who can see a trashed private
note put it somewhere the team can see. The test is `treeWrites.test.mjs` ("a restore to another name").

While the mirror is in flight, Convex may still push rows the move just changed. Each row the object changes claims
the fields it changed (`own_at`, `own_fields`); a push that disagrees with a claim is skipped, a push that agrees
releases it, a row the object retired stays retired, and a snapshot never drops a row with a live claim
(`rows.js`, tested in `workspaceRowsOwnership.test.mjs`). Dropping any of these lets a stale push undo a move.

## New notes and missing paths in the object (2026-11-03)

The owner's bar, 2026-11-03: every read and every write answers in under 0.1 s in production, so nothing on a save's
path waits on Convex.

- **A new note's row is made in the object** (`ws.write.adopt`, `workspaceStore/writeOps.js`), with an `o_` id, and
  Convex takes it behind through the mirror's `adopt` op (`objectRowsMirror.adopt`, which keeps `nodes.objectId`).
  Only the plain case is taken: the note's own id key, a live parent folder, nothing live at the path or holding the
  note id. Everything else answers `DEFER` and the control plane adopts it as before.
- **A note meant to be private is adopted only where the object's rules already make it private.** The writer names
  the tier it wrote for (`tier` on the put, `tools/notes/write.js`). The narrowing it persisted first may not have
  reached the object yet, and without that check a member reading the object could see the note before its rule
  lands. A `team` note may be adopted under narrower rules, since its own `team` rule is written right after.
- **A lookup miss is answered by the object** (`absent: true`, `workspaceStore/lookupMiss.js`) when nothing live is
  at the path and nothing reroutes it: no built-in folder's default name standing for another folder, and no Tex folder
  or group chat home, whose new notes are kept in Tex's store under a key only the control plane names. A row the
  reader may not see is never "absent".
- **Known gap:** if Convex makes a row at the same path before the object's adoption reaches it, the mirror answers
  `taken` and drops the change. Both rows then live in the object until the owner of the clash is settled by hand.
  This needs a row made in Convex, not yet pushed, within the same second.

Reversing the tier check fails `writeOps.test.mjs` "a private tier where the held rules make the path team is DEFER". Reversing
the folder-job or Tex check fails `lookupMiss.test.mjs`.
