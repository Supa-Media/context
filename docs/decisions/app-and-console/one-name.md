# One source for a note's name: the tree

## Names, existence and front matter come only from the Convex tree (decided by the owner, 2026-10-13, restated 2026-10-14)

"The only thing that should be reading from storage directly should be actually
opening and editing a note ... I don't want to see even fallbacks" (2026-10-13),
and on 2026-10-14, after a day of renames and deletes that disagreed with the
sidebar: "literally everything including file name and frontmatter should be
going through the tree, except note content".

So every question about a *name* is asked of the Convex tree, folded through
pending moves (`lib/nodes/moveOverlay.ts`): listing a folder, whether something
already sits at a path (rename, move, new note, new folder, duplicate, archive,
trash and restore destinations, name twins), whether a path is a file or a
folder, picking a free name, and a note's front matter. Storage is opened for
a note's body, for the conditional write that makes a change real, and for the
background work that keeps the tree current (sweeps, the mover, search index
builds, export, hand-off, encryption walks, publishing page bodies).

**Why it matters more since the queued moves.** A rename or delete is drawn in
the tree at once and copied in the bucket behind it (`queued-trash.md`,
`storage-move-engine.md`). Anything that asks the bucket for a name during that
window disagrees with what the person sees: on 2026-10-14 naming a note
`kings-20` was refused as "already exists" while the sidebar showed no such
note.

**The bucket still has the last word on a write**, through the conditional
write itself (`onlyIf: { absent: true }`, etag matches). The tree decides what
a person is told before anything is written; the bucket refuses a write that
would overwrite something the tree has not caught up with yet. Never the other
way round, and never a bucket listing to decide the first.

**What a "simplification" would cost.** Reading the bucket "just to be sure"
before a write is the bug this replaces: it is the second source of truth that
the queued moves make wrong for seconds at a time.

## A rename rewrites the heading inside the move

A note's first heading is its name (`quick-create-and-activity-feed.md`). The
console used to rewrite the heading itself after the move answered, as a second
write; by then the editor had moved to the new name and the device's own owed
renames were still running, so two writers rewrote one heading and the
collaborative merge kept both ("kkingsngs-6", 2026-10-14).

The heading step is now part of the move (`lib/fileOps/followHeading.ts`,
asked for with `followHeading` on `moveEntry`), run against the exact version
the move produced: if anything wrote to the note since, the heading is left
alone. The console asks for it only when the note on screen holds no typing the
move must carry. One rule for both sides lives in
`packages/shared/src/linkedHeading.ts`.

Tests: `apps/convex/__tests__/fileOps/followHeading.test.ts` (a later write
wins), `apps/mobile/__tests__/linkedTitleRename.test.ts` (no second heading
write from the console).
