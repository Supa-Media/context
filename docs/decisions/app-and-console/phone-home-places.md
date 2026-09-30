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

## The phone's Home, and a bottom bar that is Apple Notes' (2026-09-30)

The owner approved the Apple Notes style Home and asked for "the exact Apple
Notes nav bar" on every phone screen. So:

- **Home is the workspace's own page on a phone** (`home/PhoneHome.tsx`), in
  place of the root folder listing: tag chips, Pinned, You open most, the
  three most recent notes, All folders with what each holds (notes and
  folders counted all the way down), and then the Notes that sit outside
  every folder. That last section is not optional: Home replaced the only
  listing of the root, so without it a root note (`todo.md`, or a website's
  Pricing page for a visitor) had no way in. A pointer layout keeps the
  listing, because its tree is on the screen beside it.
- **The bottom bar is a search field with a microphone, and a round
  new-note button** (`ConsoleBottomBar`). The five keys it replaced each
  have a home: Back is the path bar's and the system's; Browse and Recent are
  what Home lists. The microphone opens search, where the keyboard's own
  microphone key dictates.
- **A new note is one press**, in the folder on screen, and from Home in the
  Inbox (`0-inbox`, created by the note if the workspace has none). **Held**,
  the button raises the sheet with everything else a `+` starts — a drawing,
  a folder, a chat, a meeting — so none of those lost their route on a phone.

Reversing it means a bar of keys that duplicates Home, or a create sheet in
front of every note. `phoneHome.test.ts`, `bottomRowWidth.test.ts` and
`consoleChrome/phoneDestinations.test.ts` fail.

## A folder's page, and "Search in <folder>" (2026-09-30)

Boards 07, 07b and 08 of the same artboards.

- **Under a folder's title on a phone** (`home/PhoneFolderHead.tsx`): what
  it holds, counted all the way down; the faces of whoever changed something
  in it this week (an agent is a robot); the latest change in one line, which
  opens that note; and two buttons, New folder inside and ••• for the
  folder's own menu. It replaces the pointer layout's visibility sentence,
  which the people mark beside a shared folder's name already carries.
- **Pin to Home** is a row in a single file or folder's menu, at every
  density, and it writes the account's pins above.
- **The bottom bar reads "Search in Clients" on a folder's page**, and the
  search it opens asks the gateway with `prefix: "clients/"` — the trailing
  slash so a sibling named `clients-old` never matches. The device's copy and
  the loaded names are narrowed by the same test. One chip, Everywhere,
  widens it; closing search forgets the folder, so ⌘K or Home's field always
  searches the whole workspace.

Reversing the reset means a search from Home that silently skips most of the
workspace. `consoleChrome/phoneSearchScope.test.ts` fails.
