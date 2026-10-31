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

## Cost of reversing it

Tex's state goes back to many bucket reads per turn (a second each through
the adapter), which is what made "hi Tex" take a minute before the warm copy.

Test: `apps/mcp/test/texStore.test.mjs`.
