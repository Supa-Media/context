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

- **Trash**: `trash.claimErasure` (with `removeRow`), run by `trash.emptyDue` and `trashEmptying.eraseWorkspace`.
  Already marked (`objectFirst`); becomes an object delete, answered once the mirror has it.
- **Old copies**: `oldCopies.hideRows` (a move into `.context/old-copies/`) and `erasePage` (the owner's delete).
  `erasePage` narrows without a mark today.
- **Tex chat homes**: `makeChatHome` (through `ensureChatHome`, `textGroups.applyGroupTurn`, `guestPass.enrol`,
  `texChatHomePeople.nameAgain`, `texGroupMigrationRows.homeEveryChat`, `contextMoveChatHome`), and the legacy guest
  folders (`syncFolderPeople`, `clearGuests`). A turn and `nameAgain` are marked; `guestPass.enrol`'s legacy branch
  and `texGuestRetire`'s `clearGuests` can narrow unmarked.
- **Pinned accounts** (`pinnedAccounts.page`): a one-off that rewrites `@context-lc`'s grants and narrows unmarked.
  It retires once production reports it done; until then it moves with the access writers.
- **`texMigrationRows.switchKey`**: patches only bytes fields (`storageKey`, `etag`, `idCopy`), which never narrow;
  it moves with the Tex store work.

## Mirror-only

- `nodesPurge.purge` / `forgetWorkspaceTree`: workspace and account deletion. The object goes with the workspace;
  this clears Convex's copy.
- `nodeFactsDrop.drop`: clears Convex's copy of facts for an object-home workspace.
- `accessMirror.apply`: applies the object's member, invite and connection changes. A member removal also deletes
  that person's grants through `removeUserGrantsIn`, which opens a row outbox entry back to the object; that echo is
  closed by the mirror's rowWatch skip, which the foundation work owns.

## What a simplification would cost

Letting a retired job run on an object-home workspace puts Convex's bucket-era view back over the object's newer
rows: a parent check renames or moves a note, a fact fill brings back a copy the control plane is not to keep, an id
check marks a note as missing from a bucket nobody reads. Tests: `__tests__/nodes/treeParents.test.ts`,
`__tests__/nodes/factsDrop.test.ts`, `__tests__/noteIds/objectHomeChecks.test.ts`,
`__tests__/nodes/folderNumbers.test.ts`, `__tests__/nodes/folderNumbersNudge.test.ts`, each with an object-home workspace left as it was beside a bucket one that
is still repaired. `__tests__/workspaceObjectBackgroundMarks.test.ts` keeps the fact fill's case (it now writes
nothing there) and adds the facts drop, which clears an encrypted note's `sealed` without counting as a narrowing.
