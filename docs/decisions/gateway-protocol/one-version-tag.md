# Gateway protocol: a note has one version tag, and every tool accepts it

**Decided by the owner, 2026-10-28** ("All MCP paths should use the same
canonical revision"), after an agent changing a note's visibility was refused
with the etag it had just been handed, read the note again and retried.

### The rule

A note with editing history has two tags: its collaboration document's
(`c2.<document>.<revision>`) and the stored Markdown object's. Which one names
the note's version is decided in one place, `apps/mcp/src/notes/version.js`:

- A note whose collaboration document has started is at the document's
  version. The Markdown etag the document started from still names that same
  version while nothing has changed since (`isCurrentEtag` in
  `@context/collaboration`, the rule `replaceText` already enforced for
  `write_note`).
- Any other note is at its stored object's version.

`read_note`, `write_note`, `set_visibility`, `move_note`, `move_notes`,
`archive_note`, `set_encryption` and keyed row moves all compare through it,
so an etag one tool hands out is accepted by every other until the note
changes, and refused by every one after.

### Reads start no document

Before this, an app's `read_note` started the note's collaboration document
(~15 storage calls on a first read) only so the later checks would see the
tag they compared with; Tex's check-in already skipped it. With one rule for
both tags, no read starts one: the first edit does.

### What would break it

Comparing `readDocument(...).etag` (or a stored object's etag) by hand in a
new tool. `apps/mcp/test/oneVersion.test.mjs` fails if `set_visibility` goes
back to that, if the unchanged Markdown etag stops being accepted, or if an
old tag is accepted after the note changed.
