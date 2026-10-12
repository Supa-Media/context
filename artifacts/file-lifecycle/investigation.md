# Context file lifecycle investigation

Investigated on 12 October 2026 against `origin/main` at `a3d6da24`. File operations can leave the tree, tab, editor and URL describing different paths. Seven controlled reproductions confirm failures in the current client. Fixing this needs a shared lifecycle for pending operations and reconciliation, including the storage result, rather than more independent redraw callbacks.

Status: client repairs implemented locally after syncing to `origin/main` at `c1366060`; no deployment performed. The historical investigation below describes the original failures. The original checkout at `/Users/lilseyi/Code/context` has unrelated edits and was left intact. Evidence is on branch `codex/file-lifecycle-investigation` in `/Users/lilseyi/Code/context-seyi-repair`.

## Live observations

Staging at `https://staging.context.lc/console/@seyi` signed in but reported “This context's bucket configuration could not be used. Reconnect storage.” That prevented file-operation reproduction there.

Production was tested using a synthetic root note titled `Codex file lifecycle probe 20261012`, containing only an investigation marker. New note initially appeared as `untitled-2026-10-12.md`. Replacing its heading and entering body text changed the tree and tab label. The tab subsequently identified the new `.md` path while the URL and footer still named the original untitled path. This disagreement persisted across several observations over minutes. Clicking the renamed row opened the new path with the expected content.

Duplicate produced the expected copy after waiting for its operation and listing refresh. The original untitled row also reappeared. Opening it displayed the synthetic content at the old address with a reconnecting collaboration indicator; trying to trash that old row returned “That file does not exist.” Reads explicitly follow forwarding on a missing path, whereas trash acts on the requested path, so opening the old row does not prove a second physical file exists. The old row disappeared after the next successful operation refreshed the root.

The renamed synthetic note and its duplicate were moved to recoverable trash. No preexisting note was edited. Screenshots record the old-path display and the stale-row refusal. The browser observations establish visible inconsistency; the seven harness reproductions below establish specific client mechanisms. They do not establish which precise network timing caused the production mismatch.

## Current infrastructure

The UI is a React and Expo application. `useFileBrowser.ts` composes separate hooks for listings, reads, creation, moves, row commands, offline work, saving and linked titles. `useBrowserState.ts` owns the bucket-listing state, editor, selection, operation generation and rename event. The offline layer overlays queued changes over the bucket listings. The tab strip maintains its own reducer in `useTabs.ts`; the URL follows selection through `useNoteAddress.ts`.

Convex actions authorize operations and access the configured storage through `runFileOperation`. File bodies remain in the configured provider. The backend move engine handles collaboration identity, privacy, forwarding, and reference rewrites. A derived tree table is maintained asynchronously through scheduled `touchTree` work and emits a tree-change hint. The client also merges mirror snapshots and folder listings. This is already partly centralized, but these pieces do not share one pending-operation contract.

Create, folder creation, and rename already draw optimistic rows. Duplicate waits for its backend result and refreshed listing. The opening comment in `useFileBrowser.ts` still says nothing is optimistic; that comment contradicts the implementation and should be corrected.

## Reproduced failures

The original evidence harness mounted the real `useFileBrowser` and `useTabs`, with controlled storage promises, and asserted the broken behavior. It has now been replaced with ordinary regression tests asserting the repaired behavior.

| Failure | Trigger and observed result | Code responsible |
| --- | --- | --- |
| Clicking a pending renamed row closes the note | Hold `moveEntry`, click the destination row already drawn in the tree. The read asks storage for a path that does not exist yet, closes the editor and reports “That file does not exist.” Completing the move does not reopen it. | `useRowCommands.ts:187–234`; `useOpenNote.ts:172–201`. The tab-follow effect has a rename guard, but ordinary selection has no corresponding pending-online-rename resolution. |
| A refresh restores the old tree row | Begin a folder refresh after optimistic rename but before storage commits. The old path replaces the destination in the tree, while the tab still names the destination. | `useListings.ts:107–125`; `useBrowserState.ts:39–48`. Request start time protects against older requests but does not protect a pending operation from newer reads of precommit storage. |
| A second operation strands the editor at the old path | Begin rename, run another operation, then complete the rename. Storage and the tab use the destination; editor and selection use the deleted source. | `useRunOperation.ts:131–155`; `useRowCommands.ts:218–238`. A global generation suppresses the earlier operation's result and returns `false`, which the rename caller treats like a failed mutation. Toolbar disabling does not enforce serialization inside the operation API. |
| Confirmation refresh can hang indefinitely | Complete the mutation, hold the subsequent folder listing, advance time by 60 seconds. `busy` remains true and editor/selection stay at the source. | `useRunOperation.ts:137–145, 175–203`. Only mutation work is timed; confirmation refresh is unbounded. Rename follows the editor only after that refresh resolves. |
| A successful late rename is never reconciled | Hold the mutation past 45 seconds, then let it succeed. The client has cleared busy but keeps editor and selection at the source, with the tab at the destination. | `useRunOperation.ts:157–166`; `storage/timeout.ts:finish`; `useRowCommands.ts:234–238`. Late results are discarded, and unknown completion is represented by the same boolean as failure. No late-success reconciliation follows. |
| Initial root load erases a successful create | Hold the initial root listing, create a root note and let its write and refresh finish, then release the old root response. Storage contains the new note, but the root no longer lists it and the tab-pruning effect closes the editor. | `useListings.ts:270–271, 335–340`; `useTabs.ts:135–145`. Initial root acceptance bypasses the freshness guard used by ordinary refresh. |
| A slow create overrides later navigation | Hold a new note's write, navigate to another note, then complete the create. The editor jumps back to the newly created note. | `useNoteCreate.ts:153–163`. `latestCreate` tracks newer creates, but not subsequent navigation. |

## Additional contributors from code inspection

Duplicate has no optimistic row or success message: `useRowCommands.ts:264–269` waits for the action, then refreshes. This directly accounts for delayed appearance even when the operation succeeds.

Rename does extra work after the file has moved. The backend awaits privacy remapping, forwarding and reference repair (`lib/fileOps/moving.ts:250–279`). The reference fallback scans visible notes and reads them sequentially up to its 4,000-note cap (`lib/fileOps/references.ts:80–105`). On a smaller context with a slow provider this can consume the UI's timeout after storage has already moved the file. On contexts above the cap, the fallback reports that reference rewriting was capped; latency must be measured rather than attributed to the sequential loop in that case. The frontend also awaits a title read/write before confirmation refresh (`useRowCommands.ts:196–197`).

The old name is not always an error in title linking. Automatic rename is conditional on the note being linked, the local title being touched, the caret leaving the title, and editor state being clean or saved (`useLinkedTitle.ts:235–249`). The label can preview a proposed filename before the operation commits. Refusal consumes the attempted title, and the heading and filename may then differ. These rules need clear pending and failed states in the UI.

## Proposed repair sequence

1. Replace `run`'s boolean with explicit committed, rejected, pending/unknown and superseded presentation outcomes. Every operation must reconcile its own storage result even if another operation now owns the toast or toolbar. Bound refresh separately and move the editor to the committed identity without waiting for that refresh.
2. Track pending operations by workspace and stable document identity, with source, destination and affected folders. Resolve clicks on optimistic destinations through that pending record. Keep the open document, tab, selection and URL attached to the same identity throughout rename. Freeze or flush collaboration writes through the same lifecycle.
3. Derive the displayed tree from confirmed listings plus pending changes. Refreshes and mirror walks update the confirmed base; they cannot remove an unresolved overlay just because their request began after the operation. Apply the same request-generation rules to initial root loads. Preserve server permission refusals as authoritative.
4. Let creation open immediately from a durable local draft, and only move selection on completion if the user has not navigated elsewhere. Give duplicate a pending row and distinct completion/failure feedback. Keep rollback and retries tied to operation IDs.
5. Separate secondary work such as reference repair and derived-index maintenance from the critical file-move acknowledgement where consistency permits. Use explicit progress/recovery for work that must stay synchronous. Keep conditional writes and privacy guarantees.
6. Convert the evidence cases into regression assertions for desired behavior. Extend them through the route and real collaboration layer, then exercise create → title edit → body typing → duplicate → rename → undo → navigation with delayed, reordered and lost responses.

Updating the tree first is already the right responsiveness direction, and the client already does it for several commands. The missing piece is one durable operation state that every surface follows until storage confirms or rejects it. Making the visible tree the only source of truth without that lifecycle would retain these races.

## Original investigation validation

Seven investigation reproductions pass on the unfixed implementation. The four existing suites for open-note rename, linked-title rename, quick creation and live listings also pass: 43 tests. Existing coverage checks the tab survives a refresh during rename, but does not require the tree to keep the new row; it also misses click-through to a pending destination, late completion, root-response ordering and navigation during creation.

Run from `apps/mobile`:

```sh
pnpm exec jest --runInBand --watchman=false --testMatch '**/fileLifecycle.investigation.ts'
pnpm exec jest --runInBand --watchman=false __tests__/renameOpenNote.test.ts __tests__/linkedTitleRename.test.ts __tests__/quickNoteCreate.test.ts __tests__/liveListing.test.ts
```

## Implemented client repair

A shared online-change registry overlays pending creates and renames over confirmed listings. It retains committed changes until live pages confirm their identities, carries chained create/rename/undo changes to their final paths, resolves waiting selections, and discards overlays on authoritative refusal or workspace departure. The offline queue remains the existing durable source for offline operations.

Mutation results now reconcile independently of the operation that currently owns the toolbar and notice. A 45-second timeout releases the toolbar but keeps watching the original storage promise. Confirmation refresh has a separate 10-second bound and cannot turn a committed mutation into a failure. Stale callbacks and unmounted browsers cannot begin or reconcile operations.

Rename and its undo use the same lifecycle. The editor and selection take the committed path immediately, carrying unsaved drafts while title maintenance and the canonical read run with separate bounds. Per-operation draft holds survive overlapping renames and navigation. Clicking a pending destination waits for storage; folder destinations reuse ordinary folder navigation. Duplicate draws the server's authoritative destination after commit and reports success without waiting for tree confirmation.

Creation waits for its original write before opening a clicked row, protects its optimistic row from stale refreshes, and preserves later navigation. Initial root loads and ordinary refreshes share monotonic request stamps, including equal-millisecond responses. Workspace epochs protect against responses from an earlier visit, including A → B → A, and reset stale operation presentation.

Three sub-agents implemented separate portions and reviewed one another's changes. Their review passes caught and drove fixes for overlapping draft holds, same-millisecond refresh ordering, permission-refusal cancellation, stale callbacks, chained overlays, and pending folder navigation. No backend storage, forwarding, collaboration protocol, or reference-repair behavior was changed.

The new suites are `fileLifecycle.test.ts`, `fileCreateLifecycle.test.ts`, `runOperation.test.ts`, and `onlineChanges.test.ts`. They exercise real browser/tab/address hooks where relevant and controlled storage promises to force the adverse orderings. Live validation of the repaired code still requires a deployment; staging's bucket configuration remains a separate issue.

## Final repair validation

- **44 suites, 665 tests passed** across file lifecycle, creation, rename/title linking, tabs, operation timeouts, optimistic updates, offline work, guards and bulk operations.
- ESLint passed all modified application and test files; `git diff --check` passed.
- `tsc --noEmit` remains unsuccessful due to unrelated repository diagnostics (case-colliding component/helper filenames, missing component exports, admin agent types and existing tests). No final diagnostics reference modified application files or the new regression suites.
- No deployment or post-deployment browser test was performed.

From `apps/mobile`:

```sh
pnpm exec jest --runInBand --watchman=false --silent --testPathPattern='(fileLifecycle|runOperation|fileOperationTimeout|fileBrowserGuards|quickNoteCreate|fileCreateLifecycle|untitledTitleAdoption|linkedTitleRename|renameOpenNote|onlineChanges|optimistic.*|offline.*|fileTabs|tabsContextSwitch|linkedNote|fileErrorCallSites|bulkFileOps)\.test\.ts$'
```
