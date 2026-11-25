# A group chat's sensitive asks go to the asker's own chat (2026-11-25)

Asked in a group to order with a site's login, Tex sent the private vault link and the steps to save it into the
group. The owner (Dev2, 2026-11-25), on what should happen instead: "Tex being - sure thing, and then texting the
person who asked on the side if it didn't have the login on their vault", and then: "It's not just logins but
anything that requires a user to enter sensitive information. steps for that shouldn't be stated in the groupchat -
it should be handled in 1:1. anything along the lines of tex mentioning that it will text the user for details is
good." Someone who isn't on Context is told to create an account first.

## How it works

- **Every group is told** (`GROUP_SENSITIVE_LINE`, `groupSignIns.js`): a password, card, ID, account number or
  one-time code is asked for in the asker's own chat, never in the group; in the group Tex says only that it will
  text them.
- **A vault link never reaches the group's model.** In a group chat turn, `vault_add_link` and `vault_view_link` run
  inside `withPrivateLinks` (`privateAside.js`). The link's words are kept as an aside for the tagger, and the model
  is told only that the link went to them. The vault watch runs inside that wrapper, so it still hashes the link and
  the save wakes the group, which carries the task on by itself ([vault](./vault.md)).
- **`send text_privately`** asks the tagger for anything else sensitive. A one-time code they reply with in their
  1:1 is passed back to the group with `send ask_chat, do true` ([cross-chat-asks](./cross-chat-asks.md)), and the
  group's Tex types it into the chat's browser.
- **The Worker texts only the message's sender.** The answer's `asides` start a run in the tagger's own 1:1
  (`/cross-aside`, `packages/tex/worker/crossChat.ts`). It is a cross-chat answer with state `aside`, so the run
  texts them with the link exactly as Context wrote it. The gateway never names a recipient. A tagger who never
  texted Tex on their own gets a fixed line in the group ("Text me on your own first ..."), and is never asked there.
- **A guest is refused, by code** (`canAside`): no link is made, and Tex tells them in one line to text it on their
  own to set up an account first.

## What a simplification would cost

Handing the vault link back to the model lets it paste the link and the steps into the group. Letting the gateway
name who is texted lets a turn text anyone's 1:1. Wrapping the vault watch outside the private links leaves a save
that never carries the group on. `apps/mcp/test/privateAside.test.mjs`,
`packages/tex/worker/privateAsides.test.ts` and the replay case `group-login-on-the-side` fail if any of these is
reversed.

## Not yet

A background job's turn in a group still says a vault link in its report. Only a chat's own turns, routines
included, send it on the side.
