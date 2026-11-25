# Photon bridge

Holds the Photon iMessage streams for Tex, and is the one network exit for its
Photon sends.

## Why it exists

- Photon's hosted webhooks deliver messages, attachments, rich links and
  reactions. They do not deliver edits, unsends, read receipts or typing.
- The gRPC event log has all of them, with a durable `sequence` and
  `events.catchUp(seq)` replay, so a restart resumes without a gap.
- gRPC needs Node. Workers have no gRPC, so the streams run in a container.

## Parts

- `src/index.ts`: the Worker and the `PhotonBridge` Durable Object. The object
  starts the container, keeps it alive with its alarm, long-polls it for
  mapped events, delivers each to the agent over RPC (`PhotonEvents.event`),
  acks it, and stores each line's contiguous checkpoint in its own storage.
- `container/`: a Node 22 process. `runtime.mjs` mints line tokens and runs
  one listener per line (`listener.mjs`); `map.mjs` turns raw events into the
  agent's event shape; `ledger.mjs` holds the queue and the frontier;
  `app.mjs` serves the ops.
- `src/pump.ts`: delivery and retry. A 2xx or 4xx from the agent passes the
  event; a 5xx or a thrown call retries and the checkpoint does not move.
  Order is kept per chat, not per line (2026-11-25): a chat whose event is
  failing is retried with backoff while `/next?skip=<chat>` hands out every
  other chat's events. A chat held 2 minutes logs `bridge.alert chat_held`;
  an event still failing after 5 minutes is parked in the object's storage
  (`parked:<id>`), acked so its chat moves on, logged `bridge.alert
  event_parked`, offered again hourly and dropped after a day
  (`parked_dropped`). `scripts/tex-line-alert.mjs` reads those alerts every 5
  minutes and keeps a `tex-line-alert` issue open while they fire.
- `container/delivery.mjs`: Photon has no delivery event, so each send is read
  back (`messages.get`) 30 s and 3 min after it went. An error code becomes a
  `message.status` event, state `failed` (the agent marks the send, and sends a
  threaded text again plain); a send still not delivered at the last read is
  `undelivered`, shown on the send step only. These events carry no sequence
  and move no checkpoint; a container restart loses the checks still waiting.
- Tex sticks a sticker on a message with the `sticker` op (the SDK's
  `placeSticker`): an image already on the line (its attachment guid) or one
  uploaded with the call, placed on the bubble in Photon's bubble space
  (centered, scale 0.45, width 96 unless the call says otherwise). Photon has
  no sticker-only send: a sticker always goes on a message.
- Stickers stuck on a message map to a `sticker` reaction, and poll changes
  (started, option added, voted, vote taken back) to a message in words.
  Any event the bridge does not map is counted by type in the minute
  `bridge.health` line (`skipped`), never dropped unseen.

## Gaps and replays

- A sequence Photon never sends must not pin a line. A full catch-up skips
  every sequence up to its head that it did not see, and a gap that holds
  `GAP_TIMEOUT_MS` (10 min) is skipped after a successful poll. Queued events
  still stop the frontier. Both are logged as `line.gap_skipped`.
- A catch-up event older than `MAX_REPLAY_MS` (12 h, the agent's window in
  `packages/tex/worker/replayWindow.ts`) is passed without being delivered, counted
  as `replayDropped`. An event Apple gave no time is stamped now and marked
  `atGuessed`, so it is never dropped as old.
- The object stores the container's frontiers each minute (`GET /frontiers`,
  reachable only through the container port), so a skipped or dropped sequence
  is not replayed after a restart.
- Alerts: `bridge.alert` with `big_replay` (a first catch-up of over 50 events
  or reaching back over an hour) and `frontier_stuck` (a frontier unmoved for
  15 min while newer events arrive). Constants: `container/replay.mjs`.

## Surface

- No public route. `workers_dev` is off and there are no routes. The agent
  reaches the outbound ops only through its `PHOTON` service binding.
- Secrets: `PHOTON_PROJECT_ID` and `PHOTON_PROJECT_SECRET`, sent with the
  Worker on `wrangler deploy --secrets-file` when both exist. Unset, the
  Worker answers 503 `unconfigured` and nothing listens, so the deploy is
  inert. A separate secret put after deploy is a second version and a second
  container start, which is what left the bridge with no instance on
  2026-11-17.
- Health: `bridge.health` is ok only when a Photon read has succeeded within
  two poll intervals (two minutes). Older than that is degraded. At three
  minutes, with the container still claiming to be up, the object restarts
  it. A missing container retries the wake and schedules the next alarm in
  a few seconds. The first read after a start logs `line.read` with
  `replayed` and `lag_ms` (the oldest event's age).

## Testing

- `pnpm test` runs the Worker suites (vitest) and the container suites
  (`node --test`). The container suites import the SDK, so run
  `npm ci --prefix container` first; CI does the same.
- `pnpm typecheck` checks the Worker.

## Open

- The container cannot push to the object, so the object pulls. A live check
  of that and of the container's start env is still needed.
- The agent needs a `PhotonEvents` entrypoint with `event(body)`.
- First start probes the log head: a new line replays no history.
