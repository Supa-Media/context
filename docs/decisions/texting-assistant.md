# The texting assistant

_See `docs/decisions/README.md` for the index. The product ask is the Supa Media
workspace's `1-projects/backlog/context-agent/overview.md` (2026-10-06): an
assistant people text over iMessage, with their Context as its memory, living
in this monorepo as its own app (`apps/agent`), multi-tenant, on Convex and
Workers._

### The Worker decides nothing about access

`apps/agent` proves that a webhook came from Linq and then asks the control
plane for a short-lived grant belonging to whoever linked the sending phone.
The gateway's `/agent` route answers with that grant, so the person's scope
clamp, privacy engine and audit identity apply exactly as they do for any
connected client. A second authority decision inside this Worker would be the
one that drifts, which is the same reason `/agent` is a gateway route and not a
service of its own.

**What a simplification would cost:** a Worker that reads the bucket itself, or
holds a long-lived token, becomes a second gateway with none of its tests.

### A webhook is acted on only with Linq's signature

Every request to `/linq` is checked against the subscription's `whsec_` secret
(Standard Webhooks: HMAC-SHA256 over `id.timestamp.body`, 300 seconds of
tolerance) before its body is parsed. A deployment with no secret refuses
everything instead of accepting unsigned calls. Tests: `signature.test.ts`,
`worker.test.ts`.

### Group chats never reach a personal context

A group's messages come from several people. Answering one of them from a
personal context would read that person's notes into a room other people are
in. Groups are dropped until shared workspaces have a group design of their
own. Test: `inbound.test.ts`, "ignores group chats".

### Only iMessage is answered, because the sender number is the login

The sending phone number is all that identifies a person here. Apple
authenticates an iMessage sender. An SMS sender number can be spoofed, and a
spoofed number would be answered with somebody else's notes. So a message must
name its service as `iMessage`, and one naming no service is refused. Linq's docs
don't show where `service` sits on an inbound event, so the parser reads every
plausible place. **Before deploying, confirm the real location from a live
delivery and narrow the parser to it.** Test: `inbound.test.ts`, "refuses SMS
and RCS".

### The Worker holds message text only while it is answering it

Linq wants a quick 2xx and retries anything else, while an answer can take a
minute. So each sender has a Durable Object queue that holds a message, and
once computed its reply, only until the reply is sent or given up on (three
attempts). Deduplication keeps webhook ids and timestamps, never text, for a
day. Conversation history is not kept in the Worker. The gateway keeps it in
the person's own bucket, which follows non-negotiable #1. Test:
`inbox.test.ts`, "keeps no text afterwards".

### OPEN: messages pass through Linq

Linq is a third party that carries every message in both directions. Nothing of
the bucket is stored there, but the text of a question and its answer is. This
is the same class of decision as a model provider reading note text in flight
([inference](./storage-and-credentials/inference.md)), and it needs the
owner's sign-off before the Worker is deployed.

### The autofill vault lives sealed in the person's bucket

Decided by the owner, 2026-10-06: the agent's saved passwords and cards live in
the person's own bucket, not in a database of ours. This is an explicit
exception to two rules, bounded as follows:

- Non-negotiable #1 says credentials never live in the bucket. Vault entries
  may, but only sealed, under Context-owned plumbing (`.context/vault/`), with
  the key held outside the bucket, so the bucket alone never yields a secret.
- The encryption decisions say no AI client reads an encrypted note. That still
  holds. A vault entry is decrypted only by the browser's fill step, at the
  moment it fills a form, and its plaintext is never put in a model's context,
  a tool result, a log or a message.

The vault is not built yet. When it is, the tests must prove both bounds: a
bucket read never yields plaintext, and no model request ever carries a vault
value.
