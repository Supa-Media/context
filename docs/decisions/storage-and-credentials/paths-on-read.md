# Paths are built on read; a move is one row change

## The tree is parent pointers, and note files need not work outside Context

*Decided by the owner, 2026-10-25* ("The files do not need to work outside of
context ... editing, changing the name of a folder with a million items in it,
should be one row change ... Moving all of a project into another folder
should be one row change, changing the parent of a row"; "make sure you are
able to properly backfill or make this migration").

**Why.** [Notes by id](./notes-by-id.md) moved note bodies to
`notes/<noteId>.md`, so a move stopped copying bytes, but three things were
still filed by path and followed every note a move touched: each tree row's
stored `path`, each note's collaboration head, and the path text of links in
other notes. A folder move rewrote all three for every note beneath it, so it
was paged (`ROW_MOVE_MAX`), capped (`COLLABORATION_RENAME_MAX`), and slow
enough for an agent's move to time out.

**What it is.**

- A row's identity is its id; its place is its parent and its name. A path is
  computed from the rows when something is read (an agent, a person, an
  export) and never stored as the truth. Renaming or moving a folder of any
  size changes that folder's row and nothing else.
- Everything that points at a note points at its note id: editing history,
  links, pins and recents, routines, shares, the change log.
- People and agents are always shown paths, never ids. A link in a note is
  shown with the target's current path, worked out when the note is read.
- **Download as folders** still gives a complete copy with real names, built
  from the rows at the moment of export (non-negotiable 1 is unchanged). What
  is given up is that a bucket's raw keys or a note's raw link text read
  correctly outside Context; nobody may rely on that.

**Stages,** each merged and shipped on its own, each with a backfill for
existing workspaces that is confirmed finished in production before the next
stage relies on it:

1. Editing history filed by note id (below).
2. Links bound to note ids, current paths filled in on read and on export; a
   move rewrites no other note.
3. Pins, recents, routines, shares and the change log keyed by id.
4. Rows stop storing `path`; paths are built on read, and a move or rename is
   one row patch. The paged-move machinery (`rowMoves`, `drawnMoves`,
   `throughRowMoves`) goes with it.

What a "simplification" would cost: storing any path as truth again brings
back a write per descendant on every folder move, and a cap on how big a
folder may be before its move is paged or refused.

## Editing history is filed by note id

*Stage 1, built 2026-10-25* (`packages/collaboration/src/address.js`).

- In a keyed workspace a note's collaboration head is
  `.context/collaboration/v1/heads/notes/<noteId>.json`. The engine asks the
  store for the note id of the row at a path (`noteIdAt`), once per operation
  (`scoped`), and files the head there. A move of the note, or of a folder
  above it, leaves the head where it is: nothing is carried, and the
  document is found at whatever name the note has. A head filed by id is read
  at the note's current name; the state's own `path` is then informational,
  and validation does not compare it (`byNote`).
- Where the store can name no id (no row, plumbing, a trash location, a store
  with no id layer) the head is the path's, as before, so trash and restore of
  a path-filed head behave exactly as they did.
- **A path head is filed by id on its first read** (`adoptPathHead`): copied
  create-only to the id key, then fenced `moved` with `migrated: true`, so no
  read or move carries it again. A path head made for another note id is never
  taken. An id-less one (made before heads recorded ids) is, and `load.js`
  proves it is this note's (`adoptUnstampedHead`) before using it.
- **The backfill** (`fileHeadsByNote`, run per workspace by
  `functions/collaborationFiling.ts` from a half-hour cron) lists the bucket's
  path heads a page at a time and files each the same way, recording its
  position so a stopped pass resumes. The `Collaboration filing` workflow
  reports production's totals as counts.
- **A document records its note** (`documents/<documentId>/note.json`). An
  editor that typed at the old name before it heard of a move sends its update
  there with its document id; the collaboration route finds that note's
  current name (`pathOfNoteId`, the control plane's resolve) and commits there,
  judged by `canSee` like any destination. A name the member cannot see is a
  404, as a hidden moved head always was.
- **The move carry is now one read per note, and usually nothing else.** The
  gateway (`moves/keyedCollaboration.js`) and the console (`rowHistory.ts`)
  call `renameDocument` only where the old name still holds a live path head
  (`pathHeadLive`, one read, no lookup). `renameDocument` does nothing when
  both names file to the same head, so a stale name can never fence the note's
  own head. Rooms of a move of up to `ANNOUNCE_MOVES_MAX` notes are told where
  each went; a bigger move's rooms learn it when they reconnect.
- **Emptying the trash** erases a note's id-filed head and history by the id
  in its key (`historyIdsOf`), since its row is gone by then.

**Still to go in this stage:** once the backfill reports every workspace done,
the carry and `renameDocument`'s callers are removed, and moves do no
per-note collaboration work at all.

What a "simplification" would cost: filing heads by path again makes every
move carry each note's history and strands an offline editor whenever the
carry fails. `packages/collaboration/test/noteHeads.mjs` fails for each part
(the move, the first-read filing, another note's head, the stale-name rename,
the erase, the backfill), `apps/mcp/test/collaborationByNoteId.test.mjs` for
the route's forward and its `canSee`, and
`apps/convex/__tests__/collaborationFiling.test.ts` for the backfill's lease,
position and report.
