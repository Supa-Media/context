# A group chat sets routines that answer in the chat (2026-10-27)

The owner runs a family business in one iMessage chat with Tex in it, bound
to the business's shared workspace, and wants routines there: a morning post
of who is on shift, a weekly nudge about timesheets. Routines ran only in a
personal workspace and texted only their writer
([routines](../routines.md), 2026-10-18), because a shared workspace's routine
texted one person what another had asked for. A chat routine keeps that rule's
point: it speaks only where everyone it concerns reads it. Chosen with the rest
of the owner's defaults on 2026-10-27.

## How it works

- **A routine in a shared workspace runs only when it names a chat.** Its
  front matter carries `chat: <16 hex>`, the start of the chat's key
  (`chatRoutineId`, `packages/shared/src/routines.cjs`). Any other routine
  there still never runs (`runsRoutine`, `functions/lib/routines/access.ts`).
  A personal workspace's routine ignores `chat:`.
- **It is set from the chat.** A group turn may write a routine only with this
  chat's id in it (`chatRoutineRefusal`, `apps/mcp/src/agent/groupRoutines.js`);
  a guest chat sets none, nor does an invited person with no account, whose
  turn runs on the binder's grant.
- **When it is due, the control plane asks again** (`functions/lib/routines/chats.ts`):
  the chat must reach the routine's own workspace now, not muted, not in
  guest mode, and its writer must still write there and have a phone. Else
  the slot passes with `no_chat`. The run names the chat's key and the
  writer's phone, and carries **no grant**.
- **It runs as the writer's tag in that chat.** The texting Worker finds the
  chat by its key (a `group-key:<key>` object, told where the chat is by the
  chat's own object; the control plane keeps only the hash) and queues a turn
  there, in words only the Worker writes. That turn is checked like any tag:
  the writer must be in the chat by Sendblue's own list, the control plane
  resolves who is in it and mints the chat's grant at team tier, and the
  answer goes only if nobody joined meanwhile (`groupInbox.ts`). It is never
  threaded, never acknowledged with a tapback, and a lone `SKIP` says nothing.
  Whatever stops it is reported as an outcome code and the chat hears nothing.
- `send:` and `to:` are ignored: a chat routine answers in its chat.
- `wake: new mail` also runs one soon after new mail reaches a mailbox shared with its chat ([chat-mail](./chat-mail.md)).

**What a simplification would cost:** running a shared workspace's routine
that names no chat, or texting a phone instead of the chat, puts back the
2026-10-18 failure; handing the run a grant of its own skips the chat's live
membership check, so somebody who joined the chat could be told what the
workspace's members wrote. `apps/convex/__tests__/routinesChat.test.ts`,
`apps/agent/src/groupRoutines.test.ts` and
`apps/mcp/test/agentGroupRoutines.test.mjs` fail if any is reversed.
