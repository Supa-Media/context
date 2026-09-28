# Comments on notes

People and agents can highlight words in a note and comment on them. They can
reply, resolve and reopen threads, and a resolved thread keeps its history, as
in a shared document. The owner asked for this on 2026-09-27 and set two
conditions: comments live in the note's own file, and agents can read, add
and resolve them. The format is `packages/shared/src/comments.cjs`, which the
gateway, the console and the publishing renderers all share.

## Comments are in the note, never beside it

A comment has two parts. The first is an anchor: a pair of HTML comments
around the words, `<!--c:k7f2-->free, you cheapo<!--/c:k7f2-->`. The second is
a fenced ` ```comments ` block at the end of the note, with one thread per
header line and one log line per event:

```
```comments
k7f2 "free, you cheapo"
- 2026-09-27T07:30:12Z Codex: This seems a little unprofessional. Maybe tone it down.
- 2026-09-27T07:31:40Z @dev2: eh, I don't really care
- 2026-09-27T07:31:45Z @dev2 resolved
```
```

Keeping comments in the file follows non-negotiable #3. They are exported
with the note, readable in any editor, and nobody has to rebuild them from
somewhere else. A sidecar file or a control-plane table might look simpler,
but comments would then fall behind every rename and move, and a note taken
out of the product would lose its conversation.

## The log is append-only

Resolving adds a `resolved` line, and reopening adds a `reopened` line. A
thread's status is whichever of the two came last. Nothing is ever deleted,
which is how resolved threads keep their history. Because every action is an
insertion, two people replying at once merge through the collaborative editor
without either reply being lost. A status field rewritten in place would make
them compete for the same line.

A comment's continuation lines are indented four spaces. A closing fence may
be indented by at most three, so no comment can end the block early.
`comments.test.mjs` sabotage-tests this.

## Agents comment through write_note, and cannot choose their name

Dev2 asked for no new tool (2026-09-27), so agents use the tools they already
have. `read_note` gains a `comments:` header line listing open threads, and
`write_note` gains a `comment` argument (add by quoting the words, then reply,
resolve or reopen). The gateway places the anchor and writes the log line.
The author is the connection's client name, and there is no argument for it,
so an agent cannot post as a person. People are written as their `@handle`,
and that `@` is how the console tells a person from an agent. Commenting
goes through `toolWriteNote`, so it needs the same write access as editing.

## Comments are never published

Share links and websites publish the note, not the conversation about it.
Share links strip comments in the control plane (`readThroughShare`) before
the text leaves, so a link holder never receives them. Websites strip them in
`parseWebsitePage`, which every site surface reads its body from. The share
viewer's `parseNote` strips them as well.

## Opening a card never moves the text

Dev2 picked this on 2026-09-27 after the first margin jumped: the column
snapped 300px left when a card needed room, and sometimes snapped back under
the card. The cards now sit in the space to the right of the centred column. A
pane with a little less room than a card needs moves the column left by only
the shortfall, which is `shiftFor` in `files/comments/rail.ts`. That depends on
the pane's width and on whether the note has comments at all, and never on
which card is open. The shift eases in, and cards fade in and glide to their
lines. The shift is a state field and not a class on the editor element,
because CodeMirror rewrites that element's attributes on every update.
Simplifying it back to a full margin toggled on activity brings back the jump.
The comments e2e test checks that the text stays still while a card opens and
closes.

## On a phone, a thread opens in a sheet

Dev2 approved this on 2026-09-27 (phone artboards 3 and 4). Below the
margin's width (`hasMargin` in `files/comments/model.ts`) the margin draws
nothing, and `files/comments/sheet.ts` takes over:

- Tapping highlighted words opens the thread in a bottom sheet: the quoted
  words, each message with its author and age, whether it is resolved, and a
  reply field. There is no count badge in the text, since it would sit inside
  headings. The highlight is enough.
- A visitor can read threads. For them, the field reads "Sign in to reply" and
  opens sign-in.
- Selecting text shows a floating Comment chip under the selection. Tapping it
  opens the same sheet with an empty composer. The keyboard bar gets no
  Comment key: it already carries seven keys, and Mobile Safari does not let
  a page add to its own text menu.
- Every comment field is 16px on a phone. Below that size, iOS zooms the page
  when a field takes focus.
- The homepage cast's comment, reply and resolve steps point the editor at
  their thread (`Presence.commentFocus`). On a phone that opens the same sheet
  a visitor opens themselves, so the demo shows no UI of its own.

The margin and the sheet read the same width rule, so a thread never shows in
both. The sheet sits on `<body>` rather than inside the editor, so a person
typing a reply is not typing in the note, and the note's keyboard bar is
hidden while they do. The iOS editor opens the same panel inline, under its
line. That web view is as tall as its note, so the bottom of its page is the
bottom of the note, not the bottom of the screen.

## The iOS editor draws comments and lists

The iOS guest installs the same comments extension
(`webview/guestExtras.ts`), so markers and the log are hidden there too. The
host sends the viewer's `@handle` over the bridge as a `commenter` message.
Folder lists cross the bridge as `list-load`/`list-loaded`, read from the same
`FolderListSource` the web editor uses, so a ```` ```list ```` block draws as
it does on the web.

## Known limits

- On iOS, a reply field inside the note counts as focus in the note, so the
  keyboard bar stays up while someone types a comment there.
- An anchor that starts a paragraph puts `<!--` at the start of a line. In
  CommonMark that begins an HTML block, so Obsidian and GitHub render that
  one line's Markdown literally while the anchor exists. Our own renderers
  strip the markers first.
