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

## Surface

- No public route. `workers_dev` is off and there are no routes. The agent
  reaches the outbound ops only through its `PHOTON` service binding.
- Secrets: `PHOTON_PROJECT_ID` and `PHOTON_PROJECT_SECRET`, set by the deploy
  workflow when both exist. Unset, the Worker answers 503 `unconfigured` and
  nothing listens, so the deploy is inert.

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
