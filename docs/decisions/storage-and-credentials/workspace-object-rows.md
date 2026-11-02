# Every row write reaches the workspace object (2026-11-01)

A workspace whose notes are judged in its object (`workspaceObjectHomes.home === "object"`) has its tree rows and
access rules copied there, and the object decides reads by them. Convex keeps taking the writes, from more than
thirty places, and a Convex query or mutation cannot call the object.

**Decision.** No writer is trusted to remember. Every mutation in the deployment is built by
`apps/convex/functions/lib/rowWatch/mutations.ts`, which watches the mutation's database: each write to `nodes`,
`nodeAccess` or `nodeAccessState` is recorded, and when the handler returns, each object-mode workspace it touched
gets one outbox entry in the same transaction and a scheduled push (`functions/workspaceObjectPush.ts`). One drain
holds a workspace at a time (a lease), reads the named rows as they stand (paths built from parents), renders the
member and guest rules, and sends rows, removals and rules in one `ws.apply`, so a moved folder is never judged by
the old rules. The object keeps a row only from a newer clock and rules only from a newer access version; an entry
leaves the outbox only after the object took it. Actions that move, hide or narrow (app file operations, the
gateway's `setAccess`, removals, moves) wait for the push before answering (`objectSettled`). Public mutations the
app calls directly (`nodesAccess.setGrantees`) cannot wait, so the gap is closed on the read side: while any entry
waits, every binding the gateway opens carries `notesBehind`, and that request's lookups go to the control plane,
which already has the change. A share taken back is never served from the object's older rows
(`__tests__/workspaceObjectPush.test.ts`, "a share taken back by the app's own mutation…").

A gateway request's own write (a save's `setAccess`, a keyed note's `wrote`/`adopt`/`removed`, a group turn) waits
only 2.5 s and does not run the push inline (`GATEWAY_SETTLE`), and the gateway gives that bookkeeping 15 s
(`CONTROL_PLANE_WRITE_TIMEOUT_MS`). With the full ten-second wait under the gateway's 8-second lookup timeout, a
workspace whose push stopped landing refused every note save as "control plane unavailable: timed out" although each
change had committed (2026-11-02). Not waiting longer is safe because the read side already covers the gap above. A
failing push records its reason as a short code (`workspaceObjectPushFailures`), read with the outbox's depth from
the `Workspace object marks` workflow (`__tests__/workspaceObjectGatewaySettle.test.ts`,
`__tests__/workspaceObjectFirst.test.ts`).

**What a simplification would cost.** Importing `mutation` from `_generated/server` again, or hooking writers one by
one, lets one missed writer narrow access in Convex while the object goes on showing the note.
`__tests__/rowWatchGuard.test.ts` refuses any file that builds a mutation around the wrapper;
`__tests__/workspaceObjectPush.test.ts` proves a narrowing and a one-row folder move reach a real object through the
real door, and that a failed push keeps its entries.

## The object hears first (2026-11-02)

Decided by the owner, 2026-11-02 ("option C": tree writes go to the object first, not Convex first), so a read
never needs to ask Convex whether the object is behind.

**Decision.** A write that may narrow what someone sees (an access row, a row changed beyond its bytes, a row
replaced or deleted) opens a **mark** in the workspace's object before Convex takes it
(`functions/lib/rowWatch/objectFirst.ts`, `apps/mcp/src/workspaceStore/marks.js`). From that moment the object knows
a change is coming: a member's lookup or resolve waits for it (up to 2 s), and if it still has not landed the answer
says `behind: true` and the gateway answers from the control plane (`store/objectLookup.js`). The mutation commits,
its push lands, and the mark closes in the same storage transaction as the rows that carry the change (`ws.apply`
`close`), or by the writer once `objectSettled` saw the push land. If the object cannot take the mark, the write is
refused: the object goes first or the change does not happen. A mark whose writer died expires after 10 minutes;
until then the object fails toward the control plane, never toward wider rows. Writes that only add (a new note, a
copy, a restore) or only change bytes take no mark: an object behind on those shows less, never more.

Who opens marks: every narrowing file operation (the barrier in `lib/filesFns/fileOperationBarrier.ts`, `NARROWING_OPERATIONS`), the gateway's
`setAccess`/`addGrantees` and removals, the console's visibility change, and the share dialog, which now calls the
action `nodesAccessFirst.setGrantees` instead of the mutation. Any narrowing written with no mark open is still let
through and recorded with the module that defined its mutation (`workspaceObjectUnmarked`, reported by the "Workspace
object marks" workflow); a new name there is a writer to move behind a mark, not a reason to ask Convex per read again.

Writers with no request behind them go first too (2026-11-02, from the report's first 72 hours): the trash's erasure
(`lib/trash/erase.ts`), a stalled chunked move's pages, which the watchdog now runs from an action
(`nodeRowMovesMarked.ts`), the folder-numbers nudge, the Tex group migration's trashing, a restore out of the trash
(`restoreTrash` is in `NARROWING_OPERATIONS`), and sharing a Tex bug report or review with the team (`bugNotes.ts`). A
fact fill is not a narrowing: a row's `sealed` is a parsed fact (its text could not be read), not a rule, and the
object's row does not carry it. A narrowing that still skips the object is covered by its push: the drain opens a mark
before the round that carries an unmarked entry and closes it with those rows, so a push that fails leaves the object
saying behind instead of serving the old rows (`lib/rowWatch/drain.ts` `coverUnmarked`). That cover starts after the
commit, not before it, which is why the report, not the cover, decided when the behind check went.

The last two names the report gave (2026-11-02): a new note's path (`noteIdsKeyed.adoptKeyed`) and a legacy guest
chat's turn (`textGroups.applyGroupTurn`). A new note brings a gone row back (its `goneAt` cleared, nothing else that
places or judges it named) and may remove a bare tombstone folder (gone, no `access`) to take its name; a gone row is
seen by nobody and a folder is gone only while nothing live is under it, so the row watch no longer counts either as
a narrowing (`lib/rowWatch/watch.ts` `bringsBackOrClears`). A tombstone that carries a rule still judges, and its
removal still counts. A legacy guest chat's turn may take its people off the chat's folder (`clearGuests`), so the
gateway route asks which workspaces a turn may touch and runs the turn inside `objectFirst` for each
(`textGroupsMarked.ts`). A chat with a home is the other such turn: the home's row in the pinned workspace names
exactly the chat's people (`makeChatHome`), so a turn after somebody left takes them off it, and the backfill that
names every home again (`texChatHomePeople.ts`, named by the report once it ran) is an action that writes inside the
pinned workspace's mark. A chat with neither writes no rule and runs with no mark. The same report named one more
`nodeRowMoves.rowMove`: a keyed move (`nodesMoveStart`, `nodesMoveBatch`) was run by the barrier before its marked
path, so it never opened the mark its kind is listed for; it now runs inside `markedIfNarrowing` too. After that
deploy the report still named `adoptKeyed`: a note born where access was asked for it before it existed takes
that access in the same mutation (`lib/nodes/pendingAccess.ts`), a patch of the new row and of `nodeAccessState`.
The row watch now treats a patch of a row inserted in the same mutation as no narrowing, and a `nodeAccessState`
patch that only drops pending entries and appends snapshot entries for those born rows the same way; a private
pending entry already closed the path for every reader.

**The per-read behind check is gone (2026-11-02).** With the report empty after the background writers moved, the
gateway stopped asking Convex `/gateway/objects/behind` beside every object lookup, resolve, manifest and facts call:
the object's own `behind: true` (an open mark, or a push it knows is coming) is the whole answer, and only that sends
the read to the control plane (`store/objectLookup.js` `settledBehind`). Two once-per-connection checks stay: opening a
store from the object's kept binding (`store/objectBinding.js`, for a binding changed but not yet pushed) and the live
tree socket (`live/treeRoute.js`). Putting the per-read check back costs a Convex round trip on every object read;
`apps/mcp/test/objectLookup.test.mjs` proves an object that is not behind is the whole answer.

**What a simplification would cost.** Closing a mark before its push lands, or letting a write go on when the object
refused its mark, puts back the window where a share taken back is served from the object's older rows.
`__tests__/workspaceObjectFirst.test.ts` holds the push off and proves the object says behind until it lands, that the
mark is opened before any outbox entry exists, and that a refused mark leaves Convex unchanged;
`apps/mcp/test/workspaceMarks.test.mjs` proves a lookup waits for the push and closes with its rows.
