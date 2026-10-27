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

The audit records `mail.shared_with_chat` and `mail.unshared_from_chat` in the
shared workspace, naming the person and the group client, never the address
or the search.

## What a simplification would cost

Letting anyone in the chat share, or reading a mailbox through the binder's
grant, puts one person's mail in front of people they never chose. Dropping
the per-message re-check lets a turn read any message by id once it knows
one, whatever the share was narrowed to.
