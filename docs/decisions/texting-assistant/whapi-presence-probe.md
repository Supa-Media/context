# Group typing: a WhatsApp experiment before any build (2026-11-01)

Decided by Jhonatan, 2026-11-01. Tex could hold its answer while someone in a
group is still typing, but neither line tells it reliably who is typing where.

- **iMessage (Sendblue):** group typing exists only since iOS 26, Sendblue's
  docs say groups are unsupported, and its `typing_indicator` webhook carries
  no chat id, so a group's typing could not be placed. Not used; Sendblue was
  asked for a group id on that webhook.
- **WhatsApp (Whapi):** WhatsApp shows who is typing in a group, and Whapi
  delivers presences after `POST /presences/{groupJid}`, but its documented
  payload (`contact_id`, `status`) names no group.

So Tex runs an experiment in production: the channel's webhook takes
`presences` (`.github/workflows/whapi-setup.yml`), a WhatsApp group's
presences are watched once a UTC day from its first message
(`watchGroupPresenceDaily` in `apps/agent/src/whapi.ts`, best effort, 409
counts as watching, never blocks a message), and each delivery is only
described in the logs as `whapi_presence_shape`: its keys, its status, and
whether `contact_id` names a group, a person or something else
(`logPresenceShape` in `apps/agent/src/whapiInbound.ts`). No id, number or
name is logged, and nothing acts on typing.

Group typing is built only if the logs show the payload names the group.
Tests: `whapiPresence.test.ts` ("is described, not acted on, and never logs an
id", "asks once a day, and 409 counts as watching").
