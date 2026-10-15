# Notes and List are one view, and its dot and face are its controls

Part of [folder lists](./folder-lists.md).

Decided by the owner on 2026-10-14: "I also think we should collapse notes and
list view because they are very similar. It's just that for projects, we have
special UI on it." So a projects folder's switch is **List · Board**: List is
the listing with the extras above, and there is no Notes view to switch to. A
view remembered as "files" from before reads as List. Folders outside
projects are their listing with no switch, as before. The quiet "Track these
folders by status?" line went with Notes, since all it did was switch to List.

In the same message: "I'm not able to click on the status circle to change
it" and "even if it's not assigned to anyone, there should still be like a
placeholder circle there to assign it". So for somebody who may write, a
task's dot opens its status menu (the folder's groups, as a card's does) and
the face opens the owner picker, with an empty dashed ring where a task nobody
owns would have one. A note is made a task with **Make it a task**, as before;
a faint ring under the pointer in its icon's place was tried and dropped with
the dot beside the icon (below). A task with several owners keeps
its faces as they are, because one pick would replace them all; the side
panel adds and removes them one by one. A press on a dot or face never opens
the row. They are not `<button>`s, since the row is one. A member gets no
control and no empty ring. Reversing it fails
`__tests__/folderPageList.test.ts` ("changing a task from its row").

The rows also draw the tree's icon, the emoji or the plain folder or note
icon, after the chevron's gutter. A folder's emoji used to stand in the
chevron's place, which left some folders with no arrow ("when there's an
emoji, the arrow is gone in the middle section, which is just funky"). A
task's status dot takes the icon's slot rather than sitting beside it: the
two together "does not look great at all. Maybe we just maybe remove the
emoji and keep the status" (the owner, 2026-10-14). A row with no status
keeps its icon. Reversing it fails `__tests__/folderPageList.test.ts` ("a
task's dot stands in its icon's place").

The chevron opens the folder in place, as the tree's does ("the arrow isn't
even clickable, which is stupid", the owner, 2026-10-14): its rows follow,
indented, each folder among them openable in turn, from the file browser's
own listings so the tree and the page never disagree. The rest of the row
still opens the folder's page. Which rows are open belongs to that page alone
and is forgotten on another. A phone has no arrow to press: its row is a card
that goes somewhere. Reversing it fails `__tests__/folderRowNesting.test.ts`.

## In a projects folder, everything is a project item

Decided by the owner on 2026-10-14: "all items in project folders should have
statuses and be treated like an project item with no status if status is not
set unless it explicitly has status:note or something like that, and you
should be able to set that when you click on the status circle in case you
want to update something to just be a note."

So in the List a row with no status is not a note any more: it draws an empty
dashed circle where its dot goes, which opens the status menu for a writer,
and the owner placeholder after its name, as any task does. Only a row whose
front matter says `status: note` (or `notes`, any case) is a plain note and
keeps its icon. The status menu ends with **Just a note**, which writes that
word. Everywhere the folder page reads a status, `note` reads as none, so it
is never a Board column, never a word asking for its group, and never counted
in a folder's "3/9". The Backlog folder is where projects are parked, not one
of them, so it keeps its folder icon. The Board is unchanged: an item with no
status is still not a card. Reversing it fails `__tests__/folderPageList.test.ts`
("only a note that says so keeps its icon") and `folderPageModel.test.ts`
("status: note says only a note").
