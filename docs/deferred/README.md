# Deferred work

Changes that were built, reviewed, and deliberately held back — kept as patches
because a squash merge destroys the branch history they otherwise live in, and
because reconstructing them from memory is how a fix returns with its defects
re-invented rather than its lessons kept.

## `folded-twin-refusals.patch`

The write-path half of "A privacy decision is folded" (see
`docs/decisions/privacy-and-sharing.md`). It
refuses, rather than silently no-ops, an operation whose visibility cannot be
expressed because a case-twin holds a narrowing: a `foldedTwinBlocks` probe in
front of `write_note`, `set_visibility`, `archive_note`, `move_note`,
`move_notes` and `move_folder`, a post-condition throw in
`persistExactVisibility`, the control plane's matching throw in `setVisibility`,
and the batch-mover rollback ordering that a throw from inside the apply loop
requires.

**It is not ready, and the reason is the point of keeping it.** Five adversarial
reviews found a defect in it every round, twice at High severity in code the
previous round had declared finished:

- a team-scope existence oracle in `move_folder`, from a fold check placed above
  the scope gates rather than below them;
- a fail-open publish through `set_folder_visibility`'s compaction (the guard
  for that one is the single piece kept in the shipped change);
- a torn write in the batch movers, where `copied.push` sat after the visibility
  write so the rollback could not see the destination it had just created;
- an `archive_note` guard deleted on the premise that an archive destination is
  always `private` — true at owner scope, false at team scope.

The fold engine itself survived all five rounds untouched, which is why it
landed alone.

## How to apply it

`git apply docs/deferred/folded-twin-refusals.patch`, and
`apps/convex/__tests__/deferredPatches.test.ts` keeps that true — a patch that
cannot be applied is worse than none, because the sentence next to it is what
gets trusted.

It is a test rather than a habit because the habit failed twice, the second time
inside the commit that fixed the first: one commit wrote the patch and then
rewrote the comments it takes as context, and the next regenerated it and then
edited one of its files again, further down the same command. Both commit
messages said it had been checked. The check has to run after the tree settles.

It restores four files to the last commit where the write-path apparatus was
complete, so it also reverts what those files gained afterwards — most notably
the two exact-delete checks in `apps/mcp/test/test.mjs`, which pin
`persistExactVisibility` and `clearExactVisibility` and which exist *because*
the apparatus is absent. Re-add them; with the refusals back in front of them
they become defence-in-depth again rather than the load-bearing guards they are
today, and that transition is the thing to get right.

Apply it as a starting point, not as a finished change, and give it its own
review budget.
