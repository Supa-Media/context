# A person's Tex folder and a group chat's home use the same names (2026-11-01)

_Part of [the texting assistant](../texting-assistant.md). Decided by the owner, 2026-11-01: "it still irks me that 1:1 tex folders and group tex folders vary so differently in structure, i would like them to mirror", then "get started on migrating everything to have this shape", with the recommended answer on each open call._

## The shape

| | A person's Tex (`tex/` in their personal workspace) | A group chat's home (`tex/groups/<words>/` in `@context-lc`) |
|---|---|---|
| Who they are | `about.md` (was `about-me.md`) | `about.md` (was `about-us.md`) |
| How they talk | `voice.md` (to come) | `voice.md` (was `voice-<id>.md`) |
| What was said | `history.md` (to come; one record today, [one-to-one-history](./one-to-one-history.md)) | `history.md` (was `chat-<id>.md`, [group-memory-one-copy](./group-memory-one-copy.md)) |
| Open jobs | `jobs.md` | `jobs.md` (to come) |
| Reminders and check-ins | `routines/` | `routines/` (to come; today in the bound workspace, tagged `chat:`) |
| Daily notes | `transcripts/` | `transcripts/` (to come) |
| What Tex learned | `skills/` | `skills/` (to come) |
| Mail, calendar, tidying | `heartbeat/`, `attention/`, `dreams/`, `handbacks/`, `housekeeping/` | none: a chat has no mailbox or calendar |

Where each home is does not change. The workspace's playbook stays in the bound workspace (`tex/groups/playbook.md`). Each history stays one copy in its Durable Object, read before the model with About me; nothing here adds a second.

## The rename

- Each rename is a row move (`apps/convex/functions/texFolderNames.ts`, workflow `Tex folder names`, `dry_run` first): the note keeps its key, its text and its history, so the reads by key (the desk, `texDesk.js`; a home's direct reads, `groupDirectNotes.js`) are the same note after it.
- A new name already taken is never moved onto: both are counted (`both`) and left for a person to look at. Nothing is deleted.
- Until it has run everywhere, the gateway reads a note under its old name when the new one has nothing (`aboutMe.js` `OLD_ABOUT_ME_PATH`, `homeNames.js`), and the keys looked up behind each reply say which notes are still under their old names (`direct.old`), so the next exchange is written onto the old page and never starts a second one beside it. Once the workflow reports nothing left, the fallbacks are removed.

## What a simplification would cost

- Writing under the new name before the rename has run: a fresh, empty `history.md` beside the chat's real page, and the next turn reading that one. That is the forgetting of 2026-11-01 again.
- Copying a note to its new name instead of moving its row: a new key, so its editing history and every read by key are lost.

## Tests

- `apps/mcp/test/texFolderNames.test.mjs`: the names on both sides; a person's note under its old name is read; an unreadable new name is never read past; a page under its old name keeps its key and is written there, never a second one.
- `apps/convex/__tests__/texFolderNames.test.ts`: the rename uses the gateway's names, and a taken name is never moved onto.
