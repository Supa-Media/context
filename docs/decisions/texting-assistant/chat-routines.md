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
  threaded and never acknowledged with a tapback.
  Whatever stops it is reported as an outcome code and the chat hears nothing.
- **Its skip is a decision, never a text** (2026-11-17, after a WhatsApp
  group's check-in with no new mail posted its reasoning and the word `SKIP`
  at 23:00 UTC). Until then these turns were the last ones still asked to
  answer "exactly SKIP", and only a bare `SKIP` was read as silence, so a
  skip that explained itself was a text like any other. Three layers now,
  each tested on its own:
  1. The turn is asked for the `say_nothing` call, never a word
     (`packages/shared/src/groupRunQuestions.cjs`).
  2. The gateway decides a scheduled turn's answer in code: one that is the
     quiet word, or opens or closes with it, becomes the same structured
     nothing a `say_nothing` call is, no words and `quiet: true`
     (`apps/mcp/src/agent/scheduledQuiet.js`).
  3. The Worker's last guard wraps every line's `sendText`, 1:1 and group,
     on every app (`apps/agent/src/outboundGuard.ts`): a skip or quiet
     decision, a bare control word, or words that end in `SKIP` as a token of
     their own are dropped, and the drop is logged without the words. A text
     that only uses the word in a sentence goes.

  **What a simplification would cost:** dropping layer 2 or 3 because layer 1
  "fixed the prompt" puts the chat one model slip away from reading Tex's
  reasoning again; `test/replay/cases/scheduled-skip-never-texted.mjs`,
  `test/scheduledQuiet.test.mjs` and `apps/agent/src/outboundGuard.test.ts`
  fail when either goes. The guard's known price: an answer whose very last
  word is `SKIP` in capitals is dropped too.
- `send:` and `to:` are ignored: a chat routine answers in its chat.
- `wake: new mail` also runs one soon after new mail reaches a mailbox shared with its chat ([chat-mail](./chat-mail.md)).

**What a simplification would cost:** running a shared workspace's routine
that names no chat, or texting a phone instead of the chat, puts back the
2026-10-18 failure; handing the run a grant of its own skips the chat's live
membership check, so somebody who joined the chat could be told what the
workspace's members wrote. `apps/convex/__tests__/routinesChat.test.ts`,
`apps/agent/src/groupRoutines.test.ts` and
`apps/mcp/test/agentGroupRoutines.test.mjs` fail if any is reversed.

## In the chat's home (decided by the owner, 2026-11-02)

"We have to be able to see it in order to ... see what routines or reminders
it's doing." A chat with a home keeps its routines in it:
`tex/groups/<words>/routines/<how-often>/<name>.md` in `@context-lc`, the
same shape as a person's `tex/routines/`. The seal hides a home from every
role in the pin, its owners included, so the scan reads a home's routine rows
and front matter straight from the tree, times and nothing else
(`apps/convex/functions/lib/routines/homes.ts`). Three things differ from a
routine in a bound workspace:

- The chat is the home's (`textGroups.homeWords`), whatever a `chat:` line
  says, so none is needed.
- The writer must be one of the home's people (`homeUsers`), never a role in
  the pin. The home's door reports a write there only for paths inside its own
  home (`apps/mcp/src/agent/chatHomeSeal.js`), and the control plane keeps the
  writer only if they are in the chat at that moment.
- A home's notes never leave it, so asking to stop one sets `paused: yes`
  instead of archiving it.

The run is still a chat routine's: it runs as its writer's tag, with no grant
of its own. It passes with `no_chat` when the chat is muted or a guest chat,
or when its writer has left. A routine already in a bound workspace, tagged
`chat:`, keeps running where it is.

**What a simplification would cost:** taking the writer from a pin role would
let nobody's routine run, because no chat person has one, or would let a pin
owner's run. Trusting a note's `chat:` would let one home answer into another
chat. `apps/convex/__tests__/homeRoutines.test.ts`,
`apps/mcp/test/homeRoutines.test.mjs` and `apps/agent/src/groupRoutines.test.ts`
fail if any of these is reversed.
