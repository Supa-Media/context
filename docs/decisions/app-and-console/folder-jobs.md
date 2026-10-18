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
  front of names stop being needed to sort. Every surface that lists folders
  draws by that one comparator, the phone's Folders page included
  (`homeModel.ts`), so the sidebar and the phone never disagree.
- **Dragging in the sidebar tree** (`apps/mobile/features/console/files/treeDrop.ts`):
  the top or bottom quarter of a folder row drops above or below it, with an
  insertion line, and the middle into it, with the wash. Between siblings is
  a reorder of that level; between rows of another level is a move there,
  then the order with the folder where it was dropped, sent only once the
  move has landed. Website reorders among its siblings (as Move up and Move
  down do) but is never dropped into another level or nested. Notes and
  several rows at once only nest, since notes still list by name.
- **Built-in folders draw a hand-drawn icon in Tex blue, and nobody can change
  it** for now: the app draws the job's icon over any emoji a row holds and
  offers no way to set one on a built-in folder. The owner may later offer a
  set to pick from. The icon follows the job, so Projects always looks like
  Projects.
- **Agents are told** which folder does which job in `orient`'s "System
  folders" lines, one per folder this connection can see: its path now,
  wherever it is nested, whether it is needed (the five main ones), made
  when used (Tex, Website, Meetings) or optional, and one line on what it is for (`apps/mcp/src/orient/systemFolders.js`,
  owner 2026-10-18). A required one the connection cannot find is said as not
  found by this connection, never as absent. The paths are read from the rows
  (`ask: "jobs"` on `/gateway/tree/facts`), and `archive_note` archives into
  the folder doing the Archive's job.

**Known limits.** A built-in folder of any size can be renamed or moved: a
keyed folder over `ROW_MOVE_MAX` (500) rows moves in pages, reading as one
folder at its new name while it does
([notes-by-id](../storage-and-credentials/notes-by-id.md#moves-in-a-keyed-workspace-are-row-changes),
2026-10-18). For the few seconds a big move takes, a setting or share changed
by the folder's new name on a note not yet moved is refused as not found, and
one asked for again lands. Links inside notes are not rewritten by a keyed
move; a link through a built-in folder's default name still resolves through
`canonicalJobPath`, and other links through the forwarding ledger. Where links
are rewritten (a move in a workspace not yet keyed), only the notes the tree's
link facts name are read, so the size of the workspace does not matter
([links-and-routing](./links-and-routing.md)).

What a "simplification" would cost: finding a built-in folder by its name
again breaks every writer and agent the first time somebody renames one, and
dropping the default-name rule makes each writer recreate `0-inbox` beside a
renamed Inbox. `apps/convex/__tests__/nodes/folderJobs.test.ts` and
`apps/mcp/test/folderRoles.test.mjs` fail if either goes.

## A person, or an AI client, says which folder does a job

Decided by the owner, 2026-10-18, picking every board of "Built-in folder
jobs": an imported vault (`00 Inbox`, `Work/Projects`, `Reference`) names its
folders its own way, so a job can no longer come from a root name alone.

- **Three groups, one list** (`packages/shared/src/folderJobInfo.cjs`, read by
  Settings, the import picker, `orient` and `folder_job` alike): *needed* —
  Inbox, Projects, Areas, Resources, Archive, one each, which can be handed to
  another folder and never taken away; *made when used* — Tex and Website;
  *optional* — Clients, Teams, Products, which can be taken away. The list is
  fixed: there are no made-up jobs; a folder of a person's own kind explains
  itself in its `about.md`.
- **Giving a job moves nothing** (`builtInFolders.setJob`, owner only, as a
  job decides where everybody's mail and meetings land). The named folder's
  row takes the job, and the folder that did it keeps its notes but holds
  `role: "none"` (`NO_JOB`), so its name never claims the job back. Archive
  stays at the top; Website keeps its name and place; a folder already doing
  another job is refused. `lib/nodes/folderJobSettings.ts` `decideJobChange`
  is the whole rule.
- **Guesses after an import** (`guessFolderJobs`): a folder at most three
  deep whose name says a job, its own word before another word for it
  (Reference for Resources, Archives for Archive), shallower first, with the
  reason shown. A folder a person said does no job is never guessed.
- **Tex is a job.** Tex's folder can be nested anywhere; Tex keeps reading and
  writing `tex/...`, carried to the real folder by `canonicalJobPath`. Routines
  live in Tex's folder (`tex/routines/`), so Routines is part of Tex's line,
  not a job of its own; the routine scan lists them where Tex's folder is and
  rows keep naming them `tex/routines/...`. Housekeeping leaves Tex's and the
  website's folders alone wherever they are.
- **The Inbox's own folders** (Calendar, Contacts, Email, Forms, Google Chat,
  iMessage, Meetings, Memories, Sessions) are one line under Inbox, not a line
  each. Context files into them by name, so they are never renamed or moved
  (`assertNotProtectedFolder`, the gateway's `protectedFolderRefusal`); they
  can be trashed, and a person adds notes and folders beside them. Meetings
  keeps its row job internally and is said on the Inbox's line.
- **AI clients** use `manage` action `folder_job` `{ job, path | remove }`, a
  row over `apply_layout`, through the same `giveJob` the app's Settings uses.

What a "simplification" would cost: dropping `NO_JOB` makes a root `Projects`
the person said is not their Projects folder take the job back the moment the
other folder moves; letting an editor change jobs lets a member redirect the
owner's mail. `apps/convex/__tests__/nodes/folderJobSettings.test.ts`,
`apps/convex/__tests__/routinesTexRoot.test.ts`,
`apps/mcp/test/workspaceSetup.test.mjs` and
`apps/mcp/test/orientSystemFolders.test.mjs` fail if either goes.
