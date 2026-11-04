# What was said stays in the record, and Tex does the read instead of offering it (2026-11-04)

On the morning of 2026-11-04 Dev2 texted Tex about a CASA security review for
eighteen minutes, and it went wrong in ways that were mostly the harness, not
the model:

- Tex asked "Want me to check?", "Want me to read that thread?" and "Want me
  to search it for their last message?" about reads it could have done, and
  offered to draft an email instead of drafting it. Its thinking quoted the
  12 s slow-turn nudge, which ended "otherwise answer now".
- Dev2 asked it to ask the advisor. It never did.
- Dev2 sent a voice message asking for an email to Joe. One turn later Tex
  saw only "@seyi: (a file)", answered an older question, and was told
  "that's literally what I asked for".
- A message Dev2's ChatGPT agent asked Tex to pass on was shown to a later
  turn as Tex's own words, so Tex disowned it.

Dev2 asked for root-cause fixes that hold for everyone, not patches. The
diagnosis is in `@supa projects/tex/handoff/2026-11-04-casa-chat-diagnosis.md`.

## A voice message's words go on the person's own line

The texting Worker logs a voice message the moment it arrives, as a `file`
from the person with no words, because nobody has heard it yet. The gateway
hears it in the turn (`attachments.js` `hearVoiceMessages`). Until now the
words were kept only beside Tex's answer (the reply entry's `attached`), which
no turn's history reads.

Now, once the words are heard, the gateway writes the person's event again
with them (`agent/heardWords.js`): the same event id (`eid`), `heard: "voice"`,
and its text is the words. The ledger is append-only, so this is a newer entry
for the same event. Every reader shows an event by its newest entry, once,
where it first came:

- `ledgerHistory.js` `dayFromLedger` and `earlierFromLedger`;
- `ledgerConversation.js`;
- `texStore/pageViews.js`;
- the app's History view.

The warm copy carries the restated event to the next turn (`warmCopy.js`
`restate`). So the chat reads "@them: (a voice message) <words>" in the one
record, as theirs.

`heard` passes the event check only on a person's `file`. A turn that heard
more voice messages than its covered files can be paired with is left as it
was and counted (`tex_heard_unpaired`); nothing is guessed.

**What a simplification would cost:** reading `attached` back into the
question instead would leave the history file, the History view and every
other reader saying "(a file)". It would also keep the words on Tex's line
rather than on theirs.

## A text Tex sent on its own keeps why it went out

A check-in, a routine's run or a ping another agent asked for is kept with its
reason (`about`). The readers that place those texts in a turn's chat used to
drop the reason. Now `sentOnItsOwn.js` turns it into the event's own fields:

- A ping another of their agents asked for is said by that agent and passed
  on by Tex. It is drawn as "Their other agent, passed on by you", the way a
  group member's text is theirs.
- Anything else stays "You", with a line under it saying why it went out.

Tainted words are still held back. Only the speaker is kept.

## Do the read, never offer it; ask the advisor when they say so

- **The slow-turn nudge** (`background.js` `SLOW_TURN_NOTE`) no longer says
  "answer now". Past two rounds or 12 s, a turn hands the rest to a job if
  more than a few steps are left. Otherwise it keeps going, and it never
  stops early to offer a read.
- **The job-first rule** no longer sends the advisor behind a job. A question
  that a few reads answer is not a task.
- **The take-don't-offer prompt line** (`chatVoice.js`) now names reads,
  searches and drafts.
- **The checks.** The front door runs no reply checks, so the line alone did
  not hold. `doItChecks.js` adds two checks to every texted turn, the front
  door's included. Each is a regex and a flag, and each goes back at most
  once:
  - An answer offering a read, search, check or draft is sent back to do it.
    Sending, booking and paying still wait for a yes.
  - A question that names the advisor, in a turn that has one and has not
    asked it, is sent back to ask it. The gateway decides this from their
    words, not the model.

**The test that fails if this is reversed:** `apps/mcp/test/morningChat.test.mjs`
covers each failure above as a golden case. `apps/mobile/__tests__/texHistoryLines.test.ts`
covers the History view drawing a heard voice message once.
