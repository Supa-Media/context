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
