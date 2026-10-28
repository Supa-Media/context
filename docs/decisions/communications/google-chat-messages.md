# Google Chat messages

_Part of [Communications](../communications.md). See `docs/decisions/README.md` for the index._

### Tex sends a Google Chat message as the person, on their one 👍 (2026-10-22)

Decided by the owner on 2026-10-22, after Tex told them "Google Chat isn't
one of the apps I'm connected to, so I'd send it through my browser" ("why
isn't it connected??", then yes to adding Chat sending). Until then no
connect flow asked Google for any Chat scope that sends, and the Chat code
that existed only synced spaces in.

What is built:

- `google_chat` (v2 `send` action `google_chat`) sends one message as the
  person: a direct message to a person by their work email (`to`), or a post
  in a space by its name in Chat (`space`). `action: "spaces"` lists the
  spaces they are in, by name, and is never held.
- The scopes are `chat.messages.create`, `chat.spaces.readonly` (find the
  direct message or space) and `chat.spaces.create` (start a direct message
  that does not exist yet), all sensitive, none of them reading a message.
  They ride on the **Gmail** connect as write scopes asked of everyone,
  beside `gmail.send` (`WRITE_SCOPES`; the owner, 2026-10-23, "Yes,
  everyone"), so one reconnect of the Google account a person already uses
  adds Chat. They work only on a Google Workspace account.
- A message reaches another human, so it waits for the person's one yes or
  👍 to that exact message and place (the approval rule of 2026-10-22: a
  go-ahead only when something goes to another human). The gate
  (`googleChatGate.js`) asks the control plane first, spending nothing, so
  the place is shown by the name Chat gives it, never one the model chose,
  and an account without Chat is told how to reconnect instead of being
  asked. A yes or 👍 to Tex's own preview of exactly that message and place
  sends it without a second ask, as for an email. A routine or a dream
  never sends one.
- The control plane (`gatewayRoutes/googleChat.ts`) picks one of the token's
  person's own connections that granted all three scopes, holds 10 an hour
  and 40 a day, and keeps nothing of a message: the audit row says only
  whether it went to a person or a space.
- The deployment's Google Cloud project must have the Google Chat API turned
  on (and a Chat app configured, which Google asks for even for calls made
  as a user). Without it Google answers `SERVICE_DISABLED` or "Chat app not
  found", and Tex says it is Context's to fix, never the person's.

Not built: replies in a thread, reading a space's messages live, and group
chats sending as their tagger. The browser stays the fallback only when the
API refuses.

Reversing this sends Tex back to the browser for every Chat message. The
tests that fail are `googleChatGate.test.mjs` (the hold and the one yes) and
`googleChatSend.test.ts` (whose account, which scopes, which space, limits).

## Reading what was written to them, for check-ins (2026-10-23)

The owner asked for check-ins to look at Google Chat too, "but only say
something if you can muster together helpful actions/responses".
`POST /gateway/chat/recent` (`gatewayRoutes/googleChatRead.ts`) reads, live
and as the person, the few spaces most recently active since the last look
(at most eight, never further back than three days), and answers at most ten
messages: everything someone else wrote in a direct message or group chat,
and in a named space only a message that mentions them. Bots are left out.
Their own words never count, so a look cannot read back what Tex sent as
them.

**Who "them" is (2026-10-28).** The first version looked their Chat id up
with `spaces.members.get`, which Google's discovery document allows only
with a `chat.memberships` scope the connect never asks for, so Google would
refuse it and every look would find nothing (found by reading the code
against the discovery document, not measured in production). Now the person is matched by the address
Google's id token gave the connection: Chat's `User` fills `email` for a
message's sender and for mentioned users under user authentication, for
members of the space, and their canonical `users/{id}` is learned from any
message of theirs in the same look. A sender with neither a known id nor
an address could be them, so it is left out, never counted as someone else.
The Google account `sub` is not used as a Chat id: Chat documents its id as
the People API person id and the Directory user id, and says nothing of
`sub`. Adding the memberships scope instead was turned down: no new grant
for a lookup the messages already answer. The test that fails if a Chat
call needs a scope the connect does not ask for checks each one against a
copy of the discovery document's scopes.

- `chat.messages.readonly` is restricted, and rides on the Gmail connect
  like the send scopes: one reconnect grants both.
- `claimChatRead` (in `functions/googleChatSend.ts`) uses the same
  own-account clearance as a send, wants a connection that granted reading,
  and allows 30 reads an hour. Nothing of a message is stored or logged.
- Nothing is copied into notes; the check-in shows the messages to the model
  as a stranger's words and taints its saved exchange
  (`docs/decisions/texting-assistant/heartbeat.md`).

Tests: `googleChatRead.test.ts` (whose account, which scope, what counts as
written to them, limits), `apps/mcp/test/checkInSources.test.mjs`.
