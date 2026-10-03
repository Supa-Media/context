# Remember in Context

Status: decided with the owner on 2026-10-02, and built. Durable decisions: `docs/decisions/gateway-protocol/remember.md`.

## Intent

Agents save durable facts about the person to Context as they learn them, so
every connected app reads one shared record instead of each app keeping its
own. It is continuous without being a background sync: the agent that learns
the fact writes it, through one tool, at the moment it learns it.

What it is not: an import of another app's memory store (no confirmed way in;
`agentSetup/bring.ts` already covers the first-day backfill for any app that
can connect), a separate memory database, or a sync between Context and an
app's built-in memory (two sources of truth, echo loops, churn).

## Decisions (owner, 2026-10-02)

| # | Decision |
|---|---|
| 1 | Agents save **without asking**, whether the person stated the fact or the agent inferred it. |
| 2 | A fact goes into **the best existing note** (the agent searches first), otherwise a short new note in `0-inbox/`. |
| 3 | **Which workspace:** exactly as `write_note` decides (its `context` argument, otherwise the connection's default workspace). |
| 4 | **New-note visibility:** exactly as `write_note` would give that path. No rule of its own. |
| 5 | **Notes stay clean:** the fact is a plain line. No tag, no heading, no marker in the text. |
| 6 | **Provenance lives in the audit record:** who, which app, when, the note, the fact, `stated` or `inferred`, and the old wording when a line was replaced. |
| 7 | **A contradicting fact replaces the old line**; the old line is kept in the audit record. |
| 8 | **Activity** shows one grouped line per app per working stretch, naming notes and a count, never the fact text. |
| 9 | **Mechanism:** a new gateway tool, `remember`, that adds or replaces one line. |
| 10 | **Apps with their own memory** are told to use Context first; their own memory stays allowed. |

Research behind 5 to 7 (provenance per fact, stated kept apart from inferred,
machine-readable dates, nothing lost on replace) is summarized in the
conversation that produced this file; the nearest existing designs are
Letta's `core_memory_append` / `core_memory_replace` and Anthropic's memory
tool (`str_replace`, `insert` over plain files).

**"Session" means app plus time.** The gateway has no protocol session id
(every request stands alone), so the audit record ties a fact to the client
(`actor_client_id`, shown as the app's name) and the time. A saved session note
from the same app carries the same name and time, which is the evidence trail.

## Data model

No new table and no new control-plane field: everything lives in the
customer's bucket, as the audit trail and `activity.md` already do.

**Audit record** (`.context/audit/<timestamp>-<uuid>.json`, written by
`recordChange`), for action `remember_fact`:

```json
{
  "at": "2026-10-02T14:03:11.204Z",
  "action": "remember_fact",
  "actor_scope": "private",
  "actor_user_id": "…", "actor_client_id": "…", "workspace_id": "…",
  "paths": ["3-resources/working-preferences.md"],
  "details": {
    "fact": "Prefers short replies.",
    "kind": "stated",
    "replaced": "Prefer concise but complete answers.",
    "created": false,
    "etag": "…"
  }
}
```

`replaced` is absent when the fact was added; `created` is true when
`remember` made a new inbox note.

**Activity:** a new kind, `remembered`, in the shared vocabulary
(`packages/shared/src/activity.cjs`). It merges across folders (unlike
`revised`), for one hand and one app, inside the session window (six hours,
`SESSION_WINDOW_MS`). Sentence: "@jhon's Claude remembered 3 facts in
`working-preferences.md`, `about-jhon.md`". The line's machine copy carries
paths and a count, never fact text.

## API

### `remember` (gateway tool)

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `fact` | string | yes | One plain sentence, at most 500 characters, one line. |
| `kind` | `"stated"` or `"inferred"` | yes | Whether the person said it or the agent concluded it. |
| `note` | string | no | Path of the note it belongs in. Omitted: a new note in `0-inbox/`. |
| `replaces` | string | no | The exact existing line it supersedes (bullet marker optional). |
| `context` | string | no | Another workspace, exactly as on `write_note`. |

Behaviour:

1. Resolve the workspace and check write permission exactly as `write_note`.
   Read-only connections are not offered the tool (`readOnlyHint: false`).
2. With `note`: read it (with its etag). If `replaces` matches one line
   exactly, after trimming and ignoring a leading `- ` or `* `, that line
   becomes `- <fact>`. If `replaces` is given and matches no line or more than
   one, refuse (`replaces_not_found` / `replaces_ambiguous`) and change
   nothing. Without `replaces`, append `- <fact>` at the end of the note.
3. Without `note`: create `0-inbox/remembered-<YYYY-MM-DD>-<slug>.md` holding
   `- <fact>`, created only if absent.
4. Write through `toolWriteNote` with the etag read in step 2, so encryption,
   collaboration rooms, forms, drawings, visibility and indexing behave exactly
   as on any write. A conflicting concurrent edit is retried once on a fresh
   read, then refused (`conflict`).
5. Record the change as `remember_fact` with the details above, instead of the
   `update_note` / `create_note` record `write_note` would make.

Result: one sentence naming the note and whether the fact was added or
replaced a line. Refusals, as sentences the agent can act on:

| Code | When |
|---|---|
| `invalid` | `fact` empty, over 500 characters, or more than one line; `kind` not one of the two. |
| `reserved_path` | `note` is `index.md`, `privacy.md`, `activity.md` or under `.context/`. |
| `not_writable` | the path is not writable on this connection (the `write_note` rule). |
| `encrypted` | the note is password-locked (never edited by an agent). A note encrypted with the workspace key is written as `write_note` writes it. |
| `replaces_not_found` / `replaces_ambiguous` | as above. |
| `conflict` | the note changed twice while writing. |

### Agent instructions

- `apps/mcp/src/mcp/instructions.js` (sent to every MCP client): "When you
  learn something durable about the person (a preference, a correction, a
  fact about them or their work), save it with `remember`, without asking.
  Search for the note it belongs in first. Mark it `inferred` if they did not
  say it. Use `replaces` when it changes something already written. You may
  also keep it in your own memory."
- `plugins/context/skills/context/SKILL.md`: the same rule, with
  `skills.test.mjs` asserting the skill names `remember`.
- The `remember` tool description repeats the rule and the refusals.

## Files

| Area | Files |
|---|---|
| Tool | `apps/mcp/src/tools/schemas/notes.js` (definition), `apps/mcp/src/tools/notes/remember.js` (new), `apps/mcp/src/tools/dispatch.js` (case) |
| Write path | `apps/mcp/src/tools/notes/write.js`: an option letting a caller record the change as another action with its own details |
| Activity vocabulary | `packages/shared/src/activity.cjs` is 904 lines with no reviewed entry, so its vocabulary (kinds, action map, sentences) moves to `packages/shared/src/activityVocabulary.cjs` first, then `remembered` is added there |
| Activity view | `apps/mobile/features/console/activity/activity.ts` (the kind and its mark) |
| Instructions | `apps/mcp/src/mcp/instructions.js`, `plugins/context/skills/context/SKILL.md` |
| Decision record | `docs/decisions/gateway-protocol/remember.md`, indexed in `docs/decisions/README.md` |

## Tests

Gateway (`apps/mcp`, against the store stub):

1. Adds a fact as the last line of the named note; the rest of the note is
   byte-identical.
2. `replaces` swaps exactly one line; the audit record holds old and new
   wording and `kind`.
3. `replaces` with no match or two matches refuses and writes nothing.
4. No `note`: creates one inbox note with the fact; visibility is what
   `write_note` gives that path.
5. Workspace: `context: "@name"` writes there under the same rules as
   `write_note`; a workspace the person cannot write to refuses.
6. Read-only connection: the tool is not offered and a direct call refuses.
7. Reserved paths, encrypted notes and invalid facts refuse with the codes above.
8. A concurrent edit between read and write is retried once, then refused,
   never overwritten.
9. The note text never contains provenance; the audit record always does.
10. Isolation: a `remember` in workspace A never reads or writes workspace B.

Activity (`packages/shared`):

11. Three `remember_fact` changes by one app in two folders within the window
    make one `remembered` line naming both notes, count 3.
12. A different app, or past the window, makes a new line.
13. The line and its machine copy never contain the fact text.
14. The vocabulary split changes no existing line (existing activity tests pass unchanged).

Instructions: the server instructions and the `context` skill name `remember`,
and the gateway defines it (`skills.test.mjs`).

Each guard (exact-line match, conflict retry, reserved paths, read-only,
no fact text in Activity) is sabotaged once and its test must fail.
