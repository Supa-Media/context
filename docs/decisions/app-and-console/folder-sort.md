# Each folder has a Sort setting, shared by everyone in the workspace

## Folders sort by name, by date or in an order people drag, notes included

*Decided by the owner, 2026-11-04* (boards in the project file
`custom-sort/index.html`). Extends the 2026-10-18 folder order
([folder-jobs](./folder-jobs.md)), which ordered folders only, and reverses
the 2026-09-19 "no drag-to-renumber" call, which held while order lived in a
number in front of a file's name: order is now a row field, so dragging never
renames anything.

**Why.** People wanted their projects in the order they work on them, not
the alphabet, and to put a note between two folders. The sidebar's only sort
was a Z to A flip that reset on every reload.

**What it is.**

- **The setting is on the folder's row** (`nodes.sort`, one of
  `LISTING_SORTS` in `packages/shared/src/listingSort.cjs`): `custom`,
  `name-asc`, `name-desc`, `edited-desc`, `edited-asc`, `created-desc`,
  `created-asc`. No size sort (owner). It follows the folder through every
  rename and move, and reaches the workspace's object with the rest of the row
  (`ws_rows.sort`). The top level has no row: its setting is the workspace's
  (`workspaces.treeSort`), set from the sort button at the top of the tree and
  read by the app (`folderSort.workspaceSort`). It changes what everybody sees,
  so it takes an editor (`functions/folderSort.ts`).
- **A folder with no setting draws by the nearest one above it**, then the
  workspace's, then the order a folder has always drawn in (folders by order,
  job and name, notes by name). **Custom order is never passed down**: it is
  what was dragged in one folder, and a folder beneath has nothing dragged in
  it. So dragging at the top level reorders the top level and nothing else.
  "Apply to folders inside" clears the setting of every folder beneath that
  the caller can see, so they draw by this one; it is not offered on a folder
  in custom order, which has nothing to pass down.
- **Custom order mixes notes and folders** by each row's `order`
  (`functions/folderOrder.ts`, which takes notes beside folders since this
  decision). A row with none yet, a new note or one moved in, is drawn first,
  newest first. **Name and date sorts keep folders above notes** (owner); in a
  date sort the folders keep the order a folder with no setting draws them in.
- **New notes follow the folder's setting** (owner): at the top in custom
  order and in newest-first sorts, at the bottom in oldest-first ones, by name
  otherwise. Nothing is written for that: it is what the sort gives.
- **Reordering switches a folder to custom order.** Move up, Move down or a
  drag between two rows in a folder drawn by name or date sends the whole
  level as drawn, with the moved row in its new place, and sets the folder to
  custom order, so nothing else jumps; the app says so and points at the
  folder's Sort menu to go back. There is no Undo button. Outside custom
  order Move up and Move down move a folder among the folders only, since
  notes are drawn below them.
- **The Sort menu is an editor's**: a folder's ••• and right-click menus have
  Sort › with the drawn one ticked (Name, A to Z where nothing is set), and
  the tree's View menu has the top level's. A reader gets none of it rather
  than greyed rows, as for every other write in those menus. The phone's
  Folders list draws the top level by the same setting.
- **Every row carries when it was made** (`createdAt` on a listing entry: the
  Convex row's creation time, the object's `ws_rows.created`). The object sets
  it on a row it makes, and a push without one keeps the one held. It is not in
  the rows' digest. A row copied before it existed has none, and sorts by its
  last edit until it is pushed again.
- **The digest covers the setting only once it is set**, so every row made
  before it keeps the digest it had and no workspace needs a fresh copy
  (`digestLine`, the same on both sides).

**What a simplification would cost.** Passing custom order down would make a
drag at the top level redraw every folder in the workspace newest first.
Keeping the setting in the browser would show each person a different tree,
and the board's whole point was one order for the team. Digesting `sort` as a
plain field would mismatch every object until it was copied again.

**Tests.** `apps/convex/__tests__/nodes/folderSort.test.ts`,
`apps/mcp/test/workspaceTreeSort.test.mjs`, the digest parity case in
`apps/convex/__tests__/workspaceObjects.test.ts`; in the app
`__tests__/levelOrder.test.ts`, `__tests__/fileMenu/sortMenu.test.ts`,
`__tests__/treeDrop.test.ts`, `__tests__/treeDragHook.test.ts` and
`__tests__/phoneFolderOrder.test.ts`.
