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

## A calendar clash goes to the calendar's own person

Decided by the owner, 2026-11-27 (option B: "the check-in reads the full calendar, but details go only to the
calendar's owner"). A group reads a calendar shared with it only as free or busy
([asker-reach](./asker-reach.md)), so when a check-in sees a busy time that may clash with what the chat plans, it
asks the calendar's own person alone: `text_privately` with `to`, their handle. The gateway takes only a handle whose
calendar is shared with the chat (`calendarAside`), and the Worker texts them only while that handle is one of the
chat's people now, resolved from the chat's own list (`phoneOf`), never a number the gateway names. A handle nobody
here has reaches no one, never the sender in its place. Their own Tex is told the clash as data
(`calendar_check_from_group`), reads their whole calendar there, and answers them.

## Any follow-up, both ways (Dev2, 2026-11-27)

In a group, Tex offered someone a summary of their own reflection notes "on your own", they said "yea you can text me
1:1", and nothing came: `text_privately` was described only for asking for a card, an ID or a code, the group was told
it can't text anyone outside the chat, and the tagger's 1:1 run had no `ask_chat`, because a run another chat started
asked nobody. Dev2: "a two way loop indeed, I like the idea of tex being able to decide on its own at what moments it
should message you 1:1".

So `text_privately` takes any follow-up that is the tagger's alone: something sensitive to ask for, or something of
theirs to give or go over (their own notes, a summary, a draft, a question to check first). Their own Tex gets it as
data (`follow_up_from_group`), never scripted words, does it with everything it reads there, and may post back to
that one group what they choose to share: a follow-up run's `ask_chat` names only the group it came from
(`crossChat.js` `backTo`). When to move something 1:1 is the model's call, taught by the Lab module `rules`
("A group and their own chat"). Still only the tagger is texted. A guest with no account has no 1:1 of Tex's to run
in (`takeCrossAside` finds no chat), so the existing account-first line stays until Dev2 decides otherwise.

## What a simplification would cost

Letting `to` name anyone, or falling back to the sender when the handle is not in the chat, lets a group's turn text
a stranger's 1:1 or the wrong person (`privateAside.test.mjs` "a calendar clash goes to the calendar's own person
only", `privateAsides.test.ts` "a calendar clash goes to the calendar's own person").


Handing the vault link back to the model lets it paste the link and the steps into the group. Letting the gateway
name who is texted lets a turn text anyone's 1:1. Wrapping the vault watch outside the private links leaves a save
that never carries the group on. `apps/mcp/test/privateAside.test.mjs`,
`packages/tex/worker/privateAsides.test.ts` and the replay case `group-login-on-the-side` fail if any of these is
reversed.

## Not yet

A background job's turn in a group still says a vault link in its report. Only a chat's own turns, routines
included, send it on the side.

## A tapback in the group, and guests sign up first (Dev2, 2026-11-28)

Asked why group Tex texted "Texting you now" instead of a tapback, Dev2 agreed the group gets a tapback: a literal @Tex
tag is still answered in words, unless that turn already followed up with the tagger in their own chat
(`privateAside.js` `followedUpWith`, the Tapback node's `followedUp`). A calendar owner's aside does not count: it is
not the tagger's. A sensitive ask (a login, a card) keeps its short line, as Dev2 chose on 2026-11-25.

"The 1:1 shouldn't work with someone who is a guest. If someone asks for a 1:1 chat it should prompt them to sign up
for an account": a guest's `text_privately` keeps no aside and answers facts (`has_account: false`, `to_sign_up`),
and Tex tells them in its own words. The Lab runs `text_privately` for real, so a test chat shows this answer.
Replay case: `group-login-on-the-side`.
