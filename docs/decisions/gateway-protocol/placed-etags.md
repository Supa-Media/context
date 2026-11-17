# Gateway protocol: a note's etag names its workspace and note

**Asked for by the owner, 2026-11-17**, in the "jobs as config" plan, after a
Tex job read `@crystal-care/projects/…`, then wrote the bare path (which
addressed its own personal workspace) with the etag it had read. It was told
"conflict" four times and left a second copy in the wrong workspace.

### The rule

Every etag a routed tool call hands out is placed:
`@<workspace>/<noteId>:<version>`, or `@<workspace>:<version>` where the read
did not know the note's id. Only the header of an answer is placed (the part
before its first blank line), so a note whose text mentions an etag is never
changed.

Every etag argument (`expected_etag`, `expected_source_etag`,
`expected_privacy_etag`, and the same inside `move_notes` items) is checked in
`routeToolCall` against the context the call was routed to:

- From another workspace: refused, naming both places and the path that
  reaches the note that was read. **Never rerouted** — the caller said where
  the call goes, and sending it somewhere else is the wrong-workspace mistake
  in the other direction.
- Naming another note at that path: handed to the tool as a version no note
  has, so it is answered exactly as any stale etag. Not a refusal of its own,
  because the check runs before the tool asks whether the caller may see the
  note at that path, and "a different note is there" would be an existence
  oracle (non-negotiable #4).
- Bare (from before this, from the desktop app's HTTP read, from the
  gateway's own unrouted calls): accepted as it always was. Tools only ever
  see the bare version (`tools/dispatch.js` strips any placing left).

A Lab test chat's writes are answered by the test chat, never routed, so they
get the workspace half of the check from names alone. A call that names two
workspaces is refused with the same words as routing (`addressByPath`),
including when the turn saw two sessions and the etag half therefore checks
nothing: that refusal does not depend on which session the call would have
run in.

### What would break it

Dropping `checkEtagPlaces` or `placeAnswerEtags` from `tools/session.js`, or
placing the body of an answer. `apps/mcp/test/crossContext/etagPlace.test.mjs`
fails on each (its sabotage record has the counts).
