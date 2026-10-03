# Gateway protocol: agents remember facts with one tool, and the note stays clean

**Decided 2026-10-02** by the owner (design: `docs/design/remember`). An agent
that learns something durable about the person (a preference, a correction, a
fact about them or their work) saves it with `remember`, without asking, so
every app connected to Context reads one shared record.

- **One line in the note, nothing else.** The fact is added as `- <fact>` at
  the end of the note the agent names, or swapped for the one line `replaces`
  names exactly; with no note, it becomes a new note in `0-inbox/`. No tag, no
  heading, no marker: notes are read and searched by people, and stay clean.
- **Provenance lives in the audit trail.** The `remember_fact` record in
  `.context/audit/` holds the fact, `stated` or `inferred`, the replaced line,
  and whether a note was created, beside the who, which app and when every
  record carries. The gateway has no protocol session id, so "which session"
  is the app and the time.
- **Activity names notes and counts facts, never the fact.** One `remembered`
  line per app per working stretch (six hours), across folders.
- **Every write rule is `write_note`'s.** `remember` reads through `read_note`
  and writes through `toolWriteNote`, so workspace (the `context` argument),
  permissions, visibility, encryption, live editing and indexing cannot drift.
  A password-locked note is refused, as `read_note` refuses it. Read-only
  connections are not offered the tool.
- **Context first, own memory allowed.** Agents are told (server instructions,
  the `context` skill, the tool description) to save here; an app's own
  built-in memory is not forbidden, because it cannot be switched off from
  here and need not be.

What reversing these would cost: a tag or heading per fact clutters every note
an agent touches; letting the agent rewrite the whole note loses which line
was the fact and what it replaced; putting the fact in Activity shows private
note text to anyone who can read the activity file.

Tests: `apps/mcp/test/remember.test.mjs`,
`apps/mcp/test/activity/remembered.test.mjs`,
`apps/mobile/__tests__/activity.test.ts` (the row and its mark).
