# Gateway protocol: the live map reads the activity feed, and every path in it is the caller's

**Decided 2026-10-07**, extending "Agent activity is announced from finished
tool calls, never streamed" in [gateway-protocol](../gateway-protocol.md) and
[active people bar](../app-and-console/active-people-bar.md). The console's
Map draws every visible note as a dot, and on it the people and agents working
there now: reading, editing, creating, moving. It reads the same
`GET /agent-activity` answer the file tree does, polled every few seconds
while the map is open instead of every half minute. Nothing new is stored and
no new socket is opened.

## What the answer adds

All fields are additions; the tree's `marks` and the agent list's `kind`
(`read | write`), `reads` and `writes` are unchanged.

- **Finer agent kinds.** The log records `read`, `edit` (`write_note` on a
  note that was there), `create` (one that was not), and `move` (`move_note`,
  `move_notes`, `move_folder`, `archive_note`; one event per *note* moved,
  `from` → `path`). Each is recorded after the tool succeeded, from what the
  handler reported beside its answer under a Symbol (`live/activityHint.js`),
  never from the arguments alone, and never in the text the client sees. A
  move between workspaces is not recorded. `edit`, `create` and `move` are
  all `write` to the tree.
- **Per agent**: `doing` (the finer kind of its newest event), `from` (when
  that was a move), and `readPaths`, the visible notes it read in the window,
  oldest first, repeats in a row collapsed, the newest 30 ("What it's
  reading").
- **`events`**: up to 200 visible events, newest last:
  `{at, kind, path, from?, to?, actor: {id, kind: "agent" | "person", name}}`.
  `at` is strictly increasing within the workspace's log, so `?since=<at of
  the newest event held>` returns exactly what is new. `since` narrows
  `events` only.
- **Per person**: `path` and `doing` (`read | edit`), the note their console
  has open, or `null`.

## The heartbeat may say where a person is, and what they just did

The console's poll is already its person's heartbeat. It may add
`note=<path>&doing=read|edit`, and, after a create or move it finished through
the control plane (which no tool call reports), `did=create&path=…` or
`did=move&from=…&to=…`. A person's announcement lands in `events` as
`actor.kind: "person"`, and never in `marks` or the agent list.

Each is the person's own claim, drawn on everybody else's map, so it is
checked in the gateway (`live/activityHeartbeat.js`) and dropped silently when
it fails:

- only the console's own client speaks for a person; a tool calling the route
  is never given a face;
- every path must pass `canSee` for the caller (groups as private, plumbing
  never) **and exist in the bucket**;
- a move needs `to` present and `from` absent, so nobody draws a move between
  two notes that are both still there; a create needs the note present; both
  need write, and so does `doing=edit` (a reader is shown reading);
- the same announcement twice in the window is one event.

**Why existence is checked, and checked for every caller.** Without it a team
member could report `note=1-projects/rates.md` and learn from their own entry
coming back placed or `null` whether that path carries a private override —
the oracle `/presence` closes. With it, a hidden note and a missing one both
come back `null`. The metadata probe runs whether or not `canSee` passed, for
the reason `handlePresence` gives: a refusal that skipped the bucket only for
hidden paths would be cheaper exactly when something is held back. The cost is
at most a metadata probe or two per poll that names a note, which is the price
of the map's rate.

## Every path leaves through the caller's `canSee`

Unchanged in kind: the room holds every path, private ones included, and the
route filters for each caller against the live `privacy.md`, before
aggregation. Now that includes each person's `path` (shown only when *this*
caller can see it, rebuilt field by field so nothing else the room holds
passes through) and every event.

**A move is shown only when both ends are visible.** Revealing the visible end
alone — a note appearing from nowhere, or vanishing — is true about the tree,
and still tells the caller that somebody, at this moment, moved it from or to
somewhere they cannot see. So a half-hidden move is dropped from `events`,
`marks` and the agent list alike, and the change shows up at the caller's
next listing, as it did before the map. This is the narrow answer rather than
the clever one, for the same reason groups are private here.

## Polling at the map's rate

A poll writes no storage: the log and roster stay in the activity object's
memory, pruned on access. Each poll costs what it did (one session
resolution, one `privacy.md` read, one Durable Object request), plus the
probes above only when it names a note.

What would break it: showing one end of a half-hidden move, passing a
person's path through unfiltered, accepting a heartbeat path without `canSee`
or without the unconditional existence probe, counting a person's
announcement as an agent, or letting two events share an `at`. Each is
sabotage-tested in `apps/mcp/test/agentMap.test.mjs`.
