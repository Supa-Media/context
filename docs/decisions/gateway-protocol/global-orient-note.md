# Gateway protocol: the Context.LC-wide orient note

## One note from Context.LC leads every orientation

Decided with the owner, 2026-09-29. `orient` opens with `guides/agents.md`
from the pinned `@context-lc` workspace, ahead of the caller's own front page,
so a standing rule for every agent ("update a task's status as you go") is one
edit rather than one per workspace.

- **No new store and no new permission.** It is an ordinary note, read through
  the caller's own pinned reach (`member`, team tier) and that context's
  `privacy.md`, so orient never shows a word `read_note` would refuse. Who can
  change it is who can write `@context-lc`: staff.
- **Capped at 50 lines** (and 6,000 characters), cut with a pointer to the
  whole note, because it is prepended to every session.
- **Absent is silent.** No pinned context (every self-hosted deployment), no
  note, a held-back note or an unreachable bucket all mean no section, never
  an error.

Reversing the privacy filter or the addressed-store hand-off fails
`apps/mcp/test/globalOrientNote.test.mjs`.
