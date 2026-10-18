# Built-in folders are found by their job, not their name

## A folder's job lives on its row, so the folder can be renamed, moved and nested

*Decided by the owner, 2026-10-18* (leadership weekly of 2026-10-17, "mark
system folders so agents can find them"; boards 1-9 in the project file
`meeting-2026-10-17/system-folders/`). Replaces the 2026-10-08 rule that the
five main folders cannot be renamed or moved, and the 2026-10-13 rule that a
built-in folder's emoji can be changed
([custom-emoji](./custom-emoji.md#built-in-folders-have-a-default-emoji-and-notes-can-have-one)).

**Why.** People wanted to call their Inbox "Capture", nest Projects inside
"Work" and drop the numbers in front of folder names, and every system prompt,
`archive_note`, email, meetings and Tex had found the built-in folders by
their names. The icon alone could not be the flag: an agent has to be able to
find the folder by something stored, in the owner's words "an actual thing
identifying it as a special system thing, using the original names".

**What it is.**

- **`role` on the folder's tree row** (`nodes.role`), holding the job's
  original name: `inbox`, `projects`, `areas`, `resources`, `archive`,
  `clients`, `teams`, `products`, `website`, `meetings` (`ROW_ROLES`,
  `packages/shared/src/folderRoles.cjs`). A row takes its job when it is made
  at the root under a job's name and no folder does that job yet, before its
  first move when its name still says the job (rows older than the field), and
  for the meetings folder when it sits where the meetings setting points
  (`apps/convex/functions/lib/nodes/folderJobs.ts`). Moves keep row ids, so the
  job goes wherever the folder goes. It is never cleared.
- **Finding a folder by job** reads the rows first and names second:
  `folderJobs` gives each job the row that carries it, and a job no row
  carries to the root folder named for it (`0-inbox`, `Projects`).
- **A default name reaches the folder doing the job** (`jobPath`,
  `canonicalJobPath`). `0-inbox/memories/a.md` is `Capture/memories/a.md` once
  the Inbox is called Capture. Only the first segment is read, and a root
  folder that really has the name always wins. It is applied where a path
  becomes a row in a keyed workspace, the id layer's lookup, adopt, record and
  remove (`functions/noteIdsKeyed.ts`), so every writer that names a built-in
  folder by its default name (email, Google, meetings, memories, sessions,
  conflict copies) and every AI client that guesses `0-inbox/` keeps landing
  in the real folder without each being changed. A team-scope reader asking
  by the old name is judged at that name, which no rule names, so it reads as
  private: the alias never widens what anyone sees.
- **Settings that name a folder follow its moves** (`settingsFollow.ts`): the
  meetings folder, the email-in target folder, each Google service's folder.
- **What may happen to a built-in folder** (`assertNotProtectedFolder`): in a
  keyed workspace the five main ones can be renamed, moved and nested like any
  folder; they can never be archived, trashed or deleted. Elsewhere the old
  lock stands, since writers there still name them by path. The Website folder
  keeps its name and place, because pages are published from it by name.
  Extras can be removed. A new root folder under a job's name, while another
  folder does that job, is refused as a twin naming that folder.
- **Order is a row field** (`nodes.order`), set by Move up, Move down and
  dragging (`functions/folderOrder.ts`, steps of ten). Without one, folders
  draw by job (Inbox, Projects, Areas, Resources, extras, Website, own folders,
  Archive last) and then by name (`compareListingEntries`). The numbers in
  front of names stop being needed to sort.
- **Built-in folders draw a hand-drawn icon in Tex blue, and nobody can change
  it** for now (`folderIcons.set` refuses one). The owner may later offer a
  set to pick from. The icon follows the job, so Projects always looks like
  Projects.
- **Agents are told** which folder does which job in `orient`'s "Built-in
  folders" line, read from the rows (`ask: "jobs"` on `/gateway/tree/facts`),
  and `archive_note` archives into the folder doing the Archive's job.

**Known limits.** A keyed folder move rewrites at most `ROW_MOVE_MAX` (500)
rows in one step, so renaming a built-in folder holding more than that is
refused as too large until moves are chunked. Links inside notes are not
rewritten by a keyed move; a link through a built-in folder's default name
still resolves through `canonicalJobPath`, and other links through the
forwarding ledger.

What a "simplification" would cost: finding a built-in folder by its name
again breaks every writer and agent the first time somebody renames one, and
dropping the default-name rule makes each writer recreate `0-inbox` beside a
renamed Inbox. `apps/convex/__tests__/nodes/folderJobs.test.ts` and
`apps/mcp/test/folderRoles.test.mjs` fail if either goes.
