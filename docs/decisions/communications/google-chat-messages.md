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
  They ride on the **Gmail** connect as tester-only write scopes, beside
  `gmail.send` (`TESTER_WRITE_SCOPES`), so one reconnect of the Google
  account a person already uses adds Chat. They work only on a Google
  Workspace account. Widening them past testers waits for Google's review,
  as email does.
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
