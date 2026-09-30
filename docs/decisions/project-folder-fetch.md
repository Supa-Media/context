# A project folder fetches its own notes

Reported by the owner on 2026-09-29: the same `1-projects` read "In progress
9" on the web and "In progress 2" on a phone, every project reshaped the day
before filed under "Notes · no status" with "Make it a project" beside it.
The phone's copy of the workspace was days behind. The whole-context sync
fetches in listing order, one context after another, and a phone gives it a
few minutes in the foreground at a time, often on a slow network, while two
hundred saved sessions under `0-inbox/` sort ahead of `1-projects/`. The page
somebody was looking at was the last thing it reached.

So a project List or Board asks for its own folder when it opens
(`freshen` → `offline/mirrorFolder.ts`): one manifest walk, then only the notes
under that folder and the notes directly above it (where an inherited status
list is declared) that the device lacks or holds at another version, capped at
500. It only adds current copies and leaves the context's sync status to the
whole-context pass. `offlineMirrorFolder.test.ts` fails if an older copy is
kept, if other folders are read, or if a stopped pass still leaves the List
without statuses; `folderPageView.test.ts` fails if a project folder stops
asking.

Part of [folder lists](./folder-lists.md).
