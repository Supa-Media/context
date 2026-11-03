# Background tree writers, once the object writes the tree (2026-11-03)

Follows [Tree writes go to the workspace object first](./object-row-writes.md) (decided by the owner, 2026-11-02):
for a workspace whose `home` is `object`, the object is the writer of record for its tree rows, grant rows and
access rules, and Convex's `nodes`, `nodeAccess` and `nodeAccessState` are a mirror written behind. The goal here is
that no background job writes those tables for such a workspace except the mirror itself. Every background writer is
one of three kinds:

- **Retire**: a bucket-era migration or repair that means nothing once the notes live in the object. It leaves an
  object-home workspace alone (`notesInObject`, `apps/convex/functions/lib/nodes/notesHome.ts`), or is deleted when
  nothing calls it.
- **Move**: work the product still needs on an object-home workspace. It moves onto the object's write ops
  (`ws.write.*`) once they land, and until then keeps writing Convex, which the row outbox pushes to the object.
- **Mirror-only**: it already writes only what the object decided, or only clears Convex's own copy.

## Retired

| Writer | What it did | Why it has no meaning in the object |
| --- | --- | --- |
| `treeParents.checkDue` / `checkWorkspace` | Set each row's `name` and `parentId` from its stored path (the stage-3 backfill of [paths-on-read](./paths-on-read.md)) | The object keeps its own tree; a placing patch from Convex's paths would be pushed into it as a move. `report` counts such a workspace as `inObject`, never as waiting |
| `nodeFacts.record` | Wrote a fill pass's links and front matter | The control plane keeps no facts for such a workspace ([facts-in-objects](./facts-in-objects.md)); a pass in flight when the home switched wrote them back |
| `noteIds.keepCurrent` and the id check chain | Compared the bucket's keys with the rows and cleared `idCopy` | The bucket is a backup written behind; comparing it to Convex's rows proves nothing, and its patches would reach the object |
| `noteIds.repairSharedIds` | Re-id'd rows that shared a note id | The object's ids are the record; a Convex re-id would rename a note under the object |
| `folderNumbers.run`, `folderNumbersNudge.nudge` | The one-time rename of numbered built-in folders, and the nudge for its stopped moves | A rename there is an object transaction (the file operations workstream); this one-off stays a bucket-era tool, and reports such a workspace as `left` |
| `nodesPurge.resetForStorage`, `noteIdsCopy.carryMoved`, `textGroupGuests.ensureChatFolderGrant` | Deleted: nothing called them | |

The id copy pass, its backfill and its flip (`noteIdsCopy.run`, `backfill`, `flip`) have no production starter
(`beginCopyPass` is reached only from tests) and touch only workspaces still on path keys, so they are left for the
notes-by-id cleanup rather than gated here.

## Moves onto the object's write ops

- **Trash** (moved 2026-11-03): where the notes live in the object, `trashEmptying.eraseWorkspace` no longer claims
  rows in Convex (`trash.claimErasure`). The object removes the due stamp folder itself (`ws.write.erase`,
  `apps/mcp/src/workspaceStore/treeWrites.js`, on `treeOps.remove`), at most 400 rows a call so each mirror change
  stays inside the mirror's 500; the change is a `tree` change with `erase: true`, which deletes Convex's rows and
  their grants, and the answer waits for it. The control plane only names the folder (`trashObject.dueFolder`) and
  keeps the bucket half's record (`lib/trash/objectErase.ts`). With no client for the object the pass removes
  nothing.
- **Old copies**: the owner's delete (`oldCopies.deleteCopies`) moved the same way (`oldCopiesObject.ts`, erasing
  `.context/old-copies` page by page), and an `erasePage` chain begun before the switch hands over to it. Hiding moved too
  (2026-11-03): where the notes live in the object, the hiding pass asks the object to move each copy into
  `.context/old-copies/` (`ws.write.move` with `trash: true`, `lib/oldCopies/hideInObject.ts`) instead of running
  `oldCopies.hideRows`; the tree mirror moves Convex's copy and follows the moved files, and no history needs
  carrying (heads are filed by note id). A copy already gone or a hidden name taken is passed over; an object that
  throws, is busy or defers stops the page for the next pass; with no client the pass hides nothing. Tests:
  `__tests__/oldCopies/oldCopiesObjectHide.test.ts`.

**The bucket half's record is written before the object erases** (`trashObject.begin`), with every key the mirror
holds under the folder, and held back from the bucket half (`trashErasures.objectPending`) until the erase is known
to have happened: the object answered the folder's last page, or a later pass finds the folder gone from the mirror
(`trashObject.settle`). A run that dies between the object's answer and its own record still leaves the keys to
delete, so a note's text and its backup never outlive its erasure; a run that dies before the object erased deletes
nothing a restore could still want. A narrowing that answers `503 MIRROR_PENDING` carries its answer beside the code
(`serveWrites.js`), so an erase whose mirror is late still hands over its files. Tests:
`apps/mcp/test/treeErase.test.mjs` (what an erase may name, pages, the answer beside `MIRROR_PENDING`),
`__tests__/trash/objectEmptying.test.ts` (a whole pass, pages, refusals, a run that dies after the object erased),
`__tests__/oldCopies/oldCopiesObjectDelete.test.ts`, `__tests__/workspaceObjectBackgroundMarks.test.ts` (no mark).
- **Tex chat homes, legacy guest folders and pinned accounts stay on Convex, by the row push** (decided with the
  access workstream, 2026-11-03). `makeChatHome` (through `ensureChatHome`, `textGroups.applyGroupTurn`,
  `guestPass.enrol`, `texChatHomePeople.nameAgain`, `texGroupMigrationRows.homeEveryChat`, `contextMoveChatHome`),
  the legacy guest folders (`syncFolderPeople` through `clearGuests`) and `pinnedAccounts.page` all write access from
  inside a mutation, which cannot call the object. They still converge: the row outbox pushes the access set, and the
  object takes it once its version is above what it minted. Where an object write raced it, the access mirror finds
  `baseVersion` unequal to the held version, lifts Convex one above and pushes again, and the object takes Convex's
  set, the background change included. The delta mirror never brings back a grant either side took away
  (`__tests__/objectAccessMirror.test.ts`). None of them is on a request a person waits on, so the 0.1 s bar does not
  reach them. A queued hand-off to `ws.write.access` (`lib/accessHandOff`, falling back to Convex on `NOT_READY` and
  `NO_ROW`, passing `FORBIDDEN`, `CONFLICT` and `NOT_FOUND` through) is built only if one of them comes to sit on such
  a request. `makeChatHome` also stands folders, which needs the file operations' folder op before it could move.
- **`texMigrationRows.switchKey`**: patches only bytes fields (`storageKey`, `etag`, `idCopy`), which never narrow;
  it moves with the Tex store work.

## Mirror-only

- `nodesPurge.purge` / `forgetWorkspaceTree`: workspace and account deletion. The object goes with the workspace;
  this clears Convex's copy.
- `nodeFactsDrop.drop`: clears Convex's copy of facts for an object-home workspace.
- `accessMirror.apply`: applies the object's member, invite and connection changes, and is `internalMutationMirrored`
  (no row outbox entry) since 2026-11-03. Where the notes live in the object, a member removal no longer deletes that
  person's grants in Convex: it schedules `accessMirrorGrants.drop`, which asks the object to drop them
  (`ws.write.dropGrantee`, with the remover as the actor, so the audit names who acted), and the object's change comes back through
  the access mirror (`objectAccessMirror.dropGrantee`, the same `removeUserGrantsIn` and audit row). Every answer but
  the object's `ok` (`NOT_READY`, a refusal, an object out of reach, no client) takes them out in Convex with a watched
  write, so the row push carries it: a grant left behind would still reach someone the owner removed. Between the
  removal and the drop there is one scheduled call in which the grant still stands. Elsewhere the mirror takes them
  out itself, as before. Tests: `__tests__/accessMirrorGrants.test.ts` (sabotage-checked: ignoring the home fails the
  mirror case, taking any answer as the drop fails the four fallbacks).

## What a simplification would cost

Letting a retired job run on an object-home workspace puts Convex's bucket-era view back over the object's newer
rows: a parent check renames or moves a note, a fact fill brings back a copy the control plane is not to keep, an id
check marks a note as missing from a bucket nobody reads. Tests: `__tests__/nodes/treeParents.test.ts`,
`__tests__/nodes/factsDrop.test.ts`, `__tests__/noteIds/objectHomeChecks.test.ts`,
`__tests__/nodes/folderNumbers.test.ts`, `__tests__/nodes/folderNumbersNudge.test.ts`, each with an object-home workspace left as it was beside a bucket one that
is still repaired. `__tests__/workspaceObjectBackgroundMarks.test.ts` keeps the fact fill's case (it now writes
nothing there) and adds the facts drop, which clears an encrypted note's `sealed` without counting as a narrowing.
