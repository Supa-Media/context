### ⌘K draws names from the tree first, and nothing it drew moves

_Decided by the owner, 2026-10-27 (the search tune-up, boards M1, M2 and P1),
reversing the 2026-10-09 "server's order, loaded names folded in"._

The palette's instant names came only from folders already loaded on this
device, and when the search answered a second or more later, the whole list
was redrawn in the server's order: the row under the cursor moved. Now:

- **Names come from the tree, in every workspace, from the first letter.**
  `functions/nameSearch.ts` is a reactive Convex query over a search index on
  `nodes.name` (`search_name`, filtered by workspace and kind). It is a name
  index, never a body: the control plane holds names already, and this reads
  nothing it did not. Every row passes the reader's live `canSee`
  (`readerView`), so a private name is not handed to a member, and the scope
  is the caller's live memberships (`searchScopeFor`), so naming another
  workspace's id in `contexts` searches nothing.
- **The order is stable** (`paletteMerge.ts`, `mergeRanked`): a command whose
  name beats every note; then notes whose names hold what was typed, in the
  order drawn; then the search's rows in its order, words before meaning
  (`withMeaningRows`); then loose letter-in-order name matches. What is on
  screen while the search runs is the top of the final list.
- **Notes found only by meaning fold** into one "N more about the same topic"
  line when anything else matched (`foldSameTopic`); tapping it opens them.
  With nothing else found they are the answer and stay open.

The phone's palette is the same component, so it gets the same order.

Reverting fails `apps/convex/__tests__/nameSearch.test.ts` (who does not see a
name), `apps/mobile/__tests__/paletteMerge.test.ts` (the order and the fold) and
"names first" in `apps/mobile/e2e/webkit/paletteResults.spec.ts`.
