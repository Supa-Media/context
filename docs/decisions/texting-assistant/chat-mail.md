# A mailbox shared with one group chat

Decided by the owner on 2026-10-27, for the Crystal Care family chat: the
family business runs on a work Gmail that Google Groups fan into, and the
family wants Tex in their chat to see that mail, say what needs doing, and
draft replies. Until now a group turn read nobody's mail
([groups](./groups.md): "never read mail").

## What changed

The mailbox's own person shares it, in the chat, in their own words:

- "Tex, share my mail from me@work.example here", optionally followed by
  "matching <a Gmail search>" (for example `to:clients@work.example`) to
  narrow what the chat sees.
- "Tex, stop sharing my mail" ends it.

Both are fixed commands (`apps/agent/src/groupWords.ts`), answered by the
control plane with no model (`textGroups.applyGroupTurn`,
`functions/lib/textGroupMail.ts`).

## The rules, and the test that fails if each is dropped

- **Only its own person shares it**, only a Gmail connected to their own
  personal workspace, and only into a chat bound to a shared workspace where
  they are an owner or editor. Never a guest chat, never a personal
  workspace's chat. Each refusal reads the same ("mail_refused").
  `apps/convex/__tests__/textGroupMail.test.ts`: "only the mailbox's own
  person", "never into a chat on a personal workspace".
- **Read live, narrowed, kept nowhere.** Each search is sent to Gmail as
  `(<share's search>) (<query>)`; a read opens a message only if the share's
  search, asked by that message's own Message-ID, still finds it. Nothing of
  a message is stored. "every search is narrowed", "a message outside the
  share is not found".
- **Asked again at every read.** The share counts only while the chat is
  bound to the same workspace and not muted, the sharer still writes there,
  and the Gmail is still connected. "losing edit, or disconnecting the Gmail,
  ends it".
- **Only the sharer stops it.** "stopping sharing ends the reads, and only
  the sharer can".
- **Each read counts against the sharer's own hourly mail reads**, the same
  limit their own reads use.
- **The turn is told whose mailbox it may read** (handle and address), and is
  offered `search_email`/`read_email` only then (`apps/mcp/src/agent/groupMail.js`,
  `apps/mcp/test/agentGroupMail.test.mjs`). Live mail is untrusted for
  egress as it is anywhere else.
- **Sending is unchanged**: an email from someone's own Gmail still goes only
  on their own yes in the chat. Sharing a mailbox to read is not a yes to
  send from it.

## The chat checks in on its own

The owner, 2026-10-27, after the first version asked for a routine: "shouldnt
it monitor the inbox I share, and heartbeats and stuff just as dm Tex would
do, I dont want to have to setup anything special for the group, it should
just work, and know when an email needs to go to the group vs me personally."

So a bound chat has its own check-in, as a person's Tex does, and sharing a
mailbox is the whole mail setup (`functions/lib/textGroupLooks.ts`):

- **A few times a day.** A chat bound to a shared workspace looks at the
  person check-in's slots (10:00, 14:00, 18:00 in its binder's time zone). A
  turn in the chat arms it, and the daily arming of check-ins arms every
  bound chat that has none, so nobody sets anything up. The look reads the
  workspace's recent activity and the mail shared there.
- **New mail brings it forward.** A Gmail notification for a shared mailbox
  makes the look due a minute later, never sooner than five minutes after
  the last, so a burst is one look.
- **One look per chat, on its own row** (`textGroups.nextLookAt`), run as
  its binder tagging Tex in the chat (or the earliest person sharing mail,
  if nobody bound it): the ordinary chat turn, re-checking who is in the
  chat, the workspace it is bound to and the live shares. The cron hands it
  out beside routines as a chat run with no note behind it, and sets the
  next slot at once. A chat that can no longer hear it (muted, unbound, a
  guest chat, its looker gone) drops it until its next turn.
- **Not for a chat nobody reads.** A chat that chose to be quiet, or where
  nobody has talked to Tex for fourteen days, looks only when mail is shared
  with it: an unprompted look is a model turn, and a post nobody asked for.
  A look's or routine's own turn is not somebody talking (the Worker marks
  it `routine`), so looking never keeps a silent chat looking.
- **Group or personal.** The look posts only what someone in the chat needs
  for the shared work, and leaves out mail that concerns only the mailbox's
  owner (`chatLookQuestion`, `apps/agent/src/groupRoutines.ts`). The owner's
  own check-in is told, per email, which group chats also watch that mailbox
  (`watchedIn` on the person's own mail read, `newMail.js`), and texts about
  such mail only when it needs them personally rather than the group.
- A chat routine may still say `wake: new mail` to run on new mail too
  ([chat-routines](./chat-routines.md)); nobody needs one.

`textGroupMail.test.ts` "the chat checks in on its own" fails if the arming
(on a turn or daily), the next slot at claim, the wake, the result, the
lease, the live-chat check, the gap, the quiet or dormant drop, or
`watchedIn` is dropped; `agentGroupMail.test.mjs` covers the check-in's marks.

The audit records `mail.shared_with_chat` and `mail.unshared_from_chat` in the
shared workspace, naming the person and the group client, never the address
or the search.

## What a simplification would cost

Letting anyone in the chat share, or reading a mailbox through the binder's
grant, puts one person's mail in front of people they never chose. Dropping
the per-message re-check lets a turn read any message by id once it knows
one, whatever the share was narrowed to.
