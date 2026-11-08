# The control plane's tree reads come from the workspace object (2026-11-03)

Part of the owner's "Yes, all tree writes" (2026-11-02): when nothing reads Convex's `nodes`, `nodeAccess`,
`nodeAccessState` and `nodeTrees` for a workspace on its object, the mirror into those tables can stop. Readers move
in parallel with the writers, one at a time, each proven equal to Convex's answer first.

**Decision.** `servedNodesStore` (`apps/convex/functions/lib/nodes/manifestStore.ts`) is the one store every console
tree read pages (the file list, the walk, note and folder paths, the map, a folder's notes, the chaos score, folder
icons) and the gateway's `/gateway/tree/manifest` and `/gateway/tree/facts` read. For a workspace whose home is
`object` it pages the object's live file rows (`ws.rows.files`, through the door, `lib/nodes/objectTreeStore.ts`) and
judges them by the rules the object holds for the reader's audience. Callers judge with `canSee` as before; only
where the rows and rules come from changes.

Convex's rows answer only while the object cannot be the whole answer: the push's outbox holds a change Convex
committed and the object has not taken (`workspaceObjectPush.waitingSince`, what a binding's `notesBehind` says), a
chunked move is being drawn over Convex's rows (`nodeRowMoves.drawn`), the object says `behind` (a mark is open), or
the gateway cannot be reached from the deployment. A walk whose later page finds the object behind fails
(`ObjectTreeBehind`) rather than mix the object's rows with Convex's.

The barrier's `list` (one folder: `files.listFiles`, shared folder links, share cards, routines, plugins) asks the
object for that folder (`ws.rows.listing`), drawn as the live tree socket draws it at the clearance the control plane
resolved, under the same fallbacks (2026-11-03).

The gateway's facts ask `jobs` (which folder does each built-in job, and the root folders a reader may see) is
answered by the object itself (`workspaceStore/jobsAnswer.js`), judged with the listing's `folderVisibleAtScope`.

A check-in's changed-since read (`changedNodesStore`) and the device change feed's catch-up (`nodesFeed.changes`)
stay on Convex for now. The feed's cue no longer does: since 2026-11-06 the object pushes a head of its own over the
tree socket ([no-convex-for-notes](./no-convex-for-notes.md), "The object pushes the change signal").

**A read's own lookups (2026-11-03).** The id layer asks a read's question (`get`, `head`, `exists`, one read's
view) through `lookupRead` (`store/idLayout.js`): for a workspace on its object, a path the object answers "not
found" for, while not behind, is no note for that reader, as the control plane would say, and the control plane is
not asked. A write keeps the full lookup, because a new note's Tex home is known only there. And a read of a note
whose Markdown already says what its accepted collaboration state says, under a new version, records the version
instead of rewriting the same bytes (`packages/collaboration/src/load.js` `finalizePending`): that rewrite was a note
write on a read, with a control-plane `note-ids/wrote` round trip, for nothing. Bytes that differ are still repaired
to the accepted state.

**What a simplification would cost.** Reading the object without the outbox check serves a share taken back by a
public mutation from the object's older rules until its push lands; reading it while a mark is open does the same
for a narrowing in flight. `apps/convex/__tests__/workspaceObjectTreeReads.test.ts` proves parity after a real push
for an owner and a team member, that an object-only row shows, and that each fallback holds (each confirmed by
sabotage); `apps/convex/__tests__/workspaceObjectJobs.test.ts` runs Convex's folder-jobs logic and the object's over
one fixture.
