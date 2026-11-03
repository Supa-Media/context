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

## File operations in the object (2026-11-03)

`apps/mcp/src/workspaceStore/treeOps.js` holds create folder, move and rename, trash, restore and delete over the
object's rows, with the refusals Convex's row move gives (`rowMove.ts`, `rowTrash.ts`, `archiveTwins.ts`,
`sealedChats.ts`), each one synchronous run of SQL so the object commits it whole. A folder move rewrites every path
under it in that one transaction: nothing is chunked, because a workspace's rows fit in its object. A note outside the
trash is never deleted in one step; it goes to the trash, as Convex refuses a keyed delete. Each answer names the rows
it wrote and the ids it removed with their clocks, for the outbox. Rows the object makes take ids `o_` and 32 hex
characters. Whether the caller may see what it moves is the caller's `judge`, built from the rules it holds. Tests:
`apps/mcp/test/treeOpsMove.test.mjs`, `apps/mcp/test/treeOpsTrash.test.mjs`.
