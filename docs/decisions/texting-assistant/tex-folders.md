# A person's Tex folder and a group chat's home use the same names (2026-11-01)

_Part of [the texting assistant](../texting-assistant.md). Decided by the owner, 2026-11-01: "it still irks me that 1:1 tex folders and group tex folders vary so differently in structure, i would like them to mirror", then "get started on migrating everything to have this shape", with the recommended answer on each open call._

## The shape

| | A person's Tex (`tex/` in their personal workspace) | A group chat's home (`tex/groups/<words>/` in `@context-lc`) |
|---|---|---|
| Who they are | `about.md` (was `about-me.md`) | `about.md` (was `about-us.md`) |
| How they talk | `voice.md` (`personVoice.js`, read with About me in the desk's one call) | `voice.md` (was `voice-<id>.md`) |
| What was said | `history.md` (to come; one record today, [one-to-one-history](./one-to-one-history.md)) | `history.md` (was `chat-<id>.md`, [group-memory-one-copy](./group-memory-one-copy.md)) |
| Everything Tex kept, as Tex sees it | `history.ledger.json` (read only; `texStore/historyView.js`) | `history.ledger.json` (the same, for the chat's own ledger) |
| Open jobs | `jobs.md` | `jobs.md` (`chatJobs.js`, read straight from the chat's object once its key is kept) |
| Reminders and check-ins | `routines/` | `routines/` (since 2026-11-02; a routine in the bound workspace tagged `chat:` still runs) |
| Daily notes | `transcripts/` (no longer written since 2026-11-02; the ledger is the record) | none |
| Pictures they texted | `pictures/` (one note a month, `textedPictures.js`) | `pictures/` (the folder stands; not written yet) |
| What Tex learned | `skills/` | `skills/` (`chatSkills.js`: the same notes and rules; written unless the turn read something from outside the chat) |
| Mail, calendar, tidying | `heartbeat/`, `attention/`, `dreams/`, `handbacks/`, `housekeeping/` | the same folders stand (since 2026-11-02); no chat job writes them yet, and a chat has no mailbox or calendar |

A chat's people are inside it (the owner, 2026-11-02: "as long as it's inside the texts from people in that group, then it's fine ... it's almost like they give combined consent"). A group turn still holds its sends as any turn carrying other people's words does (`markChatWords`), but only a page, an email or a file read that turn (`ledger.outside`) stops it writing a skill in its home. A home's skill is never archived (that would carry it out of the seal) and has no `used:` stamp or dream retiring it yet.

Where each home is does not change. The workspace's playbook stays in the bound workspace (`tex/groups/playbook.md`). Each history stays one copy in its Durable Object, read before the model with About me; nothing here adds a second.

`history.ledger.json` is a row like any Tex note, made by the chat's next turn (`agent/historyFile.js`), whose key in the chat's object holds a marker and never a copy: a read answers the chat's ledger as it is now, its newest 1,000 entries oldest first, under 4 MB, with `view.older` saying more is kept (the owner, 2026-11-02: "I just want people to be able to see it, like, okay, this is exactly what Tex sees"). Every tool that can change a note refuses the path with words the model can act on, and the object refuses any write over the marker. Download as folders carries the whole ledger as `.context/tex/ledger/`, and skips this row, so the chat leaves once. A connected AI reads it the same way: `fetch` of the path (`tex/history.ledger.json`, or the one in a home) is `read_note` with that row's access, even though the name is not `.md` (Dev, 2026-11-03: agents should be able to read the history files; renaming it `.md` was weighed and not done, since its text is the ledger's JSON and the app, export and Tex already know it by this name). A person's own `tex/history.ledger.json` takes a visibility of its own, the one file that is not `.md` and does (`apps/convex/functions/lib/filesFns/visibility.ts` `takesOwnVisibility`): its owner can open it to the team, so a team-tier connection reads the chat without being given every private note (the owner, 2026-11-04: "i don't want to give you private access to everything, just this file"). A group chat's history file never takes one: its home is sealed to the chat's people. Test: `apps/convex/__tests__/historyFileVisibility.test.ts`.

## Every home holds every folder (2026-11-02)

The owner, 2026-11-02: "Both with the same type of folders in them? so routines, heartbeats, about, skills, dreams, etc". A home is made with every folder a person's Tex has. Since the owner's "I want 1:1 tex and group tex to start mirroring each other and not diverging so much" (2026-11-02) the two are one list: a home's folders (`HOME_FOLDERS`, `lib/textGroupHome.ts`) are `HOME_TEX_PARTS` in `packages/shared/src/folderJobInfo.cjs`, which is a person's `TEX_PARTS` less `PERSON_ONLY_TEX_PARTS`. A folder added for a person reaches every home unless it is named person-only, and only three are: `chats` and `groups` (they hold the chats themselves) and `transcripts` (no longer written). `apps/convex/__tests__/textGroupHome.test.ts` fails if the lists drift. A home that lacks any of them gets them on its chat's next turn, or from the `Tex chat home people` workflow (`unstood` counts them) without waiting for a text. A folder is a row under the home's own row, so it is sealed as the home is. Which of them a chat's jobs write is a separate step: today a chat's turns write `skills/`, `routines/`, `about.md`, `voice.md`, `history.md` and `jobs.md`.

## The rename

- Each rename is a row move (`apps/convex/functions/texFolderNames.ts`, workflow `Tex folder names`, `dry_run` first): the note keeps its key, its text and its history, so the reads by key (the desk, `texDesk.js`; a home's direct reads, `groupDirectNotes.js`) are the same note after it.
- A new name already taken is never moved onto: both are counted (`both`) and left for a person to look at. Nothing is deleted.
- Until it has run everywhere, the gateway reads a note under its old name when the new one has nothing (`aboutMe.js` `OLD_ABOUT_ME_PATH`, `homeNames.js`), and the keys looked up behind each reply say which notes are still under their old names (`direct.old`), so the next exchange is written onto the old page and never starts a second one beside it. Once the workflow reports nothing left, the fallbacks are removed.

## What a simplification would cost

- Writing under the new name before the rename has run: a fresh, empty `history.md` beside the chat's real page, and the next turn reading that one. That is the forgetting of 2026-11-01 again.
- Copying a note to its new name instead of moving its row: a new key, so its editing history and every read by key are lost.

- Keeping the history file's text in the object: a second copy of the chat, which drifts from the ledger and is exported twice.

## Tests

- `apps/mcp/test/historyFile.test.mjs`: the file reads the ledger as it is now and keeps nothing of it; a write over it is refused by the tools and by the object; the next turn makes the row once.

- `apps/mcp/test/texFolderNames.test.mjs`: the names on both sides; a person's note under its old name is read; an unreadable new name is never read past; a page under its old name keeps its key and is written there, never a second one.
- `apps/convex/__tests__/texFolderNames.test.ts`: the rename uses the gateway's names, and a taken name is never moved onto.
