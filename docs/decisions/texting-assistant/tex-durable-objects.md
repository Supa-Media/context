# Tex's notes live in Durable Objects, not the bucket

Decided by the owner, 2026-10-31: "why don't we just keep everything Tex
related in a durable object then, and not in storage", then "let's just do
durable object per personal tex and group tex, and have the agent connect to
the bucket regularly, I think it's fine for other agents to connect to the
files in durable objects", and "it should almost look the same in the convex
tree/control plane, with an id for file name, but then we just mark it as
living in a durable object and not a bucket".

## What it is

Tex's own notes (its chats and transcripts, About me, the jobs list, learned
skills, routines and heartbeat, dreams, attention, handbacks, housekeeping,
style and voice, a group chat's memory) keep their text in a Durable Object:
one per person, named by their personal workspace, and one per group chat
(`apps/mcp/src/texStore.js`, binding `TEX_STORE`). Each object keeps its
notes in its own SQLite, shaped like a bucket (`texStore/objects.js`), and
the gateway reaches it with its ordinary R2 adapter (`texStore/wire.js`).

Each such note still has its row in the file tree, its id for a file name, as
every note does. The row is marked as living in the Durable Object, and the
gateway reads and writes the note's text there instead of in the bucket. So
the app shows it, search finds it, other AI clients read and edit it, and
Download as folders includes it, through the same paths as any note.

The mark is the row's key itself: `tex/<owner>/notes/<noteId>.md`, the
owner `person:<workspaceId>` or `chat:<chatId>`, where a bucket note's is
`notes/<noteId>.md`. Every store the gateway or the control plane builds
routes a key of that form to its owner's object (`store/texRouting.js`), so
whatever holds a row's key (the id layer, the trash's emptying, an export)
reaches the right place without knowing about Tex. A key naming another
workspace's owner is refused, and with no way to reach the object the key is
refused rather than looked for in the bucket.

The control plane's own stores (Download as folders, emptying the trash,
filing a shared edit) reach the objects through the gateway's door,
`POST /internal/tex-store` (`apps/mcp/src/texStore/door.js`), as the mover
does: the gateway secret plus a ticket this deployment minted for one
workspace's own objects, five minutes long (`texStoreTickets`). The secret
alone opens nothing.

Notes Tex writes *for* the person (a packing list, a meeting's notes) are
ordinary notes in their bucket. Tex reads and writes the bucket as it always
did.

## Which object a turn may reach

A group chat's object is named by its key (`chat:<groupKey>`, the chat's
`textGroups.groupKey`). The key reaches the gateway only on the chat's own
grant, from the control plane, and only under the group client
(`session.js` `normalizeSession` via `sessionPayload.js`). A store is built
with the one key its session carries and no other (`sessionStore.js`
`texChatsOf`), so a person's turn reaches no chat's object and one chat's turn
reaches no other's. A new note under a chat's home in the pinned workspace is
keyed to that chat, and nowhere else: the home is found by its three words and
only in the pin (`lib/noteIds/texHome.ts`).

## What changes in the non-negotiables

- **#1**: a note body lives in the workspace's bucket, *except* a note whose
  row says it lives in Tex's Durable Object. Leaving still takes everything:
  export reads these as it reads any note.
- **#2**: the Cloudflare account that holds customer data now also holds
  these Durable Objects, beside the buckets, the search databases and the
  live-typing rooms. Still nothing of ours.
- **#3**: these notes are still plain Markdown through every read and export.

## Wiped with what owns them

A person's object is wiped when their personal workspace is deleted with
their account; a group chat's when the chat ends. Unlinking a phone does not
wipe anything: the notes are rows in the person's own workspace, still read,
searched and exported like any note, and an unlink is texted from the phone,
so whoever holds the number could send it. Cloudflare encrypts Durable Object
storage at rest. The object decides no access: the gateway has already
checked who is asking before it calls.

As built (`functions/texStoreWipe.ts`): the account deletion wipes the
person's object (`wipeWorkspace`, through `wipeOwner`), and `wipeOwner` can
wipe a group chat's object, retried with backoff. Nothing ends a Tex group
chat today ("Tex, stop" only mutes it), so nothing calls `wipeOwner` for a
chat yet; it is called when that event exists.

## Notes Tex already had

Tex's notes written before the move still sat in the bucket. A one-time job
(`functions/texMigration.ts`, run by hand from the `Tex notes into their
objects` workflow, dry run first) moves each live keyed row under the
person's Tex folder that is still keyed at its bucket id key. In order: the
body is copied to the person's object at the same id key, read back and
compared, the row's key is switched to the Tex form under a compare-and-swap
on the row's version, and only then is the bucket copy deleted. A crash
before the switch leaves the bucket copy authoritative. A bucket copy left
by a crash after the switch is removed on a later run, and only once the
object holds the note.

Not moved: a group chat's home in `@context-lc`, which is a separate change.

## Routine alarms

A routine's time is kept in the same object that keeps its notes
(`texStore/alarms.js`): one row per routine, its id, the time it is due and a
payload, which is what the place running it needs to find the run again. The
object holds one runtime alarm, armed at the earliest row, and re-arms it after
every change and every fire. When the alarm fires, each due row is handed on;
one that ran is removed, one that did not waits a minute and is tried again,
and no alarm is ever armed at a time already past. At most fifty go per fire.

The control plane's due list stays the source of truth, and the texting Worker's
once-a-minute cron stays as the backstop. The alarm only makes a run happen on
time instead of up to a minute late.

**Dispatch.** An alarm calls the texting Worker through the gateway's `TEXTING`
service binding (`texStore/dispatch.js`, `apps/agent/src/texRoutineDue.ts`):
`POST /tex/routine-due` with `{owner, id}`, the owner being the person's
workspace and the id the routine's path. The route needs `TEX_ALARM_SECRET` as
its bearer, on both Workers, and refuses everything without it, a chat's owner
included. It runs the routine through the cron's own path and answers when it
next runs, and the object keeps the routine for that time. The object never
holds a grant or any other credential: the texting Worker fetches the run and
its token from the control plane itself.

**Double fire.** The alarm and the cron can both ask. The control plane hands a
run out once: a claim moves the routine's next time past now and holds a lease
(`apps/convex/functions/lib/routines/runs.ts`), so the second ask finds nothing
due. The alarm's ask is scoped to its one routine (`{scope: {workspaceId,
path}}`) and never takes another routine's run.

**Scheduling.** A write to a Tex routine's file sets its alarm, or cancels it when
the file is gone or paused (`texStore/routineAlarm.js`, from `activity/record.js`).
The time is computed from the file with the shared schedule module. That may not
know the account's time zone, so an alarm can fire at a moment the control plane
does not yet find due; then nothing runs and the cron runs it at its own time.
Failure to schedule never fails the write.

Not on alarms, for now: a routine in a group chat (its chat's own runs stay on
the cron) and the routines under `routines/` (the cron runs them).

## Cost of reversing it

Tex's state goes back to many bucket reads per turn (a second each through
the adapter), which is what made "hi Tex" take a minute before the warm copy.

Tests: `apps/mcp/test/texStore.test.mjs` and `apps/mcp/test/texAlarms.test.mjs`.
