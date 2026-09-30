# Pins and "You open most" live on the account, and follow only the mover's moves (2026-09-30)

The phone's new Home (Apple Notes style, approved by the owner on
2026-09-30) shows **Pinned** tiles and a **You open most** rail. The owner
decided both belong to the signed-in person, not the device, so they are the
same on every phone and browser.

- **Where they live.** Two Convex tables, `placePins` and `placeOpens`
  (`apps/convex/functions/lib/schema/places.ts`), read and written only
  through `functions/places.ts`. They hold paths and counts, never note text:
  the same kind of metadata share rows already hold. Nothing takes a user id;
  every function reads and writes the caller's own rows, and a workspace the
  caller is not in is refused like one that does not exist.
- **Bounded.** 60 pins and 300 open rows per person per workspace; opens are
  counted per UTC day and forgotten after 14 days. The stalest open row makes
  room at the ceiling; a pin past it is refused.
- **Swept** with the member when they leave or are removed, with the account,
  and with the workspace.
- **A path is a pointer, not a grant.** The phone intersects every place with
  the tree the person can see now, so a note that moved out of reach, or was
  made private, simply stops showing.

## Only the mover's places follow a move

`moveEntry`, `archiveEntry`, `trashEntry` and `restoreTrashEntry` rewrite the
**mover's** places to the new path. Another member's are left where they
were. The mover saw both ends of the move; another member may not be able to
see where the entry went (a note moved into the owner's private folder), and
rewriting their pin would hand them a path `privacy.md` keeps from them. A
Convex query cannot ask the bucket who may see a path, so the one safe rewrite
is the one whose reader already could. The cost is that another member's pin
on a renamed shared folder stops showing until they pin it again; an undo
brings it back.

Reversing it means a pin that leaks a private folder's name to a team member.
`places.test.ts` ("another member's places are never rewritten") fails.
