# Provider events: capture the shapes before designing for them (2026-11-06)

Decided by Dev2, 2026-11-06. Before deciding how edits, deletions, statuses,
calls and group changes enter a conversation, Tex records what its two lines
actually send. Handling is designed after the samples are read, not before.

## What is subscribed

Whapi (WhatsApp), set by `.github/workflows/whapi-setup.yml` (dry run by
default; the owner applies it per environment):

- `messages`: `post`, `patch` (edits, poll votes), `delete`
- `statuses`: `post`, `put` (group message statuses arrive only as `put`)
- `groups`: `post`, `put`, `patch`
- `calls`: `post`
- `chats`: `post`, `delete` (`patch` is left out: it fires on every message)
- `presences`: `post` (the group typing experiment, `whapi-presence-probe.md`)
- `channel`: `post` (health), `patch` (QR code)
- `users`: `post`, `delete` (a session connected or disconnected)

Not subscribed: `messages.put`, `contacts`, `labels`, `service`.

## What the Worker does with them

Only a Whapi `messages.post` delivery is read as messages
(`parseWhapiWebhook` checks `event.type` and `event.event`). Every other
event, from either line, is answered 200 so the provider does not retry it,
is never queued, and is logged once as `whapi_event_shape` or
`sendblue_event_shape`: the provider, the event's type and method when they
are plain codes, the top level keys, and every nested key path with its
value's type (`webhookShape.ts`). Never a value: no phone number, id, text or
media. A key that could itself be a value (a phone number used as a map key)
is written `*`. A body that is not JSON is answered 200 too. Linq keeps its
400s.

The agent-logs workflow publishes `type` and `method`; the full `shape` list
stays in Workers Observability only.

## Manual checks for the owner

In the Sendblue dashboard, for each webhook type, whether it is enabled and
whether it points at this Worker's `/sendblue` with the same signing secret
(a different secret answers 401 and is never described):

- `typing_indicator`
- outbound message status
- `inbound_call`
- `line_blocked`

Then apply `whapi-setup.yml` to one environment and read the shape records.

Tests: `whapiWorker.test.ts` ("whapi events that are not new messages"),
`worker.test.ts` (each "takes a ... delivery with 200, logs its shape
without a value, and queues nothing").
