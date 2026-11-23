# An agent reads part of a long note, and never saves that part as the whole note

Decided by the owner on 2026-11-23, after asking whether Context uses up people's tokens: "design allowing fetch to
only read sections ... lets have some parity" with code-reading tools.

## Why

Every note read was the whole note. Context writes the longest notes itself: a day of email is often 60 to 140 KB and
reached 270 KB (about 67,000 tokens), and a meeting transcript reaches 100 KB. A search hit on one email is keyed
`<day>.md#msg-…`, and the read threw the anchor away and returned the whole day. Hand-written notes are mostly under
10 KB and were fine.

Code tools settled this long ago: Claude Code's `Read` takes a line range and stops at a cap with a pointer to read on;
Serena hands out a symbol overview, then one symbol; the Obsidian MCP servers read a note's document map, then one
heading's section, and patch by the same address. Context's notes are Markdown, so headings play the part of symbols.

## What an agent can do

- **`read_note` takes `outline`, `section` or `lines`** (and `fetch` passes them through as `args`):
  - `outline: true` lists the note's shallowest two heading levels, each with its line range, an approximate token
    size and how many deeper headings sit under it; `{ depth: 3 }` lists more.
  - `section` is a heading's words (`"Risks"`), a path (`"Plan > Risks"`, `\>` for a literal `>`) or the line it
    starts on, and returns that heading and everything under it.
  - `lines` is a 1-based range (`"120-180"`, `"412-"`).
- **A `fetch` id can name the part.** `note.md#Plan#Risks` is the section, the way an Obsidian link names one. A
  search hit's message id (`<day>.md#msg-…`) is that one message, not the day.
- **A part is at most 32,000 characters.** A longer range ends at a whole line with a `more:` line naming the next
  range. One line over 2,000 characters is cut and marked, so a range never returns a single 200 KB line.

What counts as a heading is what a reader draws as one: never inside a code fence, an HTML comment, front matter or a
captured message's untrusted fence. A note's machine blocks (the ```` ```comments ```` and ```` ```mail ```` fences)
belong to no section, so a section can never take a thread or a mail record with it.

## Changing a part

`write_note` (and `write`'s `args`) changes one part, and the gateway builds the whole new text from the note as it
stands and saves it through the ordinary whole save (`tools/notes/writePart.js`):

- **`section` with `content`** replaces that heading and everything under it. It overwrites lines, so it takes the
  etag its section read gave, which carries the section's hash (`;part#<hash>`): if the note changed elsewhere since,
  the write still lands when that section's own text is unchanged, and otherwise it is refused with only that section
  as it stands now, never the whole note.
- **`section` with `insert: "append"` or `"prepend"`** adds `content` at the section's end or start, with no etag.
- **`edits: [{ old, new, replace_all? }]`** (up to 20, all or nothing) finds and replaces, like Claude Code's `Edit`,
  with no content and **no etag** (decided by the owner, 2026-11-23, as a recorded exception to "writes pass back the
  version they read"): each `old` must occur exactly once (within `section` when one is named), so an edit made stale
  by somebody else's change finds nothing and changes nothing. A failure says "0 matches" or names every line a match
  is on.
- Edits never look inside the note's machine blocks, and a part write that would remove a comment's anchor
  (`<!--c:…-->`) is refused.

## The guard

A part saved as the whole note deletes everything the agent did not read. Two checks stop it, because one alone can
be dodged:

1. **A part's etag ends in `;part`.** `callTool` (`tools/partialEtag.js`) takes the mark off for every tool, so moves,
   visibility and the etag-place check see an ordinary version, and refuses a whole-note `write_note` (content, and
   neither `section` nor `edits`) given a marked etag, or a batch item given one, before anything is stored.
2. **A tool's whole-note save may not cut a long note by more than half.** A save with no etag, or with an etag from
   an earlier whole read of the same version, carries no mark. So `write_note`, when called as a tool, refuses a save
   that would replace a stored note of 16,000 characters or more with less than half as much, unless it passes
   `replace: "whole"`. The gateway's own writers (comments, remember, mail, meeting summaries) are not checked: they
   read the whole note and save it back whole.

## What stays the same

- **Privacy.** The part is cut from the answer `toolReadNote` already gave, after `canSee` passed and the body was
  read. A hidden note is refused with the same words and the same cost, outline or not, and a refusal says nothing
  about headings.
- **The gateway's own readers.** Only the `read_note` tool reaches the part reader (`tools/notes/readPart.js`). Every
  internal caller of `toolReadNote` still gets the whole note.
- **The live text.** A part is cut from the text a whole read returns, which is the collaboration text while somebody
  is typing.
- **Encrypted notes and drawings** are read whole; asking for part of one is refused.

## What a simplification would cost

- Cutting inside `toolReadNote` would truncate notes: comments, remember, mail and summaries read through it, edit and
  save the whole thing back.
- Dropping the `;part` mark leaves only the size check, which misses a section saved over a short note.
- Dropping the size check leaves only the mark, which misses a save with no etag.
- Leaving the mark on the etag for other tools makes every move or visibility change after a part read a false
  conflict.

`apps/mcp/test/sectionReads.test.mjs` and `apps/mcp/test/sectionWrites.test.mjs` fail if any of these is reversed; their headers record the sabotage runs.
