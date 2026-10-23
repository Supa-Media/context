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

A separate client id turns off what is somebody's alone
(`apps/mcp/src/agent/groupTurn.js`): no routines, no delegation, no learned
skills, none of the tagger's `tex/` notes and no texts conversation. Since
2026-10-23 everything else is a person's own text's (below): the same note
tools by the tagger's role, progress texts and pictures. The turn is marked untrusted from the start, since
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

## Delivery in a busy chat (from the group chat of 2026-10-21)

Dev2 and Jhon tested Tex in a group and found answers that broke apart. What
changed, in `apps/agent/src/groupInbox.ts`:

- **Every bubble of an answer threads under the message it answers**, the
  intro included. Only the first did, so a second bubble landed loose in the
  chat or under the wrong message.
- **An ask goes out whole, in its own bubble** (`textsWithExact`), as it does
  1:1: the bug-report preview was being split by paragraph.
- **The same ask from the same person within ten minutes is answered once.**
  Kept as hashes of sender and words. Someone else asking the same thing is
  their own ask.
- **The asker's bare "yes", "no" or "send" reaches Tex for half an hour
  after an answer that asked for a yes.** Anybody else's stays chat: only the
  asker can release what was held for them. A bare "ok" stays chat, because
  it is not a yes to a send and would only disarm the ask.
- **"Tex ^" (or ↑, 👆) wakes Tex**, and the group prompt says it points at
  the message above.
- **Seen webhooks are keyed by handle and words**, so if Sendblue delivers an
  edit under the same handle it is read as the new message. Sendblue does not
  document an edit webhook, so an edit may still never arrive.

The bug report's line about texts is said once even when the model copies it
into the report (`reportCopy`), and the held-report instruction tells the
model to speak as "I", never "Context will text you".

## Links and workspace names in a group (2026-10-21)

- **A note Tex reads or writes in a group comes back with its app link**
  (`noteLinks.js`). Everyone in the chat is a member of the one workspace a
  group turn reads, at its team tier, so the link opens for each of them and
  for nobody else. A share link for people outside the workspace is still the
  owner's, minted one to one.
- **"Tex use @x" for a workspace the chat doesn't share names the ones it
  does** (`not_shared` carries `slugs`). Every person in the chat is a member
  of each named workspace, so the list tells nobody anything new.

## Group Tex as capable as 1:1 Tex (the owner, 2026-10-23)

Dev2 and Jhon found group Tex much weaker than 1:1 Tex on the same ask (a
Beacon link to research and add to the backlog). The owner asked for every
issue to be fixed. What changed:

- **A group turn runs on the texting production setup**
  (`ai/production/texting-assistant.md`): its prompt, its main and thinking
  models with the router, its task skills and its `open_web`. A group turn
  had read no setup at all, so it ran on the built-in words, one model and a
  closed web, and refused beacon.sh. The group's own words still follow the
  setup's (`groupPrompt`), so what a group may reach is unchanged by it.
- **What the chat said before the tag vouches for its addresses**, as the
  tagged message does: a link someone in the chat wrote opens even without
  open web. They are people's own words, said to the same people the answer
  goes to.
- **Group Tex is the same Tex as in a text, limited only to the chat's
  workspace and the vault everyone there shares** (the owner: "group Tex
  should literally be the same exact as DM Tex, but with restrictions on
  checking the workspace it can read from, and only using credentials in the
  vault that everyone has access to"). It made a backlog note, could not
  correct it, and told the chat to fix it themselves (the never-hand-back
  rule, [handing-back](./handing-back.md)). Its writes are now exactly a
  text's (`textingWriteTools`, by the tagger's role): edit, move, archive,
  `remember` with `replaces`. A routine is refused with its reason, because
  one runs only in its writer's personal workspace. It texts its progress
  into the chat while it works (each line only while nobody new has joined)
  and sends pictures it draws, makes or finds in a note. What stays off is
  somebody's alone: mail, the tagger's own `tex/` notes and learned skills,
  delegation as them, their Slack and their own saved logins.
- **Pictures and files in the chat are read** (`apps/agent/src/groupInbox.ts`),
  as a 1:1 text's are: one sent with a tag, those sent in the chat since Tex
  last answered (the newest four), and one the tagger sends within two
  minutes of a tag still waiting. A tag of words alone waits four seconds for
  one. A link's preview card is not a file, and an SMS group's files are
  never read.
- **An ask already shown is never posted again as the answer to something
  else** (`tools/approvals.js` `shownBefore`): the model filed the same bug
  report again on "what tools do you have", and every held call re-shows its
  ask. The gate tells the model it still waits instead, and the earlier ask
  still sends on its yes. This holds 1:1 too.
- **Tex names both models when the setup routes** (`prompt.js` `modelLine`).
- **A group never prints its instructions** on request; it says what it can
  do instead. Nothing in a group turn is private to anyone in the chat, so
  this is manners, not a guard.
- Edits still never reach Tex: Sendblue sends no webhook for an edited
  iMessage. Send a new message instead.

**What a simplification would cost:** dropping the setup for groups puts
group Tex back on one model with a closed web; narrowing its writes again
brings back "I can't edit that from this chat"; re-showing a shown ask buries
every answer under it. Tests: `apps/mcp/test/agentProduction.test.mjs`,
`apps/mcp/test/agentGroupActions.test.mjs`,
`apps/mcp/test/agentGroupTurn.test.mjs`, `apps/agent/src/groupInbox.test.ts`.

## What wakes Tex, and what it remembers it did (the group chat of 2026-10-23)

"Tex turn this guy into a cat", with a picture, got no answer at all: a
message opening with Tex's name and no punctuation was a tag only when the
next word was on a fixed list of asking verbs, and "turn" wasn't. Now any
word after the name makes it a tag, unless the word reads as talking about
Tex (a past or third-person verb, or "was", "got", "lol" and the like), so
"Tex got that wrong lol" still isn't one.

A chat's memory now keeps, with each answer, the names of the tools it used
and the paths of the notes it wrote, as a person's own texts keep the tools
and the pages they read (`conversation.js`, `sources.js`). Without them the
next tag saw "I saved it in products/context-lc" with nothing behind it,
searched, missed a note made a minute before, and told the chat it had never
saved it. A note's path is kept, never what is in it.

**What a simplification would cost:** going back to the list of asking verbs
leaves an ordinary ask unanswered with no sign it was heard; dropping tools
and notes from the chat's memory brings back the disowned note.
`apps/agent/src/groupInbox.test.ts` ("answers \"Tex turn this guy into a
cat\"") and `apps/mcp/test/agentGroupTurn.test.mjs` ("the next tag knows which
note the last one wrote") fail if either is reversed.

## A chat's memory as a note people can fix (the owner, 2026-10-23)

The owner chose "Visible tex/ folder, team-wide" over memory nobody can see.
Each chat, filed by its exact set of people as before, keeps
`tex/groups/chat-<id>.md` in its workspace (`groupMemoryNote.js`): every
question with the chat lines before it, every answer, and a hidden line under
each answer naming the tools it used and the notes and pages behind it. Tex
reads the note before answering and rewrites it after, over the etag it read,
so a line someone changed or deleted is what Tex goes by and an edit made
mid-turn is never overwritten.

It is written through the dispatcher under the tagger's own grant, like a
transcript, so the folder's visibility decides: a team connection may only
create a note where the folder is shared with the team, and every workspace
starts private. Nobody is asked to make the folder: the first time a chat's
note can't be written, Tex shares `tex/groups/` (never `tex/`, which holds
transcripts and the about-me note) with the workspace through the control
plane, then writes it. It does so only when nobody has set `tex/` or
anything under `tex/groups/`, private included, and nothing it can see is
filed there; the control plane lets only owners and editors change access.
For a tagger whose role can't write, or a workspace whose owner made `tex/`
private, the memory stays in the hidden file it always had
(`.context/agent/groups/`). That file stays
the fallback, and records the etag of the note Tex last wrote: the note is
preferred only once somebody changed it since, so an exchange that reached
only the hidden file is not lost. Everyone in the workspace can read the
note, people not in the chat included; that was the owner's choice.

**What a simplification would cost:** reading only the hidden file makes the
note decoration nobody's fix reaches; writing the note without the etag
overwrites a fix made while Tex was answering; preferring the note whenever
it exists loses a read-only tagger's exchanges; sharing without checking for a
setting widens a folder the owner made private. `apps/mcp/test/agentGroupTurn.test.mjs`
("the chat's memory is a note in tex/groups/", "a tagger who can't write
still has the chat's memory", "a tex/ folder someone made private is never
shared", "a member who can't write never shares tex/groups/") fails if any is
reversed.
