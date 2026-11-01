# One conversation state per chat, and decide picks when and how Tex replies (2026-11-01)

Decided by Jhonatan (Dev2), 2026-11-01, after a week of fixing group chat bugs
one rule at a time: the rules lived in regex code, the decision model and the
answering model, and none knew the others. The research behind it (OpenAI
Realtime turn detection, LiveKit's turn detector and preemptive generation,
Pipecat's turn strategies, HUMA arXiv 2511.17315, When2Speak arXiv
2605.05626) says the same thing every production system does: a small model
predicts when to speak, inside hard caps, and the caps win.

## Decide returns three separate decisions

One decide call (`apps/convex/functions/lib/gatewayRoutes/textDecide.ts`),
asked of the small decision model through Jev:

- **Words:** answer, silent, or wait (a burst still being typed). A wait
  carries the seconds the model chose, 1 to 8 (`wait_seconds`, a score
  question).
- **Reaction:** a separate yes or no (`also_react`) with an emoji from the 64.
  It goes with any of the above: "react with 🎉 and answer", "react only",
  "wait and react". The reaction is sent at once, once per message, and then
  the turn adds no ack tapback of its own.
- **Mid-turn**, when Tex is already writing: fold, queue or restart (redraft).

## The state machine (`apps/agent/src/chatState.ts`)

Each chat's Durable Object holds `gstate`: `idle`, `gathering`, `drafting`,
`sending`, a version bumped by every message that waits on Tex, when the burst
began, and how often it waited and was redrafted. Every transition logs
`chat_state` (from, to, cause); one the table does not allow is refused and
logged `chat_state_refused`, and the caller takes the safe road.

Guards that keep a model from looping:

- **Waits:** at most 2 per burst, never past 8 s after the burst's first
  message (`BURST_DEADLINE_MS`), and only on a real burst (`burstStillTyped`).
  A held burst is decided again when the wait ends, or at once when a new
  message joins it.
- **Redrafts:** at most 3 per burst (a restart, or a draft the recheck held).
  Past that a restart is folded into the running turn, and a draft is sent as
  written.
- **Decide slow or down:** after 3 s (`GROUP_DECIDE_MS`) the burst is answered
  without it. 1 s was asked for; production logged decides of 0.7 to 2.6 s,
  so 1 s would have sent a third of them to the fallback.
- **Addressed messages** never wait and are always answered (code's floor);
  a message for another assistant gets no reply and no reaction.

## What sits beside the phases, never blocked by them

Checked against the code on 2026-11-01 so no state was dropped: the code fast
path (commands, menu replies, the style question) answers in every phase,
including while decide holds a burst (`groupBeside.ts`); a held ask waiting
for the asker's yes and their 👍 (`gask`, `thumbs.ts`); a muted, unbound or
SMS chat (the control plane's status in `answerGroup`); the newcomer hold (a
reply held when someone joined mid-turn); a turn whose workflow cannot start
(`groupTurnRun.ts` `stuck`); routines, check-ins and job reports (one model
turn at a time, through the same turn runner); duplicate webhooks (`gseen`);
pictures mid-turn (taken into the running turn, `steer.ts`); a restart's
cancelled turn (its burst and redraft count go on into the next turn). Each
ends the phase it ran in with `done`, `cancelled` or `failed`. Model and API
failures keep the Workflow's step retries with backoff, then the stuck line
once (`group-turn-workflow.md`).

## Not yet

- One-on-one chats share the module but not the wiring: a 1:1 `wait` is still
  an answer (`inboxTurn.ts`). Per the research, a 1:1 hold should be short
  and only when a cut-off message backs it up.
- Edits and unsends are not events yet (Sendblue sends none; Whapi's are not
  parsed).

## What a simplification would cost

Dropping a guard brings back a loop: a model that keeps saying wait holds the
chat ("answers after MAX_CHAT_WAITS waits", "the burst is answered by its
deadline" in `groupDecideEmojiWait.test.ts`), or keeps restarting ("past
MAX_REDRAFTS a restart is folded" in `groupChatState.test.ts`). Every phase and
event pair is pinned in `chatState.test.ts`.
