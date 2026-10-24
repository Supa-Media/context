# A note they ask for is saved at once, where their folders say (2026-10-24)

From Tex's self-review of a finished conversation (`areas/tex-reviews/` in
@context-lc, 2026-10-24 19:19), triaged into a fix the same day under the
owner's standing rules: Tex asks for a yes only when something reaches
another person (2026-10-22), and never hands work back (2026-10-22).

## What happened

- The person texted a child's Screen Time code and asked Tex to save it.
  Tex sent a vault link, then refused three times to keep it in a note while
  the person said each time it was not a real password, then saved it in the
  inbox.
- Asked to put meeting notes "in thoughts and reflections", Tex saved them at
  the top of that folder, beside the person's own `2026 - Fall` subfolder that
  held every note of the term. It never listed the folder.
- An event on the person's own calendar with nobody invited was asked about
  twice ("Say yes", then a 👍). That conversation predates the calendar gate
  of 2026-10-22 (`tools/calendarGate.js`, `ACTIONS_LINE` in
  `agent/prompt.js`); `apps/mcp/test/calendarGate.test.mjs` replays it and
  asserts no ask. The live setup's rule 9 still said "only their YES makes the
  change", so its words were corrected too.

## The decision

- **The vault is for an account's password, an API key or a card number.**
  Anything else a person asks to keep (a door or Screen Time code, a locker
  combination) is their content, kept as a note in their personal workspace.
  Tex may offer the vault once; if they still want a note, it saves the note.
  It never refuses twice. Non-negotiable #1's "credentials never live in
  Markdown" is about the credentials Context holds for them (storage keys,
  OAuth tokens, vault entries), never a person's choice of what to write in
  their own notes.
- **A new note goes where their folders say.** A texted (or app panel) create
  straight into a folder that also sorts its notes into subfolders is answered
  once with those subfolders and how many notes each holds
  (`agent/folderFit.js`). The same write with a subfolder's path saves it
  there; the same path again saves it where it was asked for. Nothing is
  refused for good. An edit, a top-level note, Tex's own folder, a routine and
  Context's own capture folders are never asked about.
- Both are said by the build (`SAVING_LINE` in `agent/prompt.js`), so a
  production setup whose words go stale cannot take them back.

## What a simplification would cost

Dropping the folder check puts notes back beside the subfolders the person
keeps; dropping `SAVING_LINE` lets an old "never accept a code by text" line
refuse a note the person asked for. Tests:
`apps/mcp/test/agentFolderFit.test.mjs` and "a texted turn saves a note it's
asked for" in `apps/mcp/test/agentInstructions.test.mjs`.

## A slow save is followed through, never told as failed unseen (2026-10-24)

Three of one person's conversations that afternoon (self-reviews at 19:00,
19:37 and 20:09) had Tex say "the write timed out" and "your notes stopped
saving", and a long finance note never got its corrected numbers, while a
short new note written in the same workspace saved at once.

**Cause.** Rewriting an existing note goes through the collaboration merge,
which diffed the old and new text character by character. That diff is
roughly quadratic in the size of the edit: a 20,000-character rewrite took
18 s, and one save runs it up to three times. A short edit or a new note never
paid it. `packages/collaboration/src/textDiff.js` now bounds it by edit length
(a Worker's clock does not advance while it computes, so a deadline would not
work): characters up to 1,000 edits, then lines, then the changed middle
swapped whole. The saved text is exact at every tier; only how finely a
concurrent person's typing is merged around a rewrite changes.

**Reporting.** The turn's 20 s tool limit answered a slow save "took too long
… Don't retry it" while the save itself kept running. A plain `write_note`
past its limit now waits its own limit again, reads the note back, and retries
once (a full-content write is safe to repeat: the merge answers a repeat as
unchanged), all inside the turn's tool time
(`apps/mcp/src/agent/noteWriteRetry.js`). The model reads the save's own
answer, "saved" from the read-back, a real refusal, or "still saving, not
confirmed": never a failure nobody saw.

Reversing either fails `packages/collaboration/test/textDiff.mjs` or
`apps/mcp/test/agentNoteWriteRetry.test.mjs`.
