# App and console — property chips

## A note's common properties are chips under its name, a new note's included (2026-10-14)

**Decided by the owner, 2026-10-14**, asking for "a dropdown for the
frontmatter as well for new notes even if it doesnt exist yet … of common
frontmatter values like status", and then, shown two designs (a dropdown from
an "Add property" line, or chips under the name), answering **"I like the
chips"**.

- Every note somebody writes in shows its common properties as chips under its
  name: Status, Owner, Priority and Due date, with Estimate, Tags and any other
  property under **More**. A set one is a solid chip reading its value; an
  unset one is a faint outline, and pressing it adds the property through a
  list — the folder's own status words in their groups, the people and agents
  picker, Urgent to Low, Today / Tomorrow / Next week / a date. Nobody types a
  status word, so it always lands in a group on the folder page.
- **Every pick is one front matter line**, written by `setNoteProperty` through
  the editor's own `onChange` — the Properties card's road — so it saves,
  merges and undoes like typing, and a note with no front matter gets a block.
- **The faint chips show on a new note, and otherwise under the pointer.** On a
  note with words in it they wait until the pointer is over the name or the
  chips, so reading a note is not trailed by controls. A phone has no hover, so
  a written-in note there folds them into one quiet "Add property" chip.
- **On the web they are in the editor, under the title line**, in a block
  widget the page portals into (`liveEditorWeb/propertySlot.ts`), because the
  name is the document's first line and a widget moves with it. On native the
  editor is a `WebView`, so the same chips are a row over it.
- Not on a website page (its front matter is the page's settings),
  `privacy.md`, a drawing, the activity list, or a locked or encrypted note. A
  folder's `about.md` does get them: its status is the folder's own. A reader who may
  not edit sees the solid chips and nothing to press.

What a "simplification" would cost: free-text values put words on notes that
no status group holds ("wip"), which the folder page then files under "No group
yet"; drawing the chips above the editor on the web puts them over the name
rather than under it. `__tests__/notePropertyChips.test.ts` and
`__tests__/propertySlot.test.ts` fail if either is undone.

## Only a note in the Projects folder is offered the task chips (2026-10-18)

**Decided by the owner, 2026-10-18**, of a new Inbox note on the phone: "this
note is not in the project folder, so I don't know why it's showing up", and,
shown the boards (`loose-note-chips`), picking A and the folder-job fix.

- **Status, Owner, Priority and Due date are offered only under the folder
  doing the Projects job**, whatever it is named, and everything under it. A
  loose note (Inbox, Areas, Resources, the top level, anywhere else) starts
  with its name. This narrows the 2026-10-14 rule above; nothing else in it
  changes.
- **A value a loose note already has still shows** as a solid chip, and can be
  changed or taken off. The file stays the whole truth.
- **The way in is ••• → Add property on a phone** (`addPropertyAsk.ts`), which
  opens the Properties card on its Add row. Under a pointer a loose note keeps
  one "Add property" chip that waits for the hover, as a written-in note's
  faint chips already did.
- **"In a project" is the folder's job, never its name.** The folder page
  (List, Board, statuses) used to look for "project" in a folder's name, which
  lost a Projects folder renamed Work and gave an Areas folder called Side
  projects a status column. Both read `jobFoldersNow` now.

What a "simplification" would cost: task chips on every note put a row of
tracking controls over shopping lists and meeting notes; a name check comes
back wrong the day somebody renames a folder.
`__tests__/notePropertyChips.test.ts` ("a loose note") and
`__tests__/folderPageModel.test.ts` ("which folders track progress") fail if
either is undone.
