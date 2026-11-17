# App and console — what Convex reads and writes on a clock and on every save

### No full-tree reread on a timer, and no write per save to a row every listing reads

*Decided 2026-10-19*, after Convex database reads climbed from about 2 GB a
day to 55 GB a day between 2026-10-15 and 2026-10-18. Writes stayed under 2%
of the I/O.

**Why.** `nodes` rows are heavy. Each carries the note's front matter, first
heading and first paragraph ([convex-facts](./convex-facts.md)). Any job that
walks a whole tree therefore costs the size of every row in it. A Convex
subscription also re-runs whole whenever a document it read changes. Two
patterns combined to produce the bill:

- **A clock that rereads trees that did not change.** The id-copy cron
  (`noteIds.keepCurrent`) started a fresh pass for every finished workspace
  every 15 minutes. Each pass walks every row. In a keyed workspace every row
  is already fresh, so every pass found nothing, 96 times a day per tree.
- **A per-save write to a row that every live listing reads.** The edits
  gathered after a save lived on `nodeTrees`, and every `listFolder` and feed
  `head` reads that row. Every save therefore re-ran every open listing of
  every member. The grant's `lastUsedAt` was also stamped on every gateway
  request, a typing collaborator's keystrokes included, and each stamp
  re-ran the owner's subscribed grant list.

**The rules.**

- A cron that walks a tree runs only when the tree changed since its last
  walk. The change log head (`nodeLog`) is the signal: `copyPassOwed` for the
  id copy, `factsDue` for the facts. A cron never rereads a tree because
  time passed.
- Bookkeeping that changes per save, per request or per keystroke never
  lives on a document that subscribed listings read. It gets its own row:
  `nodeTreeEdits`, not `nodeTrees`.
- "Last seen" stamps are throttled. `touchGrant` writes at most once every
  five minutes.
- A tree read of a workspace on its object stays on the object while the only
  push still waiting is a content edit. A push that may narrow, replace the
  tree, or clear the binding, and a waiting list too long to see the end of,
  is read from Convex's rows. Scanning every node document for a content edit
  was most of `nodes.listLive`.
- A token's workspace list is saved and reused while the grant, its
  memberships, its groups, handles and emails, and each workspace's access
  version are unchanged. The access snapshot is not read again for that list.
  The version lives on its own small row, written in the same transaction as
  `nodeAccessState.version`. A revoked grant or a removed membership never
  reuses the list.
- A reader that needs both the mirror and the rules reads the access
  snapshot once (`readerView`).
- A live frame with nobody to relay to is authorized at most every 30 seconds
  per socket. A revoked sender is still closed within that time, and still
  receives nothing.

**What a simplification would cost.** Putting a per-save field back on
`nodeTrees`, or letting a cron restart a pass because it finished, brings the
bill back.

**Tests that fail.**

- `noteIdsCopy.test.ts`: the cron starts nothing for an unchanged tree.
- `gatewayTreeTouch.test.ts`: a save writes nothing a folder listing reads.
- `grants.test.ts`: the stamp is written at most once every five minutes.
- `relayV2SpeculativeUpdates.test.mjs`: solo keystrokes are authorized once.
- `workspaceObjectTreeReads.test.ts`: a share taken back is not read from the
  object, and a content edit still waiting is.
