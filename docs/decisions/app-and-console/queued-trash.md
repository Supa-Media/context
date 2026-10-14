# Moving to the trash is a queued move

Part of the Convex tree's phase 4 ([convex-tree](./convex-tree.md)). Decided by the owner, 2026-10-14, because a delete that waited three seconds on the bucket read as "not on Convex". It is a queued move whose `to` is under `.context/trash/` (`moveQueue.trash`, `lib/nodes/trashStart.ts`), so the fold drops the note from every listing at once and `canSee` refuses the trash name at every scope. It keeps what a trash made in one go always kept: no rules carried or released (the note's own stay for Restore), no links rewritten, no forwarding, pins left where they are. Restore while it is still queued turns the row around (`nodeMoves.undoTrash`), waiting out a pass that holds it. A delete against a version (the offline queue), a name another move holds, a folder with notes the caller cannot see, or a store without a guarded delete trashes the old way.

If this is reversed, `apps/convex/__tests__/nodes/queuedTrash.test.ts` fails.
