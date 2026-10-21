# Tex in a group chat answers from the one shared workspace everyone in it is a member of (2026-10-20)

The owner asked for Tex in iMessage group chats, like Claude in Slack, but
"only access to workspaces that all the users in the chat have access to".
This is how that is built, and the decisions the owner made on the way.

## Who Tex answers, and from where

Tex answers in a group only when it is addressed: its name ("Tex" or
"Context") opening or closing the message, its name in a question, or an
inline reply to one of Tex's own texts in that group that says more than
thanks. The test reads only the words, with no model
(`apps/agent/src/groupInbox.ts`). It never chimes in on its own.

Each tagged message is resolved again by the control plane
(`POST /agent-texts/group`, `apps/convex/functions/textGroups.ts`):

- Everyone in the chat except the line the message came in on must be a phone
  linked to an account, with texting not paused. The list is the webhook's
  and Sendblue's members read together, so more people can only narrow it.
  One person who isn't on Context means no notes in that chat.
- The chat is bound to **one shared workspace** every one of them is a
  member of. A personal workspace never counts: it carries its owner's mail,
  calendar, vault and Tex's own notes about them.
- When they share several, Tex asks which one, and "Tex, use @slug" binds or
  switches it (the owner, 2026-10-20: "if the people in the group share
  multiple workspaces, just make tex have them pick a workspace"). While that
  question is open, the name alone ("supa") picks it, and quotes typed around
  a command are ignored (first live test, 2026-10-21). The line that answers a
  pick carries Tex's introduction, so the next answer doesn't repeat it. The
  binding drops by itself when someone joins who isn't a member.
- The turn's grant (`context_texts_group`) reaches only that workspace, at
  the `team` tier with no private scope and no granted names, so a note held
  back from the whole team is absent. It resolves only while every person in
  the chat is still a member, nobody has paused texting and the chat isn't
  muted (`liveGrants.ts`), so removing someone from the workspace stops the
  next tool call. The tagger's role decides writes; the turn is metered on
  the tagger's personal workspace; audit records the tagger.

## Tex follows the whole chat (the owner, 2026-10-21)

The first live group wanted Tex like Claude in Slack: "less of adding input
and more so, hey take all the context from this chat and go do something",
"like if we are discussing when to meet, and at the end I say @Tex go
schedule this". The owner then chose the whole chat over a short buffer
("Why can't we give it the entire history like a regular chat"), kept the
way a person's own texts are. This replaces the first version's rule that an
untagged message is never stored.

- While a chat is bound to a shared workspace and not muted, an untagged
  message is kept in the group's queue object (`apps/agent/src/groupChat.ts`),
  with who sent it and a hash of who was in the chat. Nothing is kept in a
  chat that isn't bound, an SMS group, a muted one, or once anyone has joined
  or left since Tex last answered, until a tag resolves the chat again.
- The next tagged message hands the gateway the lines said before it, in front
  of exactly the people it answers, by handle and never by number (the
  control plane names them). The gateway files them with the question in the
  chat's memory in the bound workspace, and the queue's copy is deleted. A
  line nobody tags Tex after is dropped after a week, the oldest go first past
  four hundred, and "Tex, stop", a mute or the chat losing its shared
  workspace drops them all.
- The memory is bounded like a person's texts (`conversation.js`, 300 turns
  and 120,000 characters); a turn is shown up to 80,000 and reads the rest
  with `earlier_chat`. Nothing is summarized: the person's texts aren't
  either.
- The chat's words reach the model marked as people talking to each other,
  never as instructions, and the turn is untrusted from the start, as before.
- Tex's introduction says it follows the chat and keeps it in the workspace.

## The lookup risk is accepted (the owner, 2026-10-20)

Adding Tex and a phone number to a group tells the adder, by whether Tex
answers with notes, that the number is linked to Context and shares a
workspace with them. The owner chose "No, accept the lookup risk" over a
per-person opt-in. This is a deliberate exception to "one tenant must not
infer the existence of another" (non-negotiable #4), bounded to people who
already share a workspace with the adder: a stranger's number only ever
yields "not everyone here shares a workspace with me", the same line as an
unlinked one, and an unknown tagger is told one fixed line once per chat,
with the same tapback as everyone.

## What a group turn can do

A separate client id turns every per-person ability off by default
(`apps/mcp/src/agent/groupTurn.js`): no routines, no delegation, no progress
texts, no pictures, no learned skills, none of the tagger's `tex/` notes and
no texts conversation. Writes are create and append only: `write_note` takes
only a path and content and refuses a path where anything is, and `remember`
never takes `replaces`. The turn is marked untrusted from the start, since
other people's words are in its history.

## Tex acts for whoever tagged it (the owner, 2026-10-21)

"Yeah calendar is necessary", "email too, write only not read", and
"computer use as well". A group turn can:

- **Send one email from the tagger's own Gmail, or add, move or cancel one
  event on their own calendar.** The control plane reaches the tagger's own
  personal-workspace Google connection from a group grant whatever their
  role in the shared workspace, and only for the chat's own workspace and
  only while the chat still resolves (muted, someone left, a stranger added
  all stop it): `apps/convex/functions/lib/controlPlane/ownAccount.ts`. The
  gateway exempts exactly `send_email` and `calendar_event` from the
  dispatcher's write-scope check, because the change is to the tagger's
  account, not the workspace. Each is held for the tagger's yes to the exact
  copy shown in the chat, as in a 1:1 text, and the ask says "Reply yes to
  this", because an untagged "yes" in a group is chat. Pending approvals are
  listed by the acting person, so somebody else in the chat saying "Tex,
  yes" releases nothing. A yes is settled before any model, as in 1:1, and
  kept in the chat's memory.
- **Never read mail.** `claimPersonMailRead` needs an owner of the personal
  workspace with `context:private`; a group grant is neither.
- **Never invite.** Calendar writes refuse guests and send no updates, so
  the prompt says to email the details or have each person ask.
- **Use the web with a browser that holds nobody's sign-ins**
  (`apps/mcp/src/agent/turnWeb.js`): no browser tag carried between turns
  and no sign-ins kept between browsers, because anyone in the chat steers
  what the browser does.
- **Sign in and use keys only with what the workspace itself holds** (the
  owner, 2026-10-21: "people can give Tex its own email ... but not through
  the individual saved logins, since we don't want anyone steering someone's
  personal information", and "same for cards ... they have to add cards
  specifically shared for that workspace"). A group turn's `fill_login`,
  vault listing and keyed requests open the chat's shared workspace's vault
  and count a key there only when it is given to the whole workspace (`*`):
  never one the tagger saved, nor one given to them by name, handle or
  group, and never at "see" (`apps/mcp/src/vault/access.js`
  `actorAccessOf`). A person who wants Tex to act for the group gives it a
  login of its own, such as a shared email, saved in the workspace for
  everyone. A card is an entry like any other and follows the same rule;
  each payment is still the tagger's own yes, replied to Tex's ask
  ([vault](./vault.md), "A card pays only on the person's yes, each time").

A simplification that reached the tagger's account through their role in
the shared workspace would leave a member unable to send as themselves and
an editor able to; one that dropped the actor filter would let any person
in the chat approve another's email; one that read a group's vault access
as the tagger's would let anyone in the chat sign in as them. `apps/convex/__tests__/textGroupsOwnAccount.test.ts`
`apps/mcp/test/agentGroupActions.test.mjs` and
`apps/mcp/test/vaultGroupChat.test.mjs` fail if any is reversed.

## Memory lives in the shared workspace

The owner asked for group memory "inside the shared workspaces", in a `tex/`
folder like heartbeat. Naming people on a note is owner only, and the
group grant's `team` tier would hide a note shared by name, so the first
version keeps each chat's memory as plumbing in the bound workspace,
`.context/agent/groups/<hash>.json`, filed by the chat and the exact set of
people in it: somebody added later starts a new memory and is never
replayed what was said before they joined, untagged lines included. A visible `tex/groups/` note the
people in the chat can read and correct is the follow-up.

## What Sendblue gives and doesn't

Group messages carry `group_id` and `participants` on the receive webhook;
answers go through `POST /api/send-group-message` with `from_number`
(required) and `reply_to`; members are read from `GET /api/v2/groups/{id}`,
whose fields are undocumented, so any phone number in the answer counts.
Typing bubbles and read receipts are 1:1 only. Tex can't leave a group, so
"Tex, stop" mutes it and "Tex, start" brings it back, for anyone in the chat.
A green-bubble (SMS) group gets one fixed line and never notes. When the
members read fails, the webhook's own list is used and the failure is
logged. An answer is not sent if the members read after the turn shows
someone new.

**What a simplification would cost:** handing a turn every kept line, rather
than those said in front of the same people, replays to a newcomer what was
said before they joined. A group turn on the tagger's ordinary
texting grant reads their personal workspace, mail and vault into a room of
other people. A workspace set computed once at join time, rather than per
message and per tool call, keeps answering after someone is removed. Tests:
`apps/convex/__tests__/textGroups.test.ts`,
`apps/mcp/test/agentGroupTurn.test.mjs`, `apps/agent/src/groupInbox.test.ts`.
