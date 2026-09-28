# The side panel

Split out of [folder lists](./folder-lists.md), whose folder pages it opens
beside.

## Any row opens beside the list

Decided by the owner on 2026-09-28 ("Projects for everyone"), for tasks, and
widened the same day to every row: "when in list view or board view, clicking
on a project or note should open in a side panel, with an option to expand
fully / open in a new page" — and, to be clear, like Notion's side peek. On a
desktop page, pressing any row — a task, a subtask, a plain note, a note in a
task, a Board card, a project on the projects folder's page — opens it on the
right instead of leaving the page. Each List row also shows "Open" (the side
panel's mark) while it is hovered or focused, which does the same; its name
is "Open in side panel".

What the panel shows: where it is ("Café opening › Get the kitchen ready"),
then **Expand**, **Open in new tab** and ✕; its name; and for a **task** —
anything with a status, a project included — **Status, Priority, Owners,
Tags and Due** as one-press values, its **Subtasks** ("2 of 4 done") with a
dot that ticks each off, and the **Notes** in it, with "+ Add subtask" and "+
Add a note"; for a plain folder, what is in it. Last, for every row, the
note's **words**: a note's own, a folder's front note's (`overview.md`, else
`index.md`, else `README.md`), without the frontmatter the values already
say and without a first heading that is only the title again. A name in the
panel — a subtask, a note — opens it here, and the crumb goes back up.

- **Expand** opens the row as its whole page here, where pressing used to go.
  **Open in new tab** opens it in a tab of its own and leaves the list and
  the panel where they are — `ConsoleNav.follow` in the background, the same
  road as ⌘-clicking a link. A tab holds a note, so a folder opens its front
  note; a folder with none, or a surface with no tabs (the landing page's
  demo), is not offered it. ✕ or Escape closes the panel (a menu or a field
  with the key answers Escape first).
- **A writer edits the words here, through the same editing session**
  (decided by the owner on 2026-09-28, reversing the read-only peek of the
  same day: "the side panel shouldnt be read only, it should be editable").
  The console holds one open note — one draft, one autosave, one
  unsaved-changes guard, one conflict, and one collaboration room the people
  typing in it share — and a *second* editable editor would be a second
  writer of the file outside all of it, which is why the peek was read-only.
  So it is not a second editor: a folder page holds no note in the editor,
  and the peek borrows it (`FileBrowser.openBeside`, `useBesideNote.ts`),
  putting the note there by the same `openNote` a note opened from the tree
  takes — the server's read, the draft restore, the autosave, the room, the
  people's carets — while the selection, the address and the tab strip stay
  on the folder. Closing the panel or moving to another row gives it back,
  the draft written first and the unsaved-changes guard asked; a note already
  open is simply shared. A conflict is not answered in the peek — it takes
  reading two versions — but said there, with its page one press away. A
  member, a locked note and a note not yet in the editor are read as before,
  read-only; the values above are unchanged. The words are read through the page's own source
  (`FolderListSource.readBody`): this device's copy at exactly the reader's
  clearance, else the bucket through the server, which applies the same one;
  an encrypted note says it is locked and its ciphertext is never handed over.
- **About half the page, and it may lie over the list.** Where the list (at
  least 480pt) and the panel both fit, the panel is beside it, into the room
  at the right first; where they do not, the list keeps its width and the
  panel lies over its right side with a shadow, rather than squeezing both or
  not opening (`peekLayout`). On the web it stays in view while the list
  scrolls, and scrolls itself. On a phone pressing a row opens its page as it
  always did: a panel over a phone's list is the page with less room.
- **Opening it folds the file tree away; closing it brings the tree back
  only if it was showing when it opened.** Leaving the page closes it the
  same way. The tree is the frame's own fold (`setExplorerFolded`: the field
  the tree's toggle flips, set rather than flipped so a second run cannot
  land it on the wrong side) — never a second layout — and what the panel
  remembers is held only while it is on screen, so switching to Notes brings
  the tree back too.
- **It is a way of looking, not a record.** Which row is open is held by the
  page while it is open, per viewer, and forgotten on leaving the folder;
  nothing is written, as with Show. The open row is marked where it is drawn
  (`aria-current`), whichever kind it is.
- **Every value is the row's own write.** A value is one frontmatter line of
  the task's note through `writeNoteProperty`; several owners are written as a
  list and each can be taken off by name (the List's row still offers a
  several-owner line as no single choice, because there picking one would drop
  the rest). Tags are always written as a list; none clears the line.
- **A dot flips between Done and To do**: a done subtask goes back to the
  list's first Not started word that is not Backlog — ticked off by mistake, it
  is work for now, not an idea for later — and anything else to the first
  Done word. The words come from the list that describes the subtask.
- **Adding is planned, then run** (`taskWrites.ts`): a subtask starts at that
  first To do; a note is a heading and no status, so it is never a subtask. A
  one-note task becomes a folder on its first subtask *or* note, by the same
  move (links follow it), and the panel follows it there. A subtask may hold
  notes; nothing goes deeper. It is the List's own write road (see "Adding
  and nesting tasks"): drawn at once in the panel and the List, and said
  with an Undo — one host for both, never a second way to write.
- **A member reads the same panel with nothing to press** that would write:
  the dots are drawn, not buttons, and there is nothing to add.

What reverting costs: back to navigating, a project is read one row at a
time with the list gone each time; a note pressed in a List leaves the list
behind again; a second editable editor loses keystrokes to the room it
bypasses, and a read-only peek sends a writer to another page to fix a typo; a panel that opens only where it fits beside the list never opens
on a laptop with the tree showing; a tree folded and never given back is a
tree somebody has to find the chord for. `taskPanel.test.ts` fails if a wide
page navigates instead of opening the panel, if a phone opens it, if a dot
writes anything but Done or the first To do, if a first subtask or note skips
the conversion, if a subtask added there is not drawn at once or has no Undo,
or if a member is given a control; `sidePeek.test.ts` fails if a note, a note
in a task, a subtask or a project does not open beside the list or is not
marked, if a writer's words are not the lent editor's draft and editable,
if a member or a console that may not write is lent the editor, if the words
show the frontmatter or a locked note's text, if Open in new tab leaves the list or Expand does not, if the tree is
not folded while the panel is open or is brought back when it was folded
before, or if a page too narrow for both does not open it over the list;
`folderListBody.test.ts` fails if a team reader is read a private copy;
`taskPanelModel.test.ts` pins what the panel reads, its words and where it
goes; `explorerToggle.test.ts` pins that folding twice is folded;
`taskWrites.test.ts` pins the plan for a note; `besideNote.test.ts` fails if
the lend moves the selection, reads anything but the note through the server,
survives its own close, or is ended by another peek's; `projectsList.spec.ts`
fails if a writer's typing in the peek is not saved or a member can type.
