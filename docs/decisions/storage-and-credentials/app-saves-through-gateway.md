# The app saves a note through the gateway, as an AI client does (2026-11-24)

On 2026-11-24 the owner asked for the app's own saves to stop going through the control plane: "if we could migrate off
and just use what the mcp uses that would be great", then "ask another thread to work on this migration behind a
flag". It follows the 2026-11-06 rule that nothing about a note falls back to Convex
([no-convex-for-notes](./no-convex-for-notes.md)): the control plane keeps accounts, sign-in and grants, and a note's
body should not pass through it even in transit.

## Where the app's note traffic went on 2026-11-24

Already through the gateway, each with the control plane as its fallback:

- opening a note: `POST /files/read` (`apps/mcp/src/live/noteReadRoute.js`, since 2026-11-11);
- live typing and the editor's whole-text replacement: `/collaboration` (`live/collaborationRoute.js`);
- trash, restore, move, rename, copy and duplicate: `POST /files/*` (`live/fileOpsRoute.js`);
- the search bar: `POST /app/search` (`http/appSearch.js`);
- the tree and the change signal: the object's tree socket and its head (`objectTree.ts`, `objectHeads.ts`);
- folder pages' and Lists' notes with their front matter: `POST /files/folder-notes` (`live/folderNotesRoute.js`,
  `offline/gatewayFolderNotes.ts`), added the same day after the owner timed the Areas page at "like 3 seconds" and
  asked to "just be able to talk directly to cloudflare"; Convex's `folderNotes` answers what it hands back.

Still through Convex's `runFileOperation`:

- **whole-note saves**, `files.writeNote`: a new note, a save the live session did not carry, the offline outbox's
  drain (`useOfflineUpkeep.ts`, `queuedWrite.ts`), folder lists (`offline/useFolderLists.ts`), the browse pane's
  tasks (`useTaskHost.ts`), the admin AI notes (`admin/useAiNote.ts`), passphrase locks (`useNoteEncryption.ts`) and
  meeting notes (`meetings/convexGateway.ts`);
- **reads outside the editor**, `files.readNote` and `files.readNotes`: the everywhere bar, the note actions sheet,
  the map's peek and follow, folder lists, the admin AI notes, meetings, and the offline mirror's batch reads;
- **the mirror's listing and catch-up**, `files.syncManifest` and `nodesFeed.changes`;
- archive, new folder, visibility and group setters, pictures, plugins, the vault import and the activity list;
- **jobs the control plane runs itself**, about 75 files: websites (about 20), forms, shares and share cards, link
  previews and repairs, Google sync, routines, search upkeep, plugins, faces, emoji and exports.

## The order, and what this first part does

1. **The app's reads and saves, behind a flag, with the control plane as the fallback** (this part, saves first).
2. The app's remaining reads, the mirror's listing and catch-up.
3. The control plane's own jobs, last, each under a service identity of its own rather than a person's grant.

This part adds `POST /files/write` on the gateway (`apps/mcp/src/live/noteWriteRoute.js`) and sends the app's
whole-note saves there first (`apps/mobile/features/console/files/gatewayNoteWrite.ts`, `useWriteNote.ts`): the
editor's save, the offline outbox's drain, folder lists and the browse pane's tasks. The admin AI notes, passphrase
locks and meeting notes still call `files.writeNote` directly and move next. It is switched on per person by the feature flag
`files.app-saves-in-objects` ([feature-flags](../app-and-console/feature-flags.md)), checked by the app (read when a
save is made, at most once a minute, never subscribed to on render) and again by the gateway, and per workspace by where its notes live: only a workspace whose notes are in its object (`home:
object`, not behind) is served. Anything else answers 409 `not_object`, and the app makes the control plane's call as
before. So a workspace is served when its object holds its notes and its person has the flag: the flag is the
person's, as every flag is, and the workspace's home is the workspace's.

The app reaches the gateway with the console grant it already holds for opening notes and live typing
(`agent/consoleGrantCache.ts`): a short-lived token for the console's own client (`context_console`), minted by the
control plane for a signed-in person. Only that client may save here; an AI client saves with `write_note`.

## It keeps the control plane's save exactly

The offline outbox depends on what a save does with its version, and it must not change under it (`queuedWrite.ts`).
So the route keeps `fileOps.writeFile`'s rules, not `write_note`'s, which are for a model's call:

- a save over a note the editor reads live is the editor's whole-text replacement, merged from the exact version it
  was typed against (`replaceLiveText`, `onlyCurrent: false`), as `/collaboration` does, so an offline edit typed
  against an older version is merged and not parked;
- a save with no version is a create, and is a conflict if anything is there now; a save with a version over a note
  that is gone is a conflict with no current version; a conflict carries the note's current version, the one
  `files.writeNote` carried;
- a new note takes its folder's access; nothing is pinned on it, and a team reader may create only in a folder open
  to them;
- what it does not settle goes to the control plane unchanged: an encrypted note or an envelope (a passphrase lock is
  the control plane's narrower door), a note that is not collaborative Markdown, a member saving through an edit grant,
  a folder whose access is a group. Each is named by a reason in the gateway's log, so the next part can move it.

The answer is `files.writeNote`'s (`{kind: "written", path, etag, bytes, conflictCheck, forms}`), and a refusal is
the same error the app already reads (`CONFLICT` with `currentEtag`), so nothing past the call changes.

## Flags reach the gateway's session

Until this part the gateway's session never carried its person's flags: `sessionFromPayload` (`apps/mcp/src/session.js`)
built the session without them, so `flagOn` was always off there, and nothing noticed because nothing yet asked. It
carries them now; `noteWriteRoute.test.mjs` fails ("a save over a note…") if they are dropped again.

## What a simplification would cost

- Sending the app's save through `write_note` would make every offline edit against an older version a conflict
  (`write_note` merges only from the current version), and would pin a private rule on every note the owner made in a
  team folder. `apps/mcp/test/noteWriteRoute.test.mjs` fails on both ("an offline edit typed against an older
  version is merged…", "a new note takes its folder's access…").
- Taking the address's workspace on trust would let the outbox drain one workspace's edits into another. The body
  names the workspace and the gateway refuses a session for any other ("a save named for another workspace…"), and
  the app sends a save only to the workspace it names by slug (`gatewayNoteWrite.test.ts`).
- Letting any client save here would be a second `write_note` without its gates ("only the app's own client…").
- A note a team reader may not see answers exactly as a missing one ("a note held back is answered as a missing
  one…").
