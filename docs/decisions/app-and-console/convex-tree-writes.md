# App and console — a write asks the Convex tree whether a name is taken

Split out of [convex-tree](./convex-tree.md) on 2026-10-14, step 3 of the
owner's "only opening or editing a note reads storage" sweep (2026-10-13).

**A write asks the tree whether a name is taken** (step 3, 2026-10-14). Every
destination check of the console's moves, copies, restores, archive stamps,
new folders, Undo of a new folder, routine runs and privacy reset, and of the
gateway's `move_note`, `archive_note`, `move_folder` and
`set_folder_visibility`, reads the rows through pending moves
(`lib/nodes/treeTaken.ts`; for the gateway, `/gateway/tree/facts` with
`ask: "names"`, unfiltered and so only for an owner or editor with
`context:write`). The free plan's cap counts the same rows, and admits a
create while the tree cannot answer. A tree still loading refuses the write.
The rows lag a write made past us, and the gateway's touch by a second, so
**the write itself is the truth**: every destination is put `onlyIf: {
absent: true }` where the store can hold it, and a folder move or copy that
meets such a name stops part way, what moved keeping its visibility. **On B2
and Wasabi**, which cannot, the tree's answer is the whole check: a file
written there past us in the last seconds can be overwritten by a move onto
its name, and that is the honest limit of such storage, as `moveSafetyRefusal`
already says for the gateway. What still reads the bucket: the note being
written; plumbing (trash names, a routine's run log, collaboration history);
the queued move worker, sweeps and touches; `move_folder`'s source listing;
and the cross-context move's and vault import's destination checks, not yet
moved.

**A store that ignores key order is paged by its own token** (2026-10-14).
The sweep sees a key out of order and pages by the continuation cursor instead,
kept in the tree's row, restarting once if it expires. `unsupported` is left
only for a store with neither, retried daily.

**`write_note` and the status list ask the tree too** (owner, 2026-10-14:
"everything including file name and frontmatter should be going through the
tree, except note content"). `write_note` asks the tree whether its note
exists (`tools/notes/present.js`) and opens the note only after every
permission check, so a refused write costs the same whether or not anything
is there; an edit that passes `expected_etag` opens it directly. A note the
tree has not heard of yet meets the create's `onlyIf: { absent: true }` and is
refused as a lost race, never overwritten. A folder's statuses come from its
front note's properties in the tree (`factProps`), never from opening it.

What fails if reversed:

- `apps/convex/__tests__/files/treeWriteNames.test.ts`,
  `fileOps/partialMove.test.ts`, `nodes/gatewayNames.test.ts` and
  `apps/mcp/test/treeWriteNames.test.mjs`: a name only the tree holds is
  refused, one only the bucket holds is refused by the write, a loading tree
  refuses, only a writer is told names, `write_note` never opens a name the
  tree calls free, and a status list is read from a front note only the tree
  holds; `privacyGroups.test.mjs`: a refused write costs the same whether or
  not the note exists; `nodes/sweepTouch.test.ts`: a
  tree is filled by its store's token.

### A share link's mint check asks the tree

Minting an unlisted or collect link checks two things: that the link's readers, at `team` scope with no names, would see the note, and that the note is not sealed. Both answers now come from the tree's rows, the rules mirror and the facts (`nodes.teamShareable`). The note itself is never opened (decided by the owner, 2026-10-14).

A note that is hidden and a note that is missing still give the same refusal. A tree that is still loading answers `TREE_LOADING`. If a note was sealed after its facts were last read, the mint can let it through; `readThroughShare` still refuses that note live, as it always has.

**What fails if reversed:** `shareAnyone.test.ts`, "minting asks the tree, and never opens the note".
